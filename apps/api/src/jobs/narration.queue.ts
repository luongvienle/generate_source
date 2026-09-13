import { Inject, Injectable } from '@nestjs/common';
import {
  narrationJobNames,
  queueDefinitions,
  type GenerateNarrationScriptJobData,
} from '@knowledge-explorer/shared';
import { BaseJobQueue } from './base.queue';
import { REDIS_URL } from './import.queue';

/** Marks a job id as belonging to the narration queue. Single-sourced from the registry. */
export const NARRATION_JOB_ID_PREFIX = queueDefinitions.narration.idPrefix;

/**
 * The producer side of the narration script queue (P4).
 *
 * Like the image queue and unlike import, finished jobs are not retained for a
 * result TTL: a narration run's result is the narration_scripts row, and the tab
 * reads that rather than the job's return value.
 */
@Injectable()
export class NarrationQueue extends BaseJobQueue {
  constructor(@Inject(REDIS_URL) url: string, queueName?: string) {
    super(url, queueDefinitions.narration, queueName);
  }

  /** Returns a QUALIFIED job id, `script:<bullmq id>`. */
  enqueueGenerate(data: GenerateNarrationScriptJobData): Promise<string> {
    return this.add(narrationJobNames.generate, data);
  }
}
