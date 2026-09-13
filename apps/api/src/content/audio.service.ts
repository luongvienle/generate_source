import {
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createQueuedJob, markJobAttemptFailed } from '@knowledge-explorer/database';
import {
  computeAudioStatus,
  readScriptSegments,
  type ComputedAudioStatus,
  type NarrationSegment,
} from '@knowledge-explorer/content';
import {
  AUDIO_RUN_MAX_SEGMENTS,
  errorCodes,
  type GenerateAudioJobData,
} from '@knowledge-explorer/shared';
import {
  DEFAULT_VOICE_PROVIDER,
  OPENAI_TTS_VOICES,
  TEXT_TO_SPEECH_PROVIDER,
  resolveCourseVoice,
  type TextToSpeechProvider,
} from '@knowledge-explorer/ai';
import { OBJECT_STORAGE, type ObjectStorage } from '@knowledge-explorer/storage';
import { PrismaService } from '../prisma/prisma.service';
import { AUDIO_JOB_ID_PREFIX, AudioQueue } from '../jobs/audio.queue';
import { readBlockList, resolveEditability, type Editor } from './lesson-content.service';

/**
 * §5.6 audio: preconditions, the in-flight lock, and the §6.5 script→audio link.
 *
 * Two rules shape this file, both inherited from P4 so that an admin meets one
 * mental model rather than two:
 *
 * - **`audio_status` is never STORED as `stale`.** §8.1 allows the value and this
 *   phase declines to write it, because §6.5 says staleness is computed on read
 *   and never written by a job. The stored value is `pending`, `generating`,
 *   `ready` or `failed`; `stale` is derived below.
 * - **A failed run changes nothing but the status.** The merged URL, the
 *   checksums and every audio_segments row describe the last SUCCESSFUL run, so a
 *   regeneration that fails never replaces working audio with a partial set.
 */

/**
 * The computed status. `stale` exists here and never in the database.
 *
 * Re-exported from packages/content since P6 — see the note on
 * `computeAudioStatus` there. apps/worker needs the same rule for the publish
 * re-check and cannot import apps/api.
 */
export type { ComputedAudioStatus };

export interface AudioRowView {
  readonly blockId: string;
  readonly segmentOrder: number;
  readonly narrationText: string;
  readonly figureNumber: number | null;
  readonly tableNumber: number | null;
  readonly startMillisecond: number | null;
  readonly endMillisecond: number | null;
  /** `fresh`, `stale` (the narration moved under it) or `missing` (never voiced). */
  readonly freshness: 'fresh' | 'stale' | 'missing';
}

export interface AudioView {
  readonly lessonId: string;
  readonly status: ComputedAudioStatus;
  /** Short-lived and presigned. Never `merged_audio_file_url`, which is a key. */
  readonly mergedAudioUrl: string | null;
  readonly totalDurationSeconds: number | null;
  readonly totalCharacterCount: number | null;
  readonly voiceIdentifier: string | null;
  readonly voiceProviderName: string | null;
  /** The voice the course is configured for now, which may differ from the row's. */
  readonly configuredVoiceIdentifier: string;
  readonly errorMessage: string | null;
  readonly rows: readonly AudioRowView[];
  readonly orphanedSegmentBlockIds: readonly string[];
  /** Why generation is refused right now, as an errorCode, or null if it is not. */
  readonly blockedReason: string | null;
  readonly canEdit: boolean;
  readonly readOnlyReason: string | null;
}

export interface AudioStalenessView {
  readonly status: ComputedAudioStatus;
  readonly sourceScriptChecksum: string;
  readonly scriptChecksum: string | null;
  readonly voiceIdentifier: string;
  readonly configuredVoiceIdentifier: string;
  readonly voiceChanged: boolean;
  readonly staleSegmentBlockIds: readonly string[];
  readonly orphanedSegmentBlockIds: readonly string[];
}

