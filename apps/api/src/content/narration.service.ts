import {
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  narrationStaleness,
  readScriptSegments,
  scriptChecksum,
  segmentChecksum,
  type Block,
  type IncompleteFigure,
  type NarrationSegment,
  type NarrationStaleness,
} from '@knowledge-explorer/content';
import {
  NARRATION_CHUNK_BLOCK_COUNT,
  NARRATION_CHUNK_MAX_TRIES,
  NARRATION_RUN_MAX_CALLS,
  errorCodes,
  type GenerateNarrationScriptJobData,
  type ScriptStatus,
} from '@knowledge-explorer/shared';
import { worstCaseCallCount } from '@knowledge-explorer/ai';
import { createQueuedJob, markJobAttemptFailed } from '@knowledge-explorer/database';
import { PrismaService } from '../prisma/prisma.service';
import { NARRATION_JOB_ID_PREFIX, NarrationQueue } from '../jobs/narration.queue';
import { ImagesService } from './images.service';
import { readBlockList, resolveEditability, type Editor } from './lesson-content.service';

/**
 * §5.5 narration scripts: generation, review and §6.5 staleness.
 *
 * Two rules shape almost everything here:
 *
 * - **`script_status` is never STORED as `stale`.** §8.1 lists `stale` among the
 *   allowed values and this phase declines to write it, because §6.5 says
 *   staleness is computed on read and never written by a job. The stored value is
 *   `pending`, `generating`, `ready` or `failed`; `stale` is derived below.
 * - **A failed run changes nothing but the status.** The segments and checksums
 *   on the row describe the last SUCCESSFUL run, so a regeneration that fails
 *   never replaces an admin's reviewed script with a half-written one.
 */

/** The computed status. `stale` exists here and never in the database. */
export type ComputedScriptStatus = ScriptStatus | null;

export interface NarrationRowView {
  readonly blockId: string;
  readonly blockType: string;
  readonly text: string;
  readonly figureNumber: number | null;
  readonly tableNumber: number | null;
  readonly narrationText: string | null;
  readonly isEdited: boolean;
  /** `fresh`, `changed` (block moved under it) or `missing` (no segment yet). */
  readonly freshness: 'fresh' | 'changed' | 'missing';
}

export interface NarrationScriptView {
  readonly lessonId: string;
  readonly status: ComputedScriptStatus;
  readonly contentChecksum: string | null;
  readonly sourceContentChecksum: string | null;
  readonly scriptChecksum: string | null;
  readonly reviewedByUserId: string | null;
  readonly reviewedAt: Date | null;
  readonly generatorModelName: string | null;
  readonly generatorPromptVersion: string | null;
  readonly totalEstimatedSeconds: number | null;
  readonly errorMessage: string | null;
  readonly rows: readonly NarrationRowView[];
  readonly orphanedSegments: readonly { blockId: string; narrationText: string }[];
  readonly canEdit: boolean;
  readonly readOnlyReason: string | null;
}

export interface StalenessView {
  readonly lessonId: string;
  readonly contentChecksum: string | null;
  readonly script:
    | (NarrationStaleness & {
        readonly status: ComputedScriptStatus;
        readonly sourceContentChecksum: string;
        readonly scriptChecksum: string;
      })
    | null;
  // NOTE: there is deliberately no `audio` key until P5 adds one. A key that is
  // always null teaches every client to skip it, and leaves P5 unable to tell
  // "no audio yet" from "not implemented".
}

interface LessonRow {
  id: string;
  title: string;
  learningObjective: string | null;
  assignedAdminId: string | null;
  chapter: { course: { id: string; languageCode: string; publicationStatus: string } };
}

interface ScriptRow {
  scriptSegments: unknown;
  scriptChecksum: string;
  sourceContentChecksum: string;
  scriptStatus: string;
  generatorModelName: string | null;
  generatorPromptVersion: string | null;
  reviewedByUserId: string | null;
  reviewedAt: Date | null;
}

/**
 * §6.5: a script is stale when its source checksum differs from the lesson's
 * current content checksum.
 *
 * `failed` OUTRANKS `stale` — a failed row is not `ready`, and the failure is the
 * more actionable fact. That falls out of only promoting `ready`, rather than
 * being a special case.
 */
export function computeStatus(
  stored: string | null,
  sourceContentChecksum: string | null,
  contentChecksum: string | null,
): ComputedScriptStatus {
  if (stored === null) return null;
  if (stored !== 'ready') return stored as ScriptStatus;
  return sourceContentChecksum === contentChecksum ? 'ready' : 'stale';
}

@Injectable()
export class NarrationService {
  private readonly logger = new Logger(NarrationService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(NarrationQueue) private readonly queue: NarrationQueue,
    @Inject(ImagesService) private readonly images: ImagesService,
  ) {}

