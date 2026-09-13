import { Inject, Injectable } from '@nestjs/common';
import { importJobNames, queueDefinitions, type ImportJobName } from '@knowledge-explorer/shared';
import { BaseJobQueue } from './base.queue';

export const REDIS_URL = Symbol('RedisUrl');

/**
 * The producer side of the curriculum import queue.
 *
 * NFR-04 forbids an HTTP request waiting on long-running work, so both import
 * endpoints enqueue and return 202. NFR-03's retry policy is a queue default set
 * by BaseJobQueue rather than per call site, so no endpoint can enqueue work that
 * retries forever.
 *
 * ITS IDS ARE UNPREFIXED, permanently. P1 minted them that way and screens it
 * shipped still hold them, so `queueDefinitions.import.idPrefix` is `''` and
 * `enqueue` returns exactly what it always returned.
 */
@Injectable()
export class ImportQueue extends BaseJobQueue {
  constructor(@Inject(REDIS_URL) url: string, queueName?: string) {
    super(url, queueDefinitions.import, queueName);
  }

  enqueue(name: ImportJobName, data: unknown): Promise<string> {
    return this.add(name, data);
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
   *
   * This, and the two job names above, are why the producers were NOT collapsed
   * into one class at P5: no other queue has anything like it.
   */
  async readKey(key: string): Promise<string | null> {
    const client = await this.queue.client;
    return client.get(key);
  }
}