@Injectable()
export class AudioService {
  private readonly logger = new Logger(AudioService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AudioQueue) private readonly queue: AudioQueue,
    @Inject(TEXT_TO_SPEECH_PROVIDER) private readonly provider: TextToSpeechProvider,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  /**
   * FR-AUDIO-03's "one configured voice per course".
   *
   * §8 gives `courses` no voice column, so P5 added two by migration. NULL means
   * "use the install default": a fresh course narrates without anyone configuring
   * anything, and an install with one voice never touches the columns.
   */
  resolveVoice(course: { voiceIdentifier: string | null; voiceProviderName: string | null }): {
    voiceIdentifier: string;
    voiceProviderName: string;
  } {
    // In packages/ai since P6: the publish worker needs the identical
    // resolution for its §6.5 re-check and cannot import this app.
    return resolveCourseVoice(course);
  }

  /**
   * FR-AUDIO-03: set a course's voice. Owner-only at the controller.
   *
   * An unrecognised voice is refused HERE rather than discovered on the first
   * paid call of the first lesson someone tries to synthesize.
   */
  async setVoice(
    courseId: string,
    body: { voiceIdentifier: string | null; voiceProviderName?: string | null },
  ): Promise<{ voiceIdentifier: string; voiceProviderName: string }> {
    const course = await this.prisma.client.course.findUnique({
      where: { id: courseId },
      select: { id: true },
    });
    if (!course) throw new NotFoundException({ errorCode: 'COURSE_NOT_FOUND' });

    if (body.voiceIdentifier !== null && !isKnownVoice(body.voiceIdentifier)) {
      throw new UnprocessableEntityException({
        errorCode: errorCodes.AUDIO_VOICE_NOT_CONFIGURED,
        voiceIdentifier: body.voiceIdentifier,
        known: OPENAI_TTS_VOICES,
      });
    }

    const updated = await this.prisma.client.course.update({
      where: { id: courseId },
      data: {
        voiceIdentifier: body.voiceIdentifier,
        voiceProviderName: body.voiceIdentifier === null ? null : (body.voiceProviderName ?? DEFAULT_VOICE_PROVIDER),
      },
      select: { voiceIdentifier: true, voiceProviderName: true },
    });

    return this.resolveVoice(updated);
  }

