import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  IMPORT_QUEUE_NAME,
  parseRedisUrl,
  JOB_BACKOFF_DELAY_MS,
  JOB_MAX_ATTEMPTS,
  DRY_RUN_RESULT_TTL_SECONDS,
  importJobNames,
  type ImportJobName,
} from '@knowledge-explorer/shared';

export const REDIS_URL = Symbol('RedisUrl');

/**
 * The producer side of the curriculum import queue.
 *
 * NFR-04 forbids an HTTP request waiting on long-running work, so both import
 * endpoints enqueue and return 202. NFR-03's retry policy is set here as the
 * queue default rather than per call site, so no endpoint can enqueue work that
 * retries forever.
 */
@Injectable()
export class ImportQueue implements OnModuleDestroy {
  private readonly logger = new Logger(ImportQueue.name);
  readonly queue: Queue;

  constructor(
    @Inject(REDIS_URL) url: string,
    queueName: string = process.env['IMPORT_QUEUE_NAME'] ?? IMPORT_QUEUE_NAME,
  ) {
    this.queue = new Queue(queueName, {
      connection: parseRedisUrl(url),
      defaultJobOptions: {
        attempts: JOB_MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: JOB_BACKOFF_DELAY_MS },
        // Retaining finished jobs for the dry-run TTL is what lets a client that
        // subscribes after a job ends still receive its terminal event.
        removeOnComplete: { age: DRY_RUN_RESULT_TTL_SECONDS },
        removeOnFail: { age: DRY_RUN_RESULT_TTL_SECONDS },
      },
    });
  }

  async enqueue(name: ImportJobName, data: unknown): Promise<string> {
    const job = await this.queue.add(name, data);
    if (!job.id) throw new Error('BullMQ returned a job with no id');
    this.logger.log(`Enqueued ${name} as job ${job.id}`);
    return job.id;
  }

  enqueueDryRun(data: unknown): Promise<string> {
    return this.enqueue(importJobNames.dryRun, data);
  }

  enqueueCommit(data: unknown): Promise<string> {
    return this.enqueue(importJobNames.commit, data);
  }

  /**
   * Reads one of our own Redis keys — the dry-run result cache — through BullMQ's
   * connection rather than opening a second one. apps/api therefore needs no
   * direct ioredis dependency, which also keeps it clear of the ioredis 5/6 split
   * between BullMQ and apps/worker.
   */
  async readKey(key: string): Promise<string | null> {
    const client = await this.queue.client;
    return client.get(key);
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
