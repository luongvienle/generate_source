import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Worker } from 'bullmq';
import { imageJobNames } from '@knowledge-explorer/shared';
import { createImageGenerationProvider } from '@knowledge-explorer/ai';
import { OBJECT_STORAGE, type ObjectStorage } from '@knowledge-explorer/storage';
import { REDIS_URL } from '../redis.service';
import { PrismaService } from '../prisma.service';
import { createImageWorker, type ImageJobHandlers } from './image.worker';
import { createImageProcessor } from './image.processor';
import { withJobLifecycle } from './job-lifecycle';

/**
 * Owns the image queue consumer for the lifetime of the worker process.
 *
 * Every generate job has a generation_jobs row, so unlike the import dry run
 * there is no unwrapped path here: withJobLifecycle drives all of them.
 */
@Injectable()
export class ImageWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ImageWorkerService.name);
  private worker?: Worker;

  constructor(
    @Inject(REDIS_URL) private readonly url: string,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  protected handlers(): ImageJobHandlers {
    return {
      [imageJobNames.generate]: withJobLifecycle(
        this.prisma.client.generationJob,
        createImageProcessor(
          this.prisma.client,
          // Selection is by environment and happens once, at startup: an
          // IMAGE_PROVIDER=openai with no key fails the boot rather than
          // silently serving fakes.
          createImageGenerationProvider(),
          this.storage,
        ),
        this.logger,
      ),
    };
  }

  async onModuleInit(): Promise<void> {
    this.worker = createImageWorker(this.url, this.handlers());
    this.logger.log('Image queue consumer started');
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