  /**
   * FR-AUDIO-01: enqueue a synthesis run, after every refusal the spec names.
   *
   * ORDER MATTERS AND IS THE POINT. Every check below happens before a job
   * exists, so a lesson that cannot produce publishable audio never costs a
   * provider call. §5.5 makes admin approval the enforcement point for
   * FR-SCRIPT-02, and this is where it is enforced.
   */
  async requestGeneration(
    lessonId: string,
    editor: Editor,
  ): Promise<{ jobId: string; generationJobId: string }> {
    const lesson = await this.loadLesson(lessonId);
    if (!lesson) throw new NotFoundException({ errorCode: 'LESSON_NOT_FOUND' });

    const script = await this.prisma.client.narrationScript.findUnique({
      where: { lessonId },
      select: {
        scriptSegments: true,
        scriptChecksum: true,
        sourceContentChecksum: true,
        scriptStatus: true,
        reviewedAt: true,
      },
    });
    if (!script) throw new NotFoundException({ errorCode: errorCodes.AUDIO_SCRIPT_NOT_FOUND });

    /**
     * §5.5: approval is required before audio generation.
     *
     * An approved-then-EDITED script still synthesizes. P4 ruled that a hand edit
     * keeps approval — the editor holds the same role as the approver, so the
     * edit is itself an act of review — and recorded the residual gap. P5 does not
     * re-litigate a shipped decision; the gap stays where P4 put it.
     */
    if (script.reviewedAt === null) {
      throw new UnprocessableEntityException({ errorCode: errorCodes.AUDIO_SCRIPT_NOT_APPROVED });
    }

    const content = await this.prisma.client.lessonContent.findUnique({
      where: { lessonId },
      select: { draftBlockList: true, draftContentChecksum: true },
    });

    // The script's COMPUTED status, by P4's rule: `stale` when a stored `ready`
    // no longer matches the lesson's current content checksum.
    const computedScriptStatus =
      script.scriptStatus === 'ready' &&
      script.sourceContentChecksum !== (content?.draftContentChecksum ?? '')
        ? 'stale'
        : script.scriptStatus;

    if (computedScriptStatus !== 'ready') {
      throw new UnprocessableEntityException({
        errorCode: errorCodes.AUDIO_SCRIPT_STALE,
        scriptStatus: computedScriptStatus,
      });
    }

    const segments = readScriptSegments(script.scriptSegments).segments;
    if (segments.length === 0) {
      throw new UnprocessableEntityException({ errorCode: errorCodes.AUDIO_SCRIPT_NOT_FOUND });
    }

    if (segments.length > AUDIO_RUN_MAX_SEGMENTS) {
      throw new UnprocessableEntityException({
        errorCode: errorCodes.AUDIO_TOO_MANY_SEGMENTS,
        segmentCount: segments.length,
        maximum: AUDIO_RUN_MAX_SEGMENTS,
      });
    }

    // Checked before the first call rather than discovered at the worst one.
    const tooLong = segments.find(
      (segment) => segment.narrationText.length > this.provider.maxInputCharacters,
    );
    if (tooLong) {
      throw new UnprocessableEntityException({
        errorCode: errorCodes.AUDIO_SEGMENT_TOO_LONG,
        blockId: tooLong.blockId,
        characterCount: tooLong.narrationText.length,
        maximum: this.provider.maxInputCharacters,
      });
    }

    const existing = await this.prisma.client.lessonAudio.findFirst({
      where: { lessonId },
      select: { audioStatus: true },
    });
    if (existing?.audioStatus === 'generating') {
      throw new ConflictException({
        errorCode: errorCodes.AUDIO_GENERATION_IN_FLIGHT,
        jobId: await this.inFlightJobId(lessonId),
      });
    }

    const voice = this.resolveVoice(lesson.chapter.course);

    /**
     * The job row and the in-flight lock share a transaction, so they cannot
     * disagree. THE ENQUEUE IS DELIBERATELY OUTSIDE IT: Redis is not enlisted in
     * a Postgres transaction, so an enqueue inside one that then failed would
     * roll back a job BullMQ had already accepted. The compensating catch below
     * is the house pattern, and must also clear `generating` or a failed enqueue
     * wedges the lesson behind its own lock.
     */
    const job = await this.prisma.client.$transaction(async (tx) => {
      const created = await createQueuedJob(
        tx.generationJob,
        { jobType: 'generate_audio', targetEntityId: lessonId },
        this.logger,
      );

      const row = await tx.lessonAudio.findFirst({ where: { lessonId }, select: { id: true } });
      if (row) {
        // A regeneration takes the lock and changes NOTHING else: the previous
        // merged URL keeps serving for the whole run, which is what makes the
        // all-or-nothing guarantee visible to a listener.
        await tx.lessonAudio.update({ where: { id: row.id }, data: { audioStatus: 'generating' } });
      } else {
        await tx.lessonAudio.create({
          data: {
            lessonId,
            voiceIdentifier: voice.voiceIdentifier,
            voiceProviderName: voice.voiceProviderName,
            // §8 makes these NOT NULL and no run has produced them yet. Empty
            // string is the unwritten state, following P3's caption_text and
            // P4's script_checksum precedent; it only ever coexists with
            // pending, generating or failed, never with ready.
            mergedAudioFileUrl: '',
            sourceScriptChecksum: '',
            audioStatus: 'generating',
          },
        });
      }

      return created;
    });

    try {
      const data: GenerateAudioJobData = {
        generationJobId: job.id,
        lessonId,
        voiceIdentifier: voice.voiceIdentifier,
        voiceProviderName: voice.voiceProviderName,
        createdByUserId: editor.userId,
      };
      const jobId = await this.queue.enqueueGenerate(data);
      return { jobId, generationJobId: job.id };
    } catch (error) {
      await this.prisma.client.lessonAudio.updateMany({
        where: { lessonId },
        data: { audioStatus: 'failed' },
      });
      await markJobAttemptFailed(this.prisma.client.generationJob, job.id, {
        attemptCount: 0,
        errorMessage: `could not enqueue: ${error instanceof Error ? error.message : String(error)}`,
        isFinalAttempt: true,
      });
      throw new InternalServerErrorException({ errorCode: 'AUDIO_ENQUEUE_FAILED' });
    }
  }

