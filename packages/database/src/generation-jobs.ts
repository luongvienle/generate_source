import type { PrismaClient } from './client';
import type { JobStatus, JobType } from '@knowledge-explorer/shared';

/**
 * The generation_jobs state machine, in one place.
 *
 * specs/p1-curriculum/plan.md put this in apps/api, but the API only ever
 * creates a row: every later transition happens in apps/worker, which is a
 * separate deployable. Duplicating a state machine across two processes is how
 * it drifts, so it lives here — plain data access over the Prisma client, which
 * is what §11 assigns this package — and both apps call it.
 *
 * Transitions are exactly queued → running → succeeded | failed and no other.
 * A retry does NOT go back through failed: a non-final attempt stays `running`
 * with attempt_count bumped and the last error recorded, so a job that
 * exhausts NFR-03's three attempts lands on `failed` with attempt_count = 3
 * without the row ever having contradicted the declared machine.
 */

/** Works for both `prisma.generationJob` and a `$transaction` client's delegate. */
export type GenerationJobDelegate = PrismaClient['generationJob'];

export interface JobLogger {
  log(message: string): void;
  error(message: string): void;
}

/** NFR-07: structured logging on every job, with jobType, targetEntityId, attemptCount. */
function emit(
  logger: JobLogger | undefined,
  level: 'log' | 'error',
  fields: Record<string, unknown>,
): void {
  logger?.[level](JSON.stringify(fields));
}

export async function createQueuedJob(
  jobs: GenerationJobDelegate,
  input: { jobType: JobType; targetEntityId: string },
  logger?: JobLogger,
): Promise<{ id: string }> {
  const row = await jobs.create({
    data: { jobType: input.jobType, targetEntityId: input.targetEntityId, jobStatus: 'queued' },
    select: { id: true },
  });

  emit(logger, 'log', {
    jobType: input.jobType,
    targetEntityId: input.targetEntityId,
    jobId: row.id,
    attemptCount: 0,
    jobStatus: 'queued' satisfies JobStatus,
  });
  return row;
}

export async function markJobRunning(
  jobs: GenerationJobDelegate,
  jobId: string,
  attemptCount: number,
  logger?: JobLogger,
): Promise<void> {
  const row = await jobs.update({
    where: { id: jobId },
    data: { jobStatus: 'running', attemptCount, startedAt: new Date() },
    select: { jobType: true, targetEntityId: true },
  });

  emit(logger, 'log', { ...row, jobId, attemptCount, jobStatus: 'running' satisfies JobStatus });
}

export async function markJobSucceeded(
  jobs: GenerationJobDelegate,
  jobId: string,
  logger?: JobLogger,
): Promise<void> {
  const row = await jobs.update({
    where: { id: jobId },
    data: { jobStatus: 'succeeded', finishedAt: new Date(), errorMessage: null },
    select: { jobType: true, targetEntityId: true, attemptCount: true },
  });

  emit(logger, 'log', { ...row, jobId, jobStatus: 'succeeded' satisfies JobStatus });
}

/**
 * Records one failed attempt. Only the final attempt moves the row to `failed`;
 * earlier ones leave it `running` so the state machine is never violated by a
 * retry that is still going to happen.
 */
export async function markJobAttemptFailed(
  jobs: GenerationJobDelegate,
  jobId: string,
  input: { attemptCount: number; errorMessage: string; isFinalAttempt: boolean },
  logger?: JobLogger,
): Promise<void> {
  const jobStatus: JobStatus = input.isFinalAttempt ? 'failed' : 'running';
  const row = await jobs.update({
    where: { id: jobId },
    data: {
      jobStatus,
      attemptCount: input.attemptCount,
      errorMessage: input.errorMessage,
      ...(input.isFinalAttempt ? { finishedAt: new Date() } : {}),
    },
    select: { jobType: true, targetEntityId: true },
  });

  emit(logger, 'error', {
    ...row,
    jobId,
    attemptCount: input.attemptCount,
    jobStatus,
    message: input.errorMessage,
  });
}
