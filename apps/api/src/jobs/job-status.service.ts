import { Inject, Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { JobStatus, JobType } from '@knowledge-explorer/shared';
import { dryRunResultKey, importJobNames } from '@knowledge-explorer/shared';
import { PrismaService } from '../prisma/prisma.service';
import { ImportQueue } from './import.queue';
import { IMAGE_JOB_ID_PREFIX, ImageQueue } from './image.queue';

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
}

export const isTerminal = (snapshot: JobSnapshot): boolean =>
  snapshot.jobStatus === 'succeeded' ||
  snapshot.jobStatus === 'failed' ||
  snapshot.jobStatus === 'unknown';

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
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  /**
   * Resolves a qualified or unqualified job id to its job and its queue.
   *
   * Unprefixed ids belong to the import queue, which is the format P1 minted
   * and its screens still hold. Anything prefixed `image:` is looked up in the
   * image queue — see ImageQueue.enqueueGenerate for why ids are qualified.
   */
  private async locate(jobId: string): Promise<{ job: Job; isImport: boolean } | undefined> {
    if (jobId.startsWith(IMAGE_JOB_ID_PREFIX)) {
      const job = await this.imageQueue.queue.getJob(jobId.slice(IMAGE_JOB_ID_PREFIX.length));
      return job ? { job, isImport: false } : undefined;
    }

    const job = await this.importQueue.queue.getJob(jobId);
    return job ? { job, isImport: true } : undefined;
  }

  async snapshot(jobId: string): Promise<JobSnapshot | undefined> {
    const located = await this.locate(jobId);
    if (!located) return undefined;

    const { job, isImport } = located;
    const bullStatus = fromBullState(await job.getState());

    if (isImport && job.name === importJobNames.dryRun) {
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
      };
    }

    const rowId = (job.data as { generationJobId?: string } | undefined)?.generationJobId;
    const row = rowId
      ? await this.prisma.client.generationJob.findUnique({ where: { id: rowId } })
      : null;

    return {
      jobId,
      jobType:
        (row?.jobType as JobType | undefined) ??
        (isImport ? 'import_course_outline' : 'generate_image'),
      jobStatus: (row?.jobStatus as JobStatus | undefined) ?? bullStatus,
      attemptCount: row?.attemptCount ?? job.attemptsMade,
      startedAt: row?.startedAt?.toISOString() ?? null,
      finishedAt: row?.finishedAt?.toISOString() ?? null,
      errorMessage: row?.errorMessage ?? job.failedReason ?? null,
      result: (job.returnvalue as unknown) ?? null,
      targetEntityId: row?.targetEntityId ?? null,
    };
  }
}
