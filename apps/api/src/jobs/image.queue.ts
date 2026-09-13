import { Inject, Injectable } from '@nestjs/common';
import {
  imageJobNames,
  queueDefinitions,
  type GenerateImageJobData,
} from '@knowledge-explorer/shared';
import { BaseJobQueue } from './base.queue';
import { REDIS_URL } from './import.queue';

/** Marks a job id as belonging to the image queue. Single-sourced from the registry. */
export const IMAGE_JOB_ID_PREFIX = queueDefinitions.image.idPrefix;

/**
 * The producer side of the image generation queue.
 *
 * Unlike the import queue, finished jobs are not retained for the dry-run TTL:
 * a generate job's result is rows in the database, and the drawer reads those
 * rather than the job's return value.
 */
@Injectable()
export class ImageQueue extends BaseJobQueue {
  constructor(@Inject(REDIS_URL) url: string, queueName?: string) {
    super(url, queueDefinitions.image, queueName);
  }

  /** Returns a QUALIFIED job id, `image:<bullmq id>`. */
  enqueueGenerate(data: GenerateImageJobData): Promise<string> {
    return this.add(imageJobNames.generate, data);
  }
}
