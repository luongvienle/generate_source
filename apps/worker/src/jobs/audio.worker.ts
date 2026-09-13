import { Logger } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { AUDIO_QUEUE_NAME, parseRedisUrl, type AudioJobName } from '@knowledge-explorer/shared';

/** One handler per BullMQ job name on the audio queue. */
export type AudioJobHandlers = Partial<Record<AudioJobName, (job: Job) => Promise<unknown>>>;

/**
 * NFR-03 bounds concurrency here, and P5 needs it more than any earlier phase.
 *
 * ONE run at a time. A single audio run is already AUDIO_SEGMENT_CONCURRENCY
 * paid calls in flight plus an ffmpeg decode of every segment held in memory;
 * two concurrent runs would double both. The retry policy itself is a queue
 * default set by the producer, since a job carries its options from the moment
 * it is added.
 */
export const AUDIO_CONCURRENCY = 1;

export function createAudioWorker(
  url: string,
  handlers: AudioJobHandlers,
  queueName: string = process.env['AUDIO_QUEUE_NAME'] ?? AUDIO_QUEUE_NAME,
): Worker {
  const logger = new Logger('AudioWorker');

  const worker = new Worker(
    queueName,
    async (job: Job) => {
      const handler = handlers[job.name as AudioJobName];
      if (!handler) throw new Error(`No handler registered for job name "${job.name}"`);
      return handler(job);
    },
    { connection: parseRedisUrl(url), concurrency: AUDIO_CONCURRENCY },
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
