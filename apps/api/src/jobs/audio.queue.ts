import { Inject, Injectable } from '@nestjs/common';
import {
  audioJobNames,
  queueDefinitions,
  type GenerateAudioJobData,
} from '@knowledge-explorer/shared';
import { BaseJobQueue } from './base.queue';
import { REDIS_URL } from './import.queue';

/** Marks a job id as belonging to the audio queue. Single-sourced from the registry. */
export const AUDIO_JOB_ID_PREFIX = queueDefinitions.audio.idPrefix;

/**
 * The producer side of the audio queue (P5) — the fourth, and the one the
 * extraction in packages/shared/src/queues.ts was deferred twice to meet.
 *
 * Like image and narration and unlike import, finished jobs are not retained for
 * a result TTL: a run's result is the lesson_audios row and its segments, and the
 * tab reads those rather than the job's return value.
 */
@Injectable()
export class AudioQueue extends BaseJobQueue {
  constructor(@Inject(REDIS_URL) url: string, queueName?: string) {
    super(url, queueDefinitions.audio, queueName);
  }

  /** Returns a QUALIFIED job id, `audio:<bullmq id>`. */
  enqueueGenerate(data: GenerateAudioJobData): Promise<string> {
    return this.add(audioJobNames.generate, data);
  }
}