  private async loadLesson(lessonId: string): Promise<LessonRow> {
    const lesson = await this.prisma.client.lesson.findFirst({
      where: { id: lessonId, deletedAt: null },
      select: {
        id: true,
        title: true,
        learningObjective: true,
        assignedAdminId: true,
        chapter: {
          select: { course: { select: { id: true, languageCode: true, publicationStatus: true } } },
        },
      },
    });
    if (!lesson) throw new NotFoundException({ errorCode: 'LESSON_NOT_FOUND' });
    return lesson;
  }

  private async loadContent(
    lessonId: string,
  ): Promise<{ blocks: readonly Block[]; contentChecksum: string | null }> {
    const content = await this.prisma.client.lessonContent.findUnique({
      where: { lessonId },
      select: { draftBlockList: true, draftContentChecksum: true },
    });
    return {
      blocks: readBlockList(content?.draftBlockList).blocks,
      contentChecksum: content?.draftContentChecksum ?? null,
    };
  }

  private async loadScript(lessonId: string): Promise<ScriptRow | null> {
    return this.prisma.client.narrationScript.findUnique({
      where: { lessonId },
      select: {
        scriptSegments: true,
        scriptChecksum: true,
        sourceContentChecksum: true,
        scriptStatus: true,
        generatorModelName: true,
        generatorPromptVersion: true,
        reviewedByUserId: true,
        reviewedAt: true,
      },
    });
  }

  /**
   * The review tab's read model.
   *
   * Rows are driven by the BLOCK LIST, which is the order of truth, and carry the
   * block text the SERVER stored — never the editor's local parse, whose ids are
   * display-only (see lib/figure-resolve.ts and P3's drawer defect).
   */
  async read(lessonId: string, editor: Editor): Promise<NarrationScriptView> {
    const lesson = await this.loadLesson(lessonId);
    const { blocks, contentChecksum } = await this.loadContent(lessonId);
    const script = await this.loadScript(lessonId);

    const envelope = readScriptSegments(script?.scriptSegments);
    const byBlockId = new Map(envelope.segments.map((segment) => [segment.blockId, segment]));
    const staleness = narrationStaleness(blocks, envelope.segments);
    const changed = new Set(staleness.changedBlockIds);

    const rows = blocks.map((block): NarrationRowView => {
      const segment = byBlockId.get(block.blockId);
      return {
        blockId: block.blockId,
        blockType: block.blockType,
        text: block.text,
        figureNumber: block.figureNumber ?? null,
        tableNumber: block.tableNumber ?? null,
        narrationText: segment?.narrationText ?? null,
        isEdited: segment?.isEdited ?? false,
        freshness: !segment ? 'missing' : changed.has(block.blockId) ? 'changed' : 'fresh',
      };
    });

    const orphaned = new Set(staleness.orphanedSegmentBlockIds);

    return {
      lessonId,
      status: computeStatus(
        script?.scriptStatus ?? null,
        script?.sourceContentChecksum ?? null,
        contentChecksum,
      ),
      contentChecksum,
      sourceContentChecksum: script?.sourceContentChecksum ?? null,
      scriptChecksum: script?.scriptChecksum ?? null,
      reviewedByUserId: script?.reviewedByUserId ?? null,
      reviewedAt: script?.reviewedAt ?? null,
      generatorModelName: script?.generatorModelName ?? null,
      generatorPromptVersion: script?.generatorPromptVersion ?? null,
      totalEstimatedSeconds: envelope.totalEstimatedSeconds,
      errorMessage: await this.lastFailureMessage(lessonId, script?.scriptStatus ?? null),
      rows,
      orphanedSegments: envelope.segments
        .filter((segment) => orphaned.has(segment.blockId))
        .map((segment) => ({ blockId: segment.blockId, narrationText: segment.narrationText })),
      ...resolveEditability(lesson, editor),
    };
  }

  /** Why the last run failed, for the tab. Only looked up when the row says failed. */
  private async lastFailureMessage(lessonId: string, storedStatus: string | null): Promise<string | null> {
    if (storedStatus !== 'failed') return null;
    const job = await this.prisma.client.generationJob.findFirst({
      where: { jobType: 'generate_narration_script', targetEntityId: lessonId },
      orderBy: { createdAt: 'desc' },
      select: { errorMessage: true },
    });
    return job?.errorMessage ?? null;
  }

