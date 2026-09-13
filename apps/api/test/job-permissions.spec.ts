import { describe, expect, it } from 'vitest';
import { jobTypes } from '@knowledge-explorer/shared';
import { isLessonTargeted, mayWatch, permissionForJobType } from '../src/jobs/job-permissions';

/**
 * The map is PARTIAL and deny-by-default, which is the whole point: a phase that
 * adds a producer without adding its row fails closed. These assertions hold that
 * property while P4 adds the third row, so P5 and P6 inherit it rather than
 * rediscovering it.
 */
describe('permissionForJobType', () => {
  it('maps the narration job to its §3 action', () => {
    expect(permissionForJobType('generate_narration_script')).toBe('generateAndEditNarrationScript');
  });

  it('still maps the two P1 and P3 producers', () => {
    expect(permissionForJobType('import_course_outline')).toBe('importCurriculumOutline');
    expect(permissionForJobType('generate_image')).toBe('generateAndSelectImages');
    expect(permissionForJobType('dry_run')).toBe('importCurriculumOutline');
  });

  it('refuses a job type with no row, rather than allowing it', () => {
    for (const jobType of jobTypes) {
      const declared = permissionForJobType(jobType);
      if (declared === undefined) {
        // Unbuilt producers (P6, P8) must stay undeclared and unwatchable.
        expect(mayWatch(jobType, 'admin_owner')).toBe(false);
      }
    }
    // `generate_audio` was this assertion's example until P5 declared it. The
    // property under test is unchanged — publish_course (P6) and
    // send_expiry_reminder (P8) are still undeclared and still unwatchable.
    expect(permissionForJobType('publish_course')).toBeUndefined();
    expect(permissionForJobType('send_expiry_reminder')).toBeUndefined();
  });
});

describe('mayWatch', () => {
  it('lets both admin roles watch a narration job and refuses a learner', () => {
    expect(mayWatch('generate_narration_script', 'admin_owner')).toBe(true);
    expect(mayWatch('generate_narration_script', 'admin')).toBe(true);
    expect(mayWatch('generate_narration_script', 'learner')).toBe(false);
  });

  it('still refuses an admin the owner-only import job', () => {
    expect(mayWatch('import_course_outline', 'admin')).toBe(false);
  });
});

describe('isLessonTargeted', () => {
  it('includes narration, so R-02 applies to watching it', () => {
    expect(isLessonTargeted('generate_narration_script')).toBe(true);
    expect(isLessonTargeted('generate_image')).toBe(true);
  });

  it('excludes import, whose target is a category', () => {
    expect(isLessonTargeted('import_course_outline')).toBe(false);
    expect(isLessonTargeted('dry_run')).toBe(false);
  });
});
