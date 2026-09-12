import { Logger } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import {
  NARRATION_QUEUE_NAME,
  parseRedisUrl,
  type NarrationJobName,
} from '@knowledge-explorer/shared';

/** One handler per BullMQ job name on the narration queue. */
export type NarrationJobHandlers = Partial<Record<NarrationJobName, (job: Job) => Promise<unknown>>>;

/**
 * NFR-03 bounds concurrency here.
 *
 * Lower than the image queue's, because a narration run is SEVERAL paid calls
 * rather than one: two concurrent runs on 60-block lessons are six in-flight
 * requests against a rate-limited API. The retry policy itself is a queue default
 * set by the producer, since a job carries its options from the moment it is added.
 */
export const NARRATION_CONCURRENCY = 1;

export function createNarrationWorker(
  url: string,
  handlers: NarrationJobHandlers,
  queueName: string = process.env['NARRATION_QUEUE_NAME'] ?? NARRATION_QUEUE_NAME,
): Worker {
  const logger = new Logger('NarrationWorker');

  const worker = new Worker(
    queueName,
    async (job: Job) => {
      const handler = handlers[job.name as NarrationJobName];
      if (!handler) throw new Error(`No handler registered for job name "${job.name}"`);
      return handler(job);
    },
    { connection: parseRedisUrl(url), concurrency: NARRATION_CONCURRENCY },
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
