import { Logger } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { IMPORT_QUEUE_NAME, parseRedisUrl, type ImportJobName } from '@knowledge-explorer/shared';

/** One handler per BullMQ job name on the import queue. */
export type ImportJobHandlers = Partial<
  Record<ImportJobName, (job: Job) => Promise<unknown>>
>;

/**
 * Builds the consumer side of the curriculum import queue.
 *
 * Handlers are injected rather than imported so the queue plumbing — connection,
 * dispatch, concurrency, shutdown — is testable on its own, and so the dry-run
 * and commit processors stay independent of it.
 *
 * NFR-03 bounds concurrency here; the retry policy itself is a queue default set
 * by the producer, since a job carries its options from the moment it is added.
 */
export const IMPORT_CONCURRENCY = 2;

export function createImportWorker(
  url: string,
  handlers: ImportJobHandlers,
  queueName: string = process.env['IMPORT_QUEUE_NAME'] ?? IMPORT_QUEUE_NAME,
): Worker {
  const logger = new Logger('ImportWorker');

  const worker = new Worker(
    queueName,
    async (job: Job) => {
      const handler = handlers[job.name as ImportJobName];
      if (!handler) throw new Error(`No handler registered for job name "${job.name}"`);
      return handler(job);
    },
    { connection: parseRedisUrl(url), concurrency: IMPORT_CONCURRENCY },
  );

  // NFR-07: structured logging on every job. targetEntityId is filled in by the
  // handlers, which are the only code that knows what a job targets.
  worker.on('failed', (job, error) => {
    logger.error(
      JSON.stringify({
        jobType: job?.name,
        jobId: job?.id,
        attemptCount: job?.attemptsMade,
        message: error.message,
      }),
    );
  });

  return worker;
}
