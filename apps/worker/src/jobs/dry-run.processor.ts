import type { Job } from 'bullmq';
import type Redis from 'ioredis';
import { buildImportPlan, type ImportPayload } from '@knowledge-explorer/content';
import { DRY_RUN_RESULT_TTL_SECONDS, dryRunResultKey } from '@knowledge-explorer/shared';
import { loadExistingTree, type PrismaLike } from './existing-tree';

export interface DryRunJobData {
  readonly payload: ImportPayload;
}

/**
 * FR-IMP-02: preview the import, writing nothing.
 *
 * The only side effect is a Redis key holding the plan for
 * DRY_RUN_RESULT_TTL_SECONDS, so a client that subscribes after the job settles
 * still gets its result. No generation_jobs row is created — see
 * specs/p1-curriculum/spec.md — which is why this processor is NOT wrapped in
 * withJobLifecycle.
 *
 * The plan is also returned, so BullMQ carries it as the job's return value for
 * callers reading through the queue rather than the cache.
 */
export function createDryRunProcessor(prisma: PrismaLike, redis: Redis) {
  return async (job: Job): Promise<unknown> => {
    const { payload } = job.data as DryRunJobData;

    const existing = await loadExistingTree(prisma, payload);
    const plan = buildImportPlan(existing, payload);

    await redis.set(
      dryRunResultKey(job.id!),
      JSON.stringify(plan),
      'EX',
      DRY_RUN_RESULT_TTL_SECONDS,
    );
    return plan;
  };
}
