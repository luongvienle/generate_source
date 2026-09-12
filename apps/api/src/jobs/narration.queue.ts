import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  JOB_BACKOFF_DELAY_MS,
  JOB_MAX_ATTEMPTS,
  NARRATION_QUEUE_NAME,
  narrationJobNames,
  parseRedisUrl,
  type GenerateNarrationScriptJobData,
} from '@knowledge-explorer/shared';
import { REDIS_URL } from './import.queue';

/** Marks a job id as belonging to the narration queue; see enqueueGenerate. */
export const NARRATION_JOB_ID_PREFIX = 'script:';

/**
 * The producer side of the narration script queue (P4).
 *
 * A sibling of ImageQueue, deliberately not a shared factory — see the note on
 * NARRATION_QUEUE_NAME in packages/shared for why the extraction was reconsidered
 * at the third queue and deferred again. NFR-03's retry policy is set here as the
 * queue default, so no endpoint can enqueue work that retries forever.
 *
 * Like the image queue and unlike import, finished jobs are not retained for a
 * result TTL: a narration run's result is the narration_scripts row, and the tab
 * reads that rather than the job's return value.
 */
@Injectable()
export class NarrationQueue implements OnModuleDestroy {
  private readonly logger = new Logger(NarrationQueue.name);
  readonly queue: Queue;

  constructor(
    @Inject(REDIS_URL) url: string,
    queueName: string = process.env['NARRATION_QUEUE_NAME'] ?? NARRATION_QUEUE_NAME,
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
   * Returns a QUALIFIED job id, `script:<bullmq id>`.
   *
   * BullMQ ids are a per-queue counter, so with a third queue an unprefixed id
   * is ambiguous across all of them. Qualifying follows the precedent P3 set with
   * `image:<n>` and leaves P1's unprefixed import ids alone.
   */
  async enqueueGenerate(data: GenerateNarrationScriptJobData): Promise<string> {
    const job = await this.queue.add(narrationJobNames.generate, data);
    if (!job.id) throw new Error('BullMQ returned a job with no id');
    this.logger.log(`Enqueued ${narrationJobNames.generate} as job ${job.id}`);
    return `${NARRATION_JOB_ID_PREFIX}${job.id}`;
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
