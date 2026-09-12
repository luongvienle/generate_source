import { Logger } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { IMAGE_QUEUE_NAME, parseRedisUrl, type ImageJobName } from '@knowledge-explorer/shared';

/** One handler per BullMQ job name on the image queue. */
export type ImageJobHandlers = Partial<Record<ImageJobName, (job: Job) => Promise<unknown>>>;

/**
 * NFR-03 bounds concurrency here.
 *
 * Set low on purpose: every job is a paid provider call against a rate-limited
 * API, so the ceiling protects a budget as much as a CPU. The retry policy
 * itself is a queue default set by the producer, since a job carries its
 * options from the moment it is added.
 */
export const IMAGE_CONCURRENCY = 2;

export function createImageWorker(
  url: string,
  handlers: ImageJobHandlers,
  queueName: string = process.env['IMAGE_QUEUE_NAME'] ?? IMAGE_QUEUE_NAME,
): Worker {
  const logger = new Logger('ImageWorker');

  const worker = new Worker(
    queueName,
    async (job: Job) => {
      const handler = handlers[job.name as ImageJobName];
      if (!handler) throw new Error(`No handler registered for job name "${job.name}"`);
      return handler(job);
    },
    { connection: parseRedisUrl(url), concurrency: IMAGE_CONCURRENCY },
  );

  // NFR-07: structured logging on every job.
  worker.on('failed', (job, error) => {
    logger.error(
      JSON.stringify({
        jobType: job?.name,
        jobId: job?.id,
        attemptCount: job?.attemptsMade,
        targetEntityId: (job?.data as { lessonId?: string } | undefined)?.lessonId,
        message: error.message,
      }),
    );
  });

  return worker;
}
