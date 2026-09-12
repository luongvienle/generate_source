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
 * It stays resident, unlike P0's boot-and-exit check, because it now consumes
 * the curriculum import queue. Shutdown hooks let Nest close the BullMQ worker
 * and its Redis connections before the process ends, so a job in flight is not
 * abandoned mid-transaction.
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
  logger.log('Worker ready. Consuming the curriculum import queue.');
}

void bootstrap();
