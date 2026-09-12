import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  IMAGE_QUEUE_NAME,
  JOB_BACKOFF_DELAY_MS,
  JOB_MAX_ATTEMPTS,
  imageJobNames,
  parseRedisUrl,
  type GenerateImageJobData,
} from '@knowledge-explorer/shared';
import { REDIS_URL } from './import.queue';

/** Marks a job id as belonging to the image queue; see enqueueGenerate. */
export const IMAGE_JOB_ID_PREFIX = 'image:';

/**
 * The producer side of the image generation queue.
 *
 * A sibling of ImportQueue, deliberately not a shared factory — see the note on
 * IMAGE_QUEUE_NAME in packages/shared. NFR-03's retry policy is set here as the
 * queue default, so no endpoint can enqueue work that retries forever.
 *
 * Unlike the import queue, finished jobs are not retained for the dry-run TTL:
 * a generate job's result is rows in the database, and the drawer reads those
 * rather than the job's return value.
 */
@Injectable()
export class ImageQueue implements OnModuleDestroy {
  private readonly logger = new Logger(ImageQueue.name);
  readonly queue: Queue;

  constructor(
    @Inject(REDIS_URL) url: string,
    queueName: string = process.env['IMAGE_QUEUE_NAME'] ?? IMAGE_QUEUE_NAME,
  ) {
    this.queue = new Queue(queueName, {
      connection: parseRedisUrl(url),
      defaultJobOptions: {
        attempts: JOB_MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: JOB_BACKOFF_DELAY_MS },
        // Long enough that a client subscribing after the job ended still
        // receives its terminal event.
        removeOnComplete: { age: 3_600 },
        removeOnFail: { age: 3_600 },
      },
    });
  }

  /**
   * Returns a QUALIFIED job id, `image:<bullmq id>`.
   *
   * BullMQ ids are a per-queue counter, so with a second queue "job 1" stopped
   * being unique and `/admin/jobs/1/stream` became ambiguous. Qualifying the
   * new queue's ids resolves it without changing the unprefixed ids P1's import
   * flow already returns and its screens already hold.
   */
  async enqueueGenerate(data: GenerateImageJobData): Promise<string> {
    const job = await this.queue.add(imageJobNames.generate, data);
    if (!job.id) throw new Error('BullMQ returned a job with no id');
    this.logger.log(`Enqueued ${imageJobNames.generate} as job ${job.id}`);
    return `${IMAGE_JOB_ID_PREFIX}${job.id}`;
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