  /**
   * The in-flight run's QUALIFIED BullMQ id, so the 409 tells the tab what to
   * attach to. Recovered by searching the queue, because `generation_jobs` has no
   * column for a BullMQ id and §8 is not being migrated for one.
   *
   * Returns null when the lock is set but no job exists — the orphaned-lock case
   * both P4 and P5 record as a known gap.
   */
  private async inFlightJobId(lessonId: string): Promise<string | null> {
    const jobs = await this.queue.queue.getJobs(['waiting', 'active', 'delayed', 'paused']);
    const mine = jobs.find(
      (job) => (job.data as GenerateAudioJobData | undefined)?.lessonId === lessonId,
    );
    return mine?.id ? `${AUDIO_JOB_ID_PREFIX}${mine.id}` : null;
  }

  private async loadLesson(lessonId: string) {
    return this.prisma.client.lesson.findFirst({
      where: { id: lessonId, deletedAt: null },
      select: {
        id: true,
        assignedAdminId: true,
        chapter: {
          select: {
            course: {
              select: {
                id: true,
                publicationStatus: true,
                voiceIdentifier: true,
                voiceProviderName: true,
              },
            },
          },
        },
      },
    });
  }

  /** The audio tab's read model. */
  async read(lessonId: string, editor: Editor): Promise<AudioView> {
    const lesson = await this.loadLesson(lessonId);
    if (!lesson) throw new NotFoundException({ errorCode: 'LESSON_NOT_FOUND' });

    const configured = this.resolveVoice(lesson.chapter.course);
    const editability = resolveEditability(
      { assignedAdminId: lesson.assignedAdminId, chapter: lesson.chapter },
      editor,
    );

    const [script, content, audio] = await Promise.all([
      this.prisma.client.narrationScript.findUnique({
        where: { lessonId },
        select: {
          scriptSegments: true,
          scriptChecksum: true,
          sourceContentChecksum: true,
          scriptStatus: true,
          reviewedAt: true,
        },
      }),
      this.prisma.client.lessonContent.findUnique({
        where: { lessonId },
        select: { draftBlockList: true, draftContentChecksum: true },
      }),
      this.prisma.client.lessonAudio.findFirst({
        where: { lessonId },
        include: { segments: { orderBy: { segmentOrder: 'asc' } } },
      }),
    ]);

    const segments = script ? readScriptSegments(script.scriptSegments).segments : [];
    const blocks = readBlockList(content?.draftBlockList).blocks;
    const numbering = new Map(
      blocks.map((block) => [
        block.blockId,
        { figureNumber: block.figureNumber ?? null, tableNumber: block.tableNumber ?? null },
      ]),
    );

    const byBlockId = new Map((audio?.segments ?? []).map((row) => [row.blockReferenceId, row]));

    const rows = segments.map((segment): AudioRowView => {
      const row = byBlockId.get(segment.blockId);
      const numbers = numbering.get(segment.blockId);
      return {
        blockId: segment.blockId,
        segmentOrder: segment.segmentOrder,
        narrationText: segment.narrationText,
        figureNumber: numbers?.figureNumber ?? null,
        tableNumber: numbers?.tableNumber ?? null,
        startMillisecond: row?.startMillisecond ?? null,
        endMillisecond: row?.endMillisecond ?? null,
        freshness: !row
          ? 'missing'
          : row.sourceSegmentChecksum === segment.segmentChecksum
            ? 'fresh'
            : 'stale',
      };
    });

    const scriptBlockIds = new Set(segments.map((segment) => segment.blockId));

    return {
      lessonId,
      status: audio
        ? computeAudioStatus(audio, script?.scriptChecksum ?? null, configured.voiceIdentifier)
        : null,
      // A key is not a URL, and an unwritten row holds `''`.
      mergedAudioUrl:
        audio && audio.mergedAudioFileUrl !== ''
          ? await this.storage.presignGet(audio.mergedAudioFileUrl)
          : null,
      totalDurationSeconds: audio?.totalDurationSeconds ?? null,
      totalCharacterCount: audio?.totalCharacterCount ?? null,
      voiceIdentifier: audio?.voiceIdentifier ?? null,
      voiceProviderName: audio?.voiceProviderName ?? null,
      configuredVoiceIdentifier: configured.voiceIdentifier,
      errorMessage: await this.lastErrorMessage(lessonId, audio?.audioStatus ?? null),
      rows,
      orphanedSegmentBlockIds: (audio?.segments ?? [])
        .filter((row) => !scriptBlockIds.has(row.blockReferenceId))
        .map((row) => row.blockReferenceId),
      blockedReason: blockedReason(script, content?.draftContentChecksum ?? null, segments),
      canEdit: editability.canEdit,
      readOnlyReason: editability.readOnlyReason,
    };
  }

