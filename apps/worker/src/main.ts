import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';
import { RedisService } from './redis.service';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * Standalone Nest application: the worker serves no HTTP traffic.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  const redis = app.get(RedisService);
  const reply = await redis.ping();

  const logger = new Logger('Bootstrap');
  if (reply !== 'PONG') {
    logger.error(`Unexpected Redis reply: ${reply}`);
    await app.close();
    process.exitCode = 1;
    return;
  }
  logger.log('Worker ready. No queues registered — job processing lands in P3.');
  await app.close();
}

void bootstrap();
