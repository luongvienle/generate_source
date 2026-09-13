import { Logger } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { PUBLISH_QUEUE_NAME, parseRedisUrl, type PublishJobName } from '@knowledge-explorer/shared';

/** One handler per BullMQ job name on the publish queue. */
export type PublishJobHandlers = Partial<Record<PublishJobName, (job: Job) => Promise<unknown>>>;

/**
 * ONE run at a time, and for a different reason than P5's.
 *
 * A publish run spends nothing, but it rewrites a whole course's published track
 * in one transaction. Two concurrent runs on different courses would be safe;
 * bounding it at one keeps the lock-and-restore reasoning single-threaded and
 * costs nothing, since publishing is an occasional owner action rather than a
 * queue that ever backs up.
 */
export const PUBLISH_CONCURRENCY = 1;

export function createPublishWorker(
  url: string,
  handlers: PublishJobHandlers,
  queueName: string = process.env['PUBLISH_QUEUE_NAME'] ?? PUBLISH_QUEUE_NAME,
): Worker {
  const logger = new Logger('PublishWorker');

  const worker = new Worker(
    queueName,
    async (job: Job) => {
      const handler = handlers[job.name as PublishJobName];
      if (!handler) throw new Error(`No handler registered for job name "${job.name}"`);
      return handler(job);
    },
    { connection: parseRedisUrl(url), concurrency: PUBLISH_CONCURRENCY },
  );

  // NFR-07: structured logging on every job. The target is a COURSE here, not a
  // lesson — the first queue for which that is true.
  worker.on('failed', (job, error) => {
    logger.error(
      JSON.stringify({
        jobType: job?.name,
        jobId: job?.id,
        attemptCount: job?.attemptsMade,
        targetEntityId: (job?.data as { courseId?: string } | undefined)?.courseId,
        message: error.message,
      }),
    );
  });

  return worker;
}
