import { UnrecoverableError, type Job } from 'bullmq';
import {
  markJobAttemptFailed,
  markJobRunning,
  markJobSucceeded,
  type GenerationJobDelegate,
  type JobLogger,
} from '@knowledge-explorer/database';

/** Commit jobs carry the id of the generation_jobs row the API created. */
export interface JobDataWithRow {
  readonly generationJobId?: string;
}

/**
 * Wraps a handler in the generation_jobs state machine.
 *
 * A dry run carries no generationJobId, because FR-IMP-02 forbids it writing to
 * the database at all; the wrapper then runs the handler and records nothing.
 * That is why the row id travels in the job payload rather than being derived
 * from the job itself.
 */
export function withJobLifecycle(
  jobs: GenerationJobDelegate,
  handler: (job: Job) => Promise<unknown>,
  logger?: JobLogger,
): (job: Job) => Promise<unknown> {
  return async (job: Job) => {
    const rowId = (job.data as JobDataWithRow | undefined)?.generationJobId;

    // attemptsMade counts attempts already finished, so the current one is +1.
    const attemptCount = job.attemptsMade + 1;
    const attemptsAllowed = job.opts.attempts ?? 1;

    if (rowId) await markJobRunning(jobs, rowId, attemptCount, logger);

    try {
      const result = await handler(job);
      if (rowId) await markJobSucceeded(jobs, rowId, logger);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      /**
       * BullMQ does not retry an UnrecoverableError, so the row must reach
       * `failed` on THIS attempt or it stays `running` forever and the SSE
       * stream never terminates.
       *
       * P4 needs it: a §6.3 schema violation that survived its retry ladder is
       * not going to be fixed by the same prompt three seconds later, and a
       * precondition that no longer holds is not going to start holding. Neither
       * P1 nor P3 throws one, so their behaviour is unchanged.
       */
      const isFinalAttempt = attemptCount >= attemptsAllowed || error instanceof UnrecoverableError;
      if (rowId) {
        await markJobAttemptFailed(jobs, rowId, { attemptCount, errorMessage: message, isFinalAttempt }, logger);
      }
      throw error;
    }
  };
}