  /** §6.5, script link only. P5 adds the audio link and its key. */
  async staleness(lessonId: string): Promise<StalenessView> {
    await this.loadLesson(lessonId);
    const { blocks, contentChecksum } = await this.loadContent(lessonId);
    const script = await this.loadScript(lessonId);

    if (!script) return { lessonId, contentChecksum, script: null };

    const envelope = readScriptSegments(script.scriptSegments);
    return {
      lessonId,
      contentChecksum,
      script: {
        ...narrationStaleness(blocks, envelope.segments),
        status: computeStatus(script.scriptStatus, script.sourceContentChecksum, contentChecksum),
        sourceContentChecksum: script.sourceContentChecksum,
        scriptChecksum: script.scriptChecksum,
      },
    };
  }

  /**
   * FR-SCRIPT-01: generate the script as a background job.
   *
   * NFR-04 forbids an HTTP request waiting on a provider, so everything that can
   * be refused is refused HERE, before a job exists and before any money is
   * spent. The worker re-checks the figure precondition, which closes the race
   * between this call and the run.
   */
  async requestGeneration(
    lessonId: string,
    editor: Editor,
  ): Promise<{ jobId: string; generationJobId: string }> {
    await this.loadLesson(lessonId);
    const { blocks } = await this.loadContent(lessonId);

    if (blocks.length === 0) {
      throw new UnprocessableEntityException({ errorCode: errorCodes.SCRIPT_LESSON_EMPTY });
    }

    // Checked before the first call rather than discovered at the last one.
    if (
      worstCaseCallCount(blocks.length, {
        chunkBlockCount: NARRATION_CHUNK_BLOCK_COUNT,
        chunkMaxTries: NARRATION_CHUNK_MAX_TRIES,
        runMaxCalls: NARRATION_RUN_MAX_CALLS,
      }) > NARRATION_RUN_MAX_CALLS
    ) {
      throw new UnprocessableEntityException({
        errorCode: errorCodes.SCRIPT_TOO_MANY_CHUNKS,
        blockCount: blocks.length,
      });
    }

    const incomplete: readonly IncompleteFigure[] = await this.images.incompleteFigures(lessonId);
    if (incomplete.length > 0) {
      throw new UnprocessableEntityException({
        errorCode: errorCodes.SCRIPT_FIGURES_INCOMPLETE,
        figures: incomplete,
      });
    }

    const existing = await this.loadScript(lessonId);
    if (existing?.scriptStatus === 'generating') {
      throw new ConflictException({
        errorCode: errorCodes.SCRIPT_GENERATION_IN_FLIGHT,
        jobId: await this.inFlightJobId(lessonId),
      });
    }

    /**
     * The job row and the in-flight lock share a transaction, so they cannot
     * disagree. The ENQUEUE IS DELIBERATELY OUTSIDE IT: Redis is not enlisted in
     * a Postgres transaction, so an enqueue inside one that then failed would
     * roll back a job BullMQ had already accepted. The compensating catch below
     * is the house pattern from ImagesService.requestGeneration, with one
     * addition — it must also clear `generating`, or a failed enqueue wedges the
     * lesson behind its own lock forever.
     */
    const job = await this.prisma.client.$transaction(async (tx) => {
      const created = await createQueuedJob(
        tx.generationJob,
        { jobType: 'generate_narration_script', targetEntityId: lessonId },
        this.logger,
      );

      await tx.narrationScript.upsert({
        where: { lessonId },
        // §8 makes these NOT NULL and no run has produced them yet. Empty string
        // is the unwritten state, following P3's caption_text precedent; it only
        // ever coexists with pending, generating or failed, never with ready.
        create: {
          lessonId,
          scriptSegments: { segments: [], totalEstimatedSeconds: null },
          scriptChecksum: '',
          sourceContentChecksum: '',
          scriptStatus: 'generating',
        },
        update: { scriptStatus: 'generating' },
      });

      return created;
    });

    try {
      const jobId = await this.queue.enqueueGenerate({
        generationJobId: job.id,
        lessonId,
        createdByUserId: editor.userId,
      });
      return { jobId, generationJobId: job.id };
    } catch (error) {
      await this.prisma.client.narrationScript.update({
        where: { lessonId },
        data: { scriptStatus: 'failed' },
      });
      await markJobAttemptFailed(this.prisma.client.generationJob, job.id, {
        attemptCount: 0,
        errorMessage: `could not enqueue: ${error instanceof Error ? error.message : String(error)}`,
        isFinalAttempt: true,
      });
      throw new InternalServerErrorException({ errorCode: 'SCRIPT_ENQUEUE_FAILED' });
    }
  }

