import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';
import { RedisService } from './redis.service';
import { assertFfmpegAvailable } from './audio/ffmpeg';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * Standalone Nest application: the worker serves no HTTP traffic.
 *
 * It stays resident, unlike P0's boot-and-exit check, because it consumes the
 * four job queues. Shutdown hooks let Nest close the BullMQ workers and their
 * Redis connections before the process ends, so a job in flight is not abandoned
 * mid-transaction.
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

  /**
   * P5: ffmpeg and ffprobe are required (§11), so a worker without them refuses
   * to start rather than discovering it inside attempt 3 of an audio job that
   * has already paid a provider for every segment.
   *
   * Deliberately fails the WHOLE process, not just the audio queue: a deployment
   * missing a dependency §11 names is broken, and a worker that quietly served
   * three of four queues would look healthy while audio silently never ran.
   */
  try {
    await assertFfmpegAvailable();
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    await app.close();
    process.exitCode = 1;
    return;
  }

  app.enableShutdownHooks();
  // The `Worker ready.` PREFIX is matched by apps/api/test/helpers/worker-process.ts
  // and apps/admin-web/e2e/global-setup.ts. The sentence after it may change; the
  // prefix may not.
  logger.log(
    'Worker ready. Consuming the curriculum import, image generation, narration script and audio queues.',
  );
}

void bootstrap();
