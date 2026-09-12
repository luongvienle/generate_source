import { Inject, Injectable } from '@nestjs/common';
import type { JobStatus, JobType } from '@knowledge-explorer/shared';
import { dryRunResultKey, importJobNames } from '@knowledge-explorer/shared';
import { PrismaService } from '../prisma/prisma.service';
import { ImportQueue } from './import.queue';

/**
 * One shape for both kinds of job, so the SSE endpoint does not care which it is
 * watching.
 *
 * A commit has a generation_jobs row and that row is authoritative — it is the
 * durable record, and between retries it reads `running` while BullMQ reports
 * `delayed`, which is the more useful answer for someone watching a progress bar.
 * A dry run has no row at all (FR-IMP-02), so its state comes from BullMQ and its
 * result from the Redis key the processor wrote.
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
    @Inject(ImportQueue) private readonly queue: ImportQueue,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async snapshot(jobId: string): Promise<JobSnapshot | undefined> {
    const job = await this.queue.queue.getJob(jobId);
    if (!job) return undefined;

    const isDryRun = job.name === importJobNames.dryRun;
    const bullStatus = fromBullState(await job.getState());

    if (isDryRun) {
      const cached = await this.queue.readKey(dryRunResultKey(jobId));
      return {
        jobId,
        jobType: 'dry_run',
        jobStatus: bullStatus,
        attemptCount: job.attemptsMade,
        startedAt: job.processedOn ? new Date(job.processedOn).toISOString() : null,
        finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
        errorMessage: job.failedReason ?? null,
        result: cached === null ? null : (JSON.parse(cached) as unknown),
      };
    }

    const rowId = (job.data as { generationJobId?: string } | undefined)?.generationJobId;
    const row = rowId
      ? await this.prisma.client.generationJob.findUnique({ where: { id: rowId } })
      : null;

    return {
      jobId,
      jobType: (row?.jobType as JobType | undefined) ?? 'import_course_outline',
      jobStatus: (row?.jobStatus as JobStatus | undefined) ?? bullStatus,
      attemptCount: row?.attemptCount ?? job.attemptsMade,
      startedAt: row?.startedAt?.toISOString() ?? null,
      finishedAt: row?.finishedAt?.toISOString() ?? null,
      errorMessage: row?.errorMessage ?? job.failedReason ?? null,
      result: (job.returnvalue as unknown) ?? null,
    };
  }
}
