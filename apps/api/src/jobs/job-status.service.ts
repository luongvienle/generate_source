import { Inject, Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { JobStatus, JobType } from '@knowledge-explorer/shared';
import { dryRunResultKey, importJobNames } from '@knowledge-explorer/shared';
import { PrismaService } from '../prisma/prisma.service';
import { ImportQueue } from './import.queue';
import { IMAGE_JOB_ID_PREFIX, ImageQueue } from './image.queue';
import { NARRATION_JOB_ID_PREFIX, NarrationQueue } from './narration.queue';

/**
 * One shape for every kind of job, so the SSE endpoints do not care which they
 * are watching.
 *
 * A commit has a generation_jobs row and that row is authoritative — it is the
 * durable record, and between retries it reads `running` while BullMQ reports
 * `delayed`, which is the more useful answer for someone watching a progress
 * bar. A dry run has no row at all (FR-IMP-02), so its state comes from BullMQ
 * and its result from the Redis key the processor wrote.
 */
export interface JobSnapshot {
  readonly jobId: string;
  readonly jobType: JobType | 'dry_run';
  readonly jobStatus: JobStatus | 'unknown';
  readonly attemptCount: number;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly errorMessage: string | null;
  readonly result: unknown;
  /**
   * Added in P3 so the stream guard can apply R-02 without a second lookup.
   * Additive: apps/admin-web mirrors this interface by hand and reads a subset,
   * so it needs no change.
   */
  readonly targetEntityId: string | null;
  /**
   * Interior progress, for a job that has some. Added in P4 because a narration
   * run is several provider calls and a lesson-length spinner says nothing;
   * `{ done, total }` counts VALIDATED chunks, so a retry never moves it
   * backwards. Read from BullMQ, since the generation_jobs row records durable
   * state rather than in-flight detail.
   *
   * Additive, like targetEntityId in P3: apps/admin-web mirrors this interface by
   * hand and reads a subset, so nothing there breaks by ignoring it.
   */
  readonly progress: { readonly done: number; readonly total: number } | null;
}

export const isTerminal = (snapshot: JobSnapshot): boolean =>
  snapshot.jobStatus === 'succeeded' ||
  snapshot.jobStatus === 'failed' ||
  snapshot.jobStatus === 'unknown';

/**
 * Which queue an id belongs to. A discriminant rather than P3's `isImport`
 * boolean: a third queue made the boolean a lie, and P5's audio queue is the
 * fourth. Widening happens here, in a CONSUMER — no P1 or P3 producer is touched.
 */
type QueueKind = 'import' | 'image' | 'narration';

const fallbackJobTypes: Record<QueueKind, JobType> = {
  import: 'import_course_outline',
  image: 'generate_image',
  narration: 'generate_narration_script',
};

/** BullMQ's progress is `unknown`; only the shape P4 writes is understood. */
function readProgress(value: unknown): { done: number; total: number } | null {
  if (!value || typeof value !== 'object') return null;
  const shape = value as { done?: unknown; total?: unknown };
  return typeof shape.done === 'number' && typeof shape.total === 'number'
    ? { done: shape.done, total: shape.total }
    : null;
}

/** BullMQ's vocabulary is not §8.1's; this is the only place the two meet. */
function fromBullState(state: string | undefined): JobStatus | 'unknown' {
  switch (state) {
    case 'waiting':
    case 'waiting-children':
    case 'delayed':
    case 'prioritized':
      return 'queued';
    case 'active':
      return 'running';
    case 'completed':
      return 'succeeded';
    case 'failed':
      return 'failed';
    default:
      return 'unknown';
  }
}

@Injectable()
export class JobStatusService {
  constructor(
    @Inject(ImportQueue) private readonly importQueue: ImportQueue,
    @Inject(ImageQueue) private readonly imageQueue: ImageQueue,
    @Inject(NarrationQueue) private readonly narrationQueue: NarrationQueue,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  /**
   * Resolves a qualified or unqualified job id to its job and its queue.
   *
   * Unprefixed ids belong to the import queue, which is the format P1 minted
   * and its screens still hold. Anything prefixed `image:` is looked up in the
   * image queue — see ImageQueue.enqueueGenerate for why ids are qualified.
   */
  private async locate(jobId: string): Promise<{ job: Job; queue: QueueKind } | undefined> {
    for (const [prefix, queue, kind] of [
      [IMAGE_JOB_ID_PREFIX, this.imageQueue.queue, 'image'],
      [NARRATION_JOB_ID_PREFIX, this.narrationQueue.queue, 'narration'],
    ] as const) {
      if (jobId.startsWith(prefix)) {
        const job = await queue.getJob(jobId.slice(prefix.length));
        return job ? { job, queue: kind } : undefined;
      }
    }

    const job = await this.importQueue.queue.getJob(jobId);
    return job ? { job, queue: 'import' } : undefined;
  }

  async snapshot(jobId: string): Promise<JobSnapshot | undefined> {
    const located = await this.locate(jobId);
    if (!located) return undefined;

    const { job, queue } = located;
    const bullStatus = fromBullState(await job.getState());
    const progress = readProgress(job.progress);

    if (queue === 'import' && job.name === importJobNames.dryRun) {
      const cached = await this.importQueue.readKey(dryRunResultKey(job.id as string));
      return {
        jobId,
        jobType: 'dry_run',
        jobStatus: bullStatus,
        attemptCount: job.attemptsMade,
        startedAt: job.processedOn ? new Date(job.processedOn).toISOString() : null,
        finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
        errorMessage: job.failedReason ?? null,
        result: cached === null ? null : (JSON.parse(cached) as unknown),
        targetEntityId: null,
        progress,
      };
    }

    const rowId = (job.data as { generationJobId?: string } | undefined)?.generationJobId;
    const row = rowId
      ? await this.prisma.client.generationJob.findUnique({ where: { id: rowId } })
      : null;

    return {
      jobId,
      jobType: (row?.jobType as JobType | undefined) ?? fallbackJobTypes[queue],
      jobStatus: (row?.jobStatus as JobStatus | undefined) ?? bullStatus,
      attemptCount: row?.attemptCount ?? job.attemptsMade,
      startedAt: row?.startedAt?.toISOString() ?? null,
      finishedAt: row?.finishedAt?.toISOString() ?? null,
      errorMessage: row?.errorMessage ?? job.failedReason ?? null,
      result: (job.returnvalue as unknown) ?? null,
      targetEntityId: row?.targetEntityId ?? null,
      progress,
    };
  }
}
