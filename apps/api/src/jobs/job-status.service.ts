import { Inject, Injectable } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import type { JobStatus, JobType, QueueDefinition, QueueKey } from '@knowledge-explorer/shared';
import {
  dryRunResultKey,
  importJobNames,
  prefixedQueueDefinitions,
  unprefixedQueueDefinition,
} from '@knowledge-explorer/shared';
import { PrismaService } from '../prisma/prisma.service';
import { ImportQueue } from './import.queue';
import { ImageQueue } from './image.queue';
import { NarrationQueue } from './narration.queue';
import { AudioQueue } from './audio.queue';

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
 * Which BullMQ queue instance backs each registry definition.
 *
 * PARTIAL ON PURPOSE. The registry in packages/shared declares every queue the
 * product has; this map holds the ones apps/api actually registered as
 * providers. A definition with no instance here is skipped rather than throwing,
 * which is the right answer for a queue this process does not produce to.
 */
type QueueInstances = Partial<Record<QueueKey, Queue>>;

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
    @Inject(AudioQueue) private readonly audioQueue: AudioQueue,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  private instances(): QueueInstances {
    return {
      import: this.importQueue.queue,
      image: this.imageQueue.queue,
      narration: this.narrationQueue.queue,
      audio: this.audioQueue.queue,
    };
  }

  /**
   * Resolves a qualified or unqualified job id to its job and its definition.
   *
   * ORDER IS LOAD-BEARING. The import queue's prefix is the empty string —
   * P1 minted unprefixed ids and its screens still hold them — and
   * `'anything'.startsWith('')` is always true. Checking the prefixed
   * definitions FIRST and falling through to the unprefixed one last is what
   * keeps `image:7` from resolving to import job `image:7`. The registry splits
   * the two lists so this cannot be got wrong by reordering a literal.
   */
  private async locate(
    jobId: string,
  ): Promise<{ job: Job; definition: QueueDefinition } | undefined> {
    const instances = this.instances();

    for (const definition of prefixedQueueDefinitions) {
      const queue = instances[definition.key];
      if (!queue || !jobId.startsWith(definition.idPrefix)) continue;

      const job = await queue.getJob(jobId.slice(definition.idPrefix.length));
      return job ? { job, definition } : undefined;
    }

    const fallback = instances[unprefixedQueueDefinition.key];
    if (!fallback) return undefined;

    const job = await fallback.getJob(jobId);
    return job ? { job, definition: unprefixedQueueDefinition } : undefined;
  }

  async snapshot(jobId: string): Promise<JobSnapshot | undefined> {
    const located = await this.locate(jobId);
    if (!located) return undefined;

    const { job, definition } = located;
    const bullStatus = fromBullState(await job.getState());
    const progress = readProgress(job.progress);

    if (definition.key === 'import' && job.name === importJobNames.dryRun) {
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
      jobType: (row?.jobType as JobType | undefined) ?? definition.fallbackJobType,
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
