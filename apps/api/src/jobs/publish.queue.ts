import { Inject, Injectable } from '@nestjs/common';
import {
  publishJobNames,
  queueDefinitions,
  type PublishCourseJobData,
} from '@knowledge-explorer/shared';
import { BaseJobQueue } from './base.queue';
import { REDIS_URL } from './import.queue';

/** Marks a job id as belonging to the publish queue. Single-sourced from the registry. */
export const PUBLISH_JOB_ID_PREFIX = queueDefinitions.publish.idPrefix;

/**
 * The producer side of the publish queue (P6) — the fifth, and the first whose
 * `target_entity_id` is a course.
 *
 * Like image, narration and audio and unlike import, finished jobs are not
 * retained for a result TTL: a run's result is the published_course_structures
 * row and the published lesson columns, and the panel reads those.
 */
@Injectable()
export class PublishQueue extends BaseJobQueue {
  constructor(@Inject(REDIS_URL) url: string, queueName?: string) {
    super(url, queueDefinitions.publish, queueName);
  }

  /** Returns a QUALIFIED job id, `publish:<bullmq id>`. */
  enqueuePublish(data: PublishCourseJobData): Promise<string> {
    return this.add(publishJobNames.publish, data);
  }
}
