import { describe, expect, it } from 'vitest';
import { isAllowed, permissionMatrix, userRoles } from '../src/roles';
import type { PermissionAction, UserRole } from '../src/roles';

/**
 * One assertion per cell of the §3 table: 16 actions × 3 roles = 48.
 *
 * The expected verdicts are transcribed independently from
 * knowledge-explorer-spec.md §3 rather than imported from src/roles.ts.
 * Importing them would make this suite compare the module against itself and
 * prove nothing. If §3 changes, this table and the source must both be edited.
 */
const specifiedIn_3: Record<PermissionAction, Record<UserRole, boolean>> = {
  manageAdminAccounts: { admin_owner: true, admin: false, learner: false },
  createCategoriesAndCourses: { admin_owner: true, admin: false, learner: false },
  importCurriculumOutline: { admin_owner: true, admin: false, learner: false },
  createAndEditChaptersAndLessons: { admin_owner: true, admin: true, learner: false },
  writeLessonDraftContent: { admin_owner: true, admin: true, learner: false },
  generateAndSelectImages: { admin_owner: true, admin: true, learner: false },
  generateAndEditNarrationScript: { admin_owner: true, admin: true, learner: false },
  generateAudio: { admin_owner: true, admin: true, learner: false },
  submitCourseForReview: { admin_owner: true, admin: true, learner: false },
  publishOrUnpublishCourse: { admin_owner: true, admin: false, learner: false },
  editPublishedCourse: { admin_owner: true, admin: false, learner: false },
  createProductsAndSetPrices: { admin_owner: true, admin: false, learner: false },
  grantOrRevokeAccessManually: { admin_owner: true, admin: false, learner: false },
  reviewTopicRequests: { admin_owner: true, admin: false, learner: false },
  submitAndUpvoteTopicRequests: { admin_owner: false, admin: false, learner: true },
  buyAccessReadListenTrackProgress: { admin_owner: false, admin: false, learner: true },
};

const cells = Object.entries(specifiedIn_3).flatMap(([action, byRole]) =>
  userRoles.map((role) => ({
    action: action as PermissionAction,
    role,
    expected: byRole[role],
  })),
);

describe('§3 permission matrix, cell by cell', () => {
  it('covers 48 cells — every action in §3 against every role', () => {
    expect(cells).toHaveLength(48);
    expect(Object.keys(specifiedIn_3)).toHaveLength(16);
  });

  it('declares a verdict for every action the implementation knows about', () => {
    // Catches an action added to src/roles.ts without a §3 verdict recorded here.
    const implemented = permissionMatrix.map((row) => row.action).sort();
    expect(implemented).toEqual(Object.keys(specifiedIn_3).sort());
  });

  it.each(cells)('$action / $role -> $expected', ({ action, role, expected }) => {
    expect(isAllowed(action, role)).toBe(expected);
  });
});
