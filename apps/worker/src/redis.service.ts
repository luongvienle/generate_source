import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

export const REDIS_URL = Symbol('RedisUrl');

/**
 * Holds the Redis connection the worker will run queues on.
 *
 * P0 registers no queue and processes no job type from §8.1 — BullMQ and the
 * job handlers are P3 onward. This exists so the connection itself, and the
 * configuration that reaches it, are proven before any job depends on them.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(@Inject(REDIS_URL) url: string) {
    // maxRetriesPerRequest: null is BullMQ's requirement; setting it now avoids
    // a surprise reconfiguration when queues arrive in P3.
    this.client = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: true });
  }

  async ping(): Promise<string> {
    if (this.client.status === 'wait') await this.client.connect();
    const reply = await this.client.ping();
    this.logger.log(`Redis PING -> ${reply}`);
    return reply;
  }

  async onModuleDestroy(): Promise<void> {
    this.client.disconnect();
  }
}