  /**
   * The in-flight run's QUALIFIED BULLMQ id, so the 409 tells the tab what to
   * attach to.
   *
   * Recovered by searching the queue for the job carrying this lesson, because
   * `generation_jobs` has no column for a BullMQ id and §8 is not being migrated
   * for one. The row id is a UUID and the SSE stream is keyed by the queue's
   * counter, so returning the row id here would hand the tab an id that streams
   * nothing.
   *
   * Returns null when the lock is set but no job exists — the orphaned-lock case
   * the spec records as a known gap. The tab shows that as "stuck" rather than
   * silently attaching to nothing.
   */
  private async inFlightJobId(lessonId: string): Promise<string | null> {
    const jobs = await this.queue.queue.getJobs(['waiting', 'active', 'delayed', 'paused']);
    const mine = jobs.find(
      (job) => (job.data as GenerateNarrationScriptJobData | undefined)?.lessonId === lessonId,
    );
    return mine?.id ? `${NARRATION_JOB_ID_PREFIX}${mine.id}` : null;
  }

  /**
   * FR-SCRIPT-04: edit any segment's text, and approve.
   *
   * TWO RULES THAT LOOK INCONSISTENT AND ARE NOT:
   *
   * - **A hand edit KEEPS approval.** FR-SCRIPT-04 defines approval as recording
   *   reviewedByUserId and reviewedAt and says only that an edit stales the
   *   audio; it does not say approval is lost. The person editing holds the same
   *   role as the person who approves, so the edit is itself an act of review.
   *   The residual gap — an admin may add a sentence of new knowledge after
   *   approval and P5 will voice it — is accepted and recorded in the spec.
   * - **A generation run ALWAYS clears approval**, even when every segment was
   *   preserved. A run writes machine text that no human has read, which is
   *   exactly what approval attests against. That happens in the worker, not here.
   */
  async update(
    lessonId: string,
    changes: {
      readonly scriptChecksum: string;
      readonly segments?: readonly { readonly blockId: string; readonly narrationText: string }[];
      readonly approve?: boolean;
    },
    editor: Editor,
  ): Promise<NarrationScriptView> {
    await this.loadLesson(lessonId);
    const script = await this.loadScript(lessonId);
    if (!script) throw new NotFoundException({ errorCode: errorCodes.SCRIPT_NOT_FOUND });

    // A run in flight is about to rewrite these segments; an edit landing now
    // would be clobbered without trace.
    if (script.scriptStatus === 'generating') {
      throw new ConflictException({
        errorCode: errorCodes.SCRIPT_GENERATION_IN_FLIGHT,
        jobId: await this.inFlightJobId(lessonId),
      });
    }

    if (script.scriptChecksum !== changes.scriptChecksum) {
      throw new ConflictException({ errorCode: errorCodes.SCRIPT_CONFLICT });
    }

    const envelope = readScriptSegments(script.scriptSegments);
    const known = new Set(envelope.segments.map((segment) => segment.blockId));

    // Validated BEFORE anything is applied, so a mixed body writes neither
    // segment — the same all-or-nothing rule OwnerFieldGuard applies.
    for (const edit of changes.segments ?? []) {
      if (!known.has(edit.blockId)) {
        throw new UnprocessableEntityException({
          errorCode: errorCodes.SCRIPT_SEGMENT_UNKNOWN,
          blockId: edit.blockId,
        });
      }
    }

    if (changes.approve === true) {
      const { contentChecksum } = await this.loadContent(lessonId);
      const status = computeStatus(script.scriptStatus, script.sourceContentChecksum, contentChecksum);
      // Approving a stale script records a review of text the lesson no longer
      // says. An edit does not move this: it touches neither checksum.
      if (status !== 'ready') {
        throw new UnprocessableEntityException({
          errorCode: errorCodes.SCRIPT_NOT_APPROVABLE,
          status,
        });
      }
    }

    const edits = new Map((changes.segments ?? []).map((edit) => [edit.blockId, edit.narrationText]));
    const segments: NarrationSegment[] = envelope.segments.map((segment) => {
      const narrationText = edits.get(segment.blockId);
      if (narrationText === undefined) return segment;

      return {
        ...segment,
        narrationText,
        segmentChecksum: segmentChecksum(narrationText),
        // sourceBlockChecksum is NOT touched: the segment still derives from that
        // block, a human simply rewrote the words.
        isEdited: true,
      };
    });

    await this.prisma.client.narrationScript.update({
      where: { lessonId },
      data: {
        ...(edits.size > 0
          ? {
              scriptSegments: {
                segments,
                totalEstimatedSeconds: envelope.totalEstimatedSeconds,
              } as unknown as object,
              scriptChecksum: scriptChecksum(segments),
            }
          : {}),
        ...(changes.approve === undefined
          ? {}
          : changes.approve
            ? { reviewedByUserId: editor.userId, reviewedAt: new Date() }
            : { reviewedByUserId: null, reviewedAt: null }),
      },
    });

    return this.read(lessonId, editor);
  }
}
