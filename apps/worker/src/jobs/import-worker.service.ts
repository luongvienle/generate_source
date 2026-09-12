import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Worker } from 'bullmq';
import { importJobNames } from '@knowledge-explorer/shared';
import { REDIS_URL, RedisService } from '../redis.service';
import { PrismaService } from '../prisma.service';
import { createImportWorker, type ImportJobHandlers } from './import.worker';
import { createDryRunProcessor } from './dry-run.processor';
import { createImportProcessor } from './import.processor';
import { withJobLifecycle } from './job-lifecycle';

/**
 * Owns the import queue consumer for the lifetime of the worker process.
 *
 * The dry run is deliberately NOT wrapped in withJobLifecycle: FR-IMP-02 forbids
 * it writing to the database, and a generation_jobs row is a database write.
 */
@Injectable()
export class ImportWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ImportWorkerService.name);
  private worker?: Worker;

  constructor(
    @Inject(REDIS_URL) private readonly url: string,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  protected handlers(): ImportJobHandlers {
    return {
      [importJobNames.dryRun]: createDryRunProcessor(this.prisma.client, this.redis.client),
      // The commit, unlike the dry run, has a generation_jobs row to drive.
      [importJobNames.commit]: withJobLifecycle(
        this.prisma.client.generationJob,
        createImportProcessor(this.prisma.client),
        this.logger,
      ),
    };
  }

  async onModuleInit(): Promise<void> {
    // The dry-run processor writes its result key through this client.
    await this.redis.ping();
    this.worker = createImportWorker(this.url, this.handlers());
    this.logger.log('Import queue consumer started');
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
