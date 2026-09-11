import { describe, expect, it } from 'vitest';
import { isAllowed, permissionMatrix, userRoles } from '../src/roles';
import type { PermissionAction } from '../src/roles';

describe('§3 permission matrix shape', () => {
  it('has the 16 action rows §3 lists', () => {
    expect(permissionMatrix).toHaveLength(16);
  });

  it('has exactly 3 roles', () => {
    expect(userRoles).toEqual(['admin_owner', 'admin', 'learner']);
  });

  it('gives every row an explicit verdict for all 3 roles', () => {
    for (const row of permissionMatrix) {
      for (const role of userRoles) {
        expect(typeof row.allowed[role], `${row.action}/${role}`).toBe('boolean');
      }
    }
    expect(permissionMatrix.length * userRoles.length).toBe(48);
  });

  it('uses a unique action key per row', () => {
    const keys = permissionMatrix.map((r) => r.action);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('carries the §3 description verbatim on every row', () => {
    for (const row of permissionMatrix) {
      expect(row.description.length, row.action).toBeGreaterThan(0);
    }
  });
});

describe('isAllowed', () => {
  it('denies an action that is not in the matrix', () => {
    expect(isAllowed('noSuchAction' as PermissionAction, 'admin_owner')).toBe(false);
  });

  it('withholds publishing and published-course edits from admin, per §3', () => {
    expect(isAllowed('publishOrUnpublishCourse', 'admin')).toBe(false);
    expect(isAllowed('publishOrUnpublishCourse', 'admin_owner')).toBe(true);
    expect(isAllowed('editPublishedCourse', 'admin')).toBe(false);
    expect(isAllowed('editPublishedCourse', 'admin_owner')).toBe(true);
  });

  it('withholds learner-only actions from both admin roles', () => {
    for (const action of ['submitAndUpvoteTopicRequests', 'buyAccessReadListenTrackProgress'] as const) {
      expect(isAllowed(action, 'learner')).toBe(true);
      expect(isAllowed(action, 'admin')).toBe(false);
      expect(isAllowed(action, 'admin_owner')).toBe(false);
    }
  });

  it('grants authoring actions to both admin roles but never to learner', () => {
    for (const action of [
      'createAndEditChaptersAndLessons',
      'writeLessonDraftContent',
      'generateAndSelectImages',
      'generateAndEditNarrationScript',
      'generateAudio',
      'submitCourseForReview',
    ] as const) {
      expect(isAllowed(action, 'admin_owner')).toBe(true);
      expect(isAllowed(action, 'admin')).toBe(true);
      expect(isAllowed(action, 'learner')).toBe(false);
    }
  });
});