  /** §6.5's script→audio link, for the staleness endpoint P4 left a hole for. */
  async stalenessFor(lessonId: string): Promise<AudioStalenessView | null> {
    const lesson = await this.loadLesson(lessonId);
    if (!lesson) return null;

    const audio = await this.prisma.client.lessonAudio.findFirst({
      where: { lessonId },
      include: { segments: true },
    });
    if (!audio) return null;

    const script = await this.prisma.client.narrationScript.findUnique({
      where: { lessonId },
      select: { scriptSegments: true, scriptChecksum: true },
    });

    const configured = this.resolveVoice(lesson.chapter.course);
    const segments = script ? readScriptSegments(script.scriptSegments).segments : [];
    const byBlockId = new Map(audio.segments.map((row) => [row.blockReferenceId, row]));
    const scriptBlockIds = new Set(segments.map((segment) => segment.blockId));

    return {
      status: computeAudioStatus(audio, script?.scriptChecksum ?? null, configured.voiceIdentifier),
      sourceScriptChecksum: audio.sourceScriptChecksum,
      scriptChecksum: script?.scriptChecksum ?? null,
      voiceIdentifier: audio.voiceIdentifier,
      configuredVoiceIdentifier: configured.voiceIdentifier,
      voiceChanged: audio.voiceIdentifier !== configured.voiceIdentifier,
      // What a run would pay for.
      staleSegmentBlockIds: segments
        .filter((segment) => {
          const row = byBlockId.get(segment.blockId);
          return !row || row.sourceSegmentChecksum !== segment.segmentChecksum;
        })
        .map((segment) => segment.blockId),
      orphanedSegmentBlockIds: audio.segments
        .filter((row) => !scriptBlockIds.has(row.blockReferenceId))
        .map((row) => row.blockReferenceId),
    };
  }

  /** The reason on the most recent audio job, shown when the row reads `failed`. */
  private async lastErrorMessage(lessonId: string, status: string | null): Promise<string | null> {
    if (status !== 'failed') return null;

    const job = await this.prisma.client.generationJob.findFirst({
      where: { jobType: 'generate_audio', targetEntityId: lessonId },
      orderBy: { createdAt: 'desc' },
      select: { errorMessage: true },
    });
    return job?.errorMessage ?? null;
  }
}

const isKnownVoice = (value: string): boolean =>
  (OPENAI_TTS_VOICES as readonly string[]).includes(value);

/**
 * §6.5's script→audio link, re-exported so this module's callers keep the name
 * they had. The rule and its reasoning moved to packages/content at P6, where
 * the publish checklist and the publish worker can reach it too.
 */
export { computeAudioStatus };

/**
 * Why the tab should disable Generate, as the errorCode the write would give.
 *
 * Display only: requestGeneration refuses independently, so the UI carries no
 * enforcement — it just avoids letting an admin click something that cannot work.
 */
function blockedReason(
  script: { scriptStatus: string; sourceContentChecksum: string; reviewedAt: Date | null } | null,
  contentChecksum: string | null,
  segments: readonly NarrationSegment[],
): string | null {
  if (!script || segments.length === 0) return errorCodes.AUDIO_SCRIPT_NOT_FOUND;
  if (script.reviewedAt === null) return errorCodes.AUDIO_SCRIPT_NOT_APPROVED;

  const computed =
    script.scriptStatus === 'ready' && script.sourceContentChecksum !== (contentChecksum ?? '')
      ? 'stale'
      : script.scriptStatus;

  return computed === 'ready' ? null : errorCodes.AUDIO_SCRIPT_STALE;
}
