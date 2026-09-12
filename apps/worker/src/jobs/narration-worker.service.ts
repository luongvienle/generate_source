import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Worker } from 'bullmq';
import { narrationJobNames } from '@knowledge-explorer/shared';
import { createLlmProvider } from '@knowledge-explorer/ai';
import { REDIS_URL } from '../redis.service';
import { PrismaService } from '../prisma.service';
import { createNarrationWorker, type NarrationJobHandlers } from './narration.worker';
import { createNarrationProcessor } from './narration.processor';
import { withJobLifecycle } from './job-lifecycle';

/**
 * Owns the narration queue consumer for the lifetime of the worker process.
 *
 * Every generate job has a generation_jobs row, so unlike the import dry run
 * there is no unwrapped path here: withJobLifecycle drives all of them.
 */
@Injectable()
export class NarrationWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NarrationWorkerService.name);
  private worker?: Worker;

  constructor(
    @Inject(REDIS_URL) private readonly url: string,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  protected handlers(): NarrationJobHandlers {
    return {
      [narrationJobNames.generate]: withJobLifecycle(
        this.prisma.client.generationJob,
        createNarrationProcessor(
          this.prisma.client,
          // Selection is by environment and happens once, at startup: an
          // LLM_PROVIDER=anthropic with no key fails the boot rather than
          // silently narrating with the fake.
          createLlmProvider(),
        ),
        this.logger,
      ),
    };
  }

  async onModuleInit(): Promise<void> {
    this.worker = createNarrationWorker(this.url, this.handlers());
    this.logger.log('Narration queue consumer started');
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
