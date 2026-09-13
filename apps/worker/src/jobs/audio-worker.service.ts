import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Worker } from 'bullmq';
import { audioJobNames } from '@knowledge-explorer/shared';
import { createTextToSpeechProvider } from '@knowledge-explorer/ai';
import { OBJECT_STORAGE, type ObjectStorage } from '@knowledge-explorer/storage';
import { REDIS_URL } from '../redis.service';
import { PrismaService } from '../prisma.service';
import { createAudioWorker, type AudioJobHandlers } from './audio.worker';
import { createAudioProcessor } from './audio.processor';
import { withJobLifecycle } from './job-lifecycle';

/**
 * Owns the audio queue consumer for the lifetime of the worker process.
 *
 * Every generate job has a generation_jobs row, so unlike the import dry run
 * there is no unwrapped path here: withJobLifecycle drives all of them.
 */
@Injectable()
export class AudioWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AudioWorkerService.name);
  private worker?: Worker;

  constructor(
    @Inject(REDIS_URL) private readonly url: string,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  protected handlers(): AudioJobHandlers {
    return {
      [audioJobNames.generate]: withJobLifecycle(
        this.prisma.client.generationJob,
        createAudioProcessor(
          this.prisma.client,
          // Selection is by environment and happens once, at startup: a
          // TTS_PROVIDER=openai with no key fails the boot rather than silently
          // playing a sine tone where a voice should be.
          createTextToSpeechProvider(),
          this.storage,
        ),
        this.logger,
      ),
    };
  }

  async onModuleInit(): Promise<void> {
    this.worker = createAudioWorker(this.url, this.handlers());
    this.logger.log('Audio queue consumer started');
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
