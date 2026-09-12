import { isAllowed, type JobType, type PermissionAction, type UserRole } from '@knowledge-explorer/shared';

/**
 * Which §3 action a job type's progress belongs to.
 *
 * P1 hardcoded `importCurriculumOutline` on the stream because import was the
 * only producer. With a second one, an admin watching their own image job must
 * not be refused, and must still not see the owner's import job. P4 adds a third
 * whose action differs again.
 *
 * PARTIAL, AND DENY-BY-DEFAULT. A job type with no row here is refused rather
 * than allowed, so P4, P5 and P6 adding a producer without adding its row fails
 * closed — the same rule RolesGuard applies to an endpoint with no declared
 * permission. P5 and P6 inherit that guarantee.
 */
const jobPermissions: Partial<Record<JobType, PermissionAction>> = {
  import_course_outline: 'importCurriculumOutline',
  generate_image: 'generateAndSelectImages',
  generate_narration_script: 'generateAndEditNarrationScript',
};

/** P1's dry run has no §8.1 job_type, and is part of the import flow. */
export type WatchableJobType = JobType | 'dry_run';

export function permissionForJobType(jobType: WatchableJobType): PermissionAction | undefined {
  if (jobType === 'dry_run') return 'importCurriculumOutline';
  return jobPermissions[jobType];
}

/**
 * Job types whose `target_entity_id` is a lesson, so R-02 applies to watching
 * them. Import targets a category and publish will target a course; neither is
 * assignment-scoped.
 */
const lessonTargetedJobTypes: ReadonlySet<string> = new Set<WatchableJobType>([
  'generate_image',
  'generate_narration_script',
]);

export const isLessonTargeted = (jobType: WatchableJobType): boolean =>
  lessonTargetedJobTypes.has(jobType);

/** Whether a role may watch this job type at all, per §3 alone. */
export function mayWatch(jobType: WatchableJobType, role: UserRole): boolean {
  const action = permissionForJobType(jobType);
  return action !== undefined && isAllowed(action, role);
}
