import { Logger, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  JOB_BACKOFF_DELAY_MS,
  JOB_MAX_ATTEMPTS,
  parseRedisUrl,
  type QueueDefinition,
} from '@knowledge-explorer/shared';

/**
 * What every producer shares, and nothing else (P5).
 *
 * P3's and P4's notes in packages/shared/src/queues.ts predicted a shared shape
 * at the third queue and deferred it twice, naming P5's audio queue as the
 * moment to extract. This is that extraction: construction, NFR-03's retry
 * policy as a queue default, id qualification, and shutdown.
 *
 * The producers keep their own subclasses because they genuinely differ — import
 * has two job names and a Redis-cached dry-run result, image composes its prompt
 * at enqueue, narration and audio hold a database-level in-flight lock. Only the
 * parts that must never drift live here.
 *
 * NFR-03's policy is a QUEUE DEFAULT rather than a per-call-site option: a job
 * carries its options from the moment it is added, so setting them here is what
 * makes it impossible for an endpoint to enqueue work that retries forever.
 */
export abstract class BaseJobQueue implements OnModuleDestroy {
  protected readonly logger: Logger;
  readonly queue: Queue;

  /**
   * `queueName` stays an optional SECOND POSITIONAL parameter because six
   * existing suites construct producers as `new XQueue(url, name)` to isolate a
   * queue per test run. Changing the shape would be a test-only refactor
   * disguised as a production one.
   */
  protected constructor(
    url: string,
    protected readonly definition: QueueDefinition,
    queueName?: string,
  ) {
    this.logger = new Logger(this.constructor.name);

    this.queue = new Queue(queueName ?? process.env[definition.envVar] ?? definition.name, {
      connection: parseRedisUrl(url),
      defaultJobOptions: {
        attempts: JOB_MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: JOB_BACKOFF_DELAY_MS },
        // Long enough that a client subscribing after the job ended still
        // receives its terminal event. Import retains for the dry-run TTL
        // instead, because FR-IMP-02's cached result must not outlive the job
        // that explains it.
        removeOnComplete: { age: definition.retentionSeconds },
        removeOnFail: { age: definition.retentionSeconds },
      },
    });
  }

  /**
   * Adds a job and returns its id QUALIFIED with this queue's prefix.
   *
   * BullMQ ids are a per-queue counter, so with four queues "job 1" is not
   * unique and `/admin/jobs/1/stream` would be ambiguous. The import queue's
   * prefix is deliberately empty — P1 minted unprefixed ids and its screens
   * still hold them — so this returns exactly what it always did there.
   */
  protected async add(name: string, data: unknown): Promise<string> {
    const job = await this.queue.add(name, data);
    if (!job.id) throw new Error('BullMQ returned a job with no id');
    this.logger.log(`Enqueued ${name} as job ${job.id}`);
    return `${this.definition.idPrefix}${job.id}`;
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
