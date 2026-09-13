import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Worker } from 'bullmq';
import { publishJobNames } from '@knowledge-explorer/shared';
import { REDIS_URL } from '../redis.service';
import { PrismaService } from '../prisma.service';
import { createPublishWorker, type PublishJobHandlers } from './publish.worker';
import { createPublishProcessor } from './publish.processor';
import { withJobLifecycle } from './job-lifecycle';

/**
 * Owns the publish queue consumer for the lifetime of the worker process.
 *
 * Every publish job has a generation_jobs row — the API creates it in the same
 * transaction that takes the `publishing` lock — so withJobLifecycle drives all
 * of them and there is no unwrapped path.
 */
@Injectable()
export class PublishWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PublishWorkerService.name);
  private worker?: Worker;

  constructor(
    @Inject(REDIS_URL) private readonly url: string,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  protected handlers(): PublishJobHandlers {
    return {
      [publishJobNames.publish]: withJobLifecycle(
        this.prisma.client.generationJob,
        createPublishProcessor(this.prisma.client),
        this.logger,
      ),
    };
  }

  async onModuleInit(): Promise<void> {
    this.worker = createPublishWorker(this.url, this.handlers());
    this.logger.log('Publish queue consumer started');
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
