import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';
import { RedisService } from './redis.service';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * Standalone Nest application: the worker serves no HTTP traffic.
 *
 * It stays resident, unlike P0's boot-and-exit check, because it consumes the
 * curriculum import and image generation queues. Shutdown hooks let Nest close
 * the BullMQ workers and their Redis connections before the process ends, so a
 * job in flight is not abandoned mid-transaction.
 *
 * The readiness line below is matched by apps/api/test/helpers/worker-process.ts
 * and apps/admin-web/e2e/global-setup.ts. Both wait on the stable `Worker ready.`
 * PREFIX rather than the queue list, so adding P5's audio queue needs no change
 * to either — and a missed helper does not present as a 30-second hang with a
 * message that points nowhere near the cause.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  const logger = new Logger('Bootstrap');

  const reply = await app.get(RedisService).ping();
  if (reply !== 'PONG') {
    logger.error(`Unexpected Redis reply: ${reply}`);
    await app.close();
    process.exitCode = 1;
    return;
  }

  app.enableShutdownHooks();
  logger.log('Worker ready. Consuming the curriculum import and image generation queues.');
}

void bootstrap();
