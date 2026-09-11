import type { UserRole } from './enums';
import { userRoles } from './enums';

/**
 * The role and permission matrix from knowledge-explorer-spec.md §3, as data.
 *
 * Guards and the policy test suite both read this table, so enforcement cannot
 * drift from the specification. `description` is verbatim from §3 — keep it that
 * way, it is how a reader checks this table against the spec.
 *
 * Rules R-01 and R-02 are deliberately NOT expressed here. They are conditional
 * on the target row's state (course publication status, admin assignment), not on
 * the caller's role alone, and live in their own guards.
 */

export type PermissionAction =
  | 'manageAdminAccounts'
  | 'createCategoriesAndCourses'
  | 'importCurriculumOutline'
  | 'createAndEditChaptersAndLessons'
  | 'writeLessonDraftContent'
  | 'generateAndSelectImages'
  | 'generateAndEditNarrationScript'
  | 'generateAudio'
  | 'submitCourseForReview'
  | 'publishOrUnpublishCourse'
  | 'editPublishedCourse'
  | 'createProductsAndSetPrices'
  | 'grantOrRevokeAccessManually'
  | 'reviewTopicRequests'
  | 'submitAndUpvoteTopicRequests'
  | 'buyAccessReadListenTrackProgress';

export interface PermissionRow {
  readonly action: PermissionAction;
  readonly description: string;
  readonly allowed: Readonly<Record<UserRole, boolean>>;
}

export const permissionMatrix: readonly PermissionRow[] = [
  {
    action: 'manageAdminAccounts',
    description: 'Create, edit, disable admin accounts',
    allowed: { admin_owner: true, admin: false, learner: false },
  },
  {
    action: 'createCategoriesAndCourses',
    description: 'Create categories and courses',
    allowed: { admin_owner: true, admin: false, learner: false },
  },
  {
    action: 'importCurriculumOutline',
    description: 'Import curriculum outline',
    allowed: { admin_owner: true, admin: false, learner: false },
  },
  {
    action: 'createAndEditChaptersAndLessons',
    description: 'Create and edit chapters and lessons',
    allowed: { admin_owner: true, admin: true, learner: false },
  },
  {
    action: 'writeLessonDraftContent',
    description: 'Write lesson draft content',
    allowed: { admin_owner: true, admin: true, learner: false },
  },
  {
    action: 'generateAndSelectImages',
    description: 'Generate and select images',
    allowed: { admin_owner: true, admin: true, learner: false },
  },
  {
    action: 'generateAndEditNarrationScript',
    description: 'Generate and edit narration script',
    allowed: { admin_owner: true, admin: true, learner: false },
  },
  {
    action: 'generateAudio',
    description: 'Generate audio',
    allowed: { admin_owner: true, admin: true, learner: false },
  },
  {
    action: 'submitCourseForReview',
    description: 'Submit course for review',
    allowed: { admin_owner: true, admin: true, learner: false },
  },
  {
    action: 'publishOrUnpublishCourse',
    description: 'Publish or unpublish a course',
    allowed: { admin_owner: true, admin: false, learner: false },
  },
  {
    action: 'editPublishedCourse',
    description: 'Edit a course that is published',
    allowed: { admin_owner: true, admin: false, learner: false },
  },
  {
    action: 'createProductsAndSetPrices',
    description: 'Create products, set prices',
    allowed: { admin_owner: true, admin: false, learner: false },
  },
  {
    action: 'grantOrRevokeAccessManually',
    description: 'Grant or revoke access manually',
    allowed: { admin_owner: true, admin: false, learner: false },
  },
  {
    action: 'reviewTopicRequests',
    description: 'Review topic requests',
    allowed: { admin_owner: true, admin: false, learner: false },
  },
  {
    action: 'submitAndUpvoteTopicRequests',
    description: 'Submit and upvote topic requests',
    allowed: { admin_owner: false, admin: false, learner: true },
  },
  {
    action: 'buyAccessReadListenTrackProgress',
    description: 'Buy access, read, listen, track progress',
    allowed: { admin_owner: false, admin: false, learner: true },
  },
] as const;

const matrixByAction = new Map<PermissionAction, PermissionRow>(
  permissionMatrix.map((row) => [row.action, row]),
);

/**
 * Whether a role may perform an action, per §3 alone.
 *
 * Deny-by-default: an action absent from the matrix is refused rather than
 * allowed, so adding an endpoint without adding its row fails closed.
 */
export function isAllowed(action: PermissionAction, role: UserRole): boolean {
  return matrixByAction.get(action)?.allowed[role] ?? false;
}

export { userRoles };
export type { UserRole };
