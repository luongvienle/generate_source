import { Controller, Get, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { RequirePermission } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { PublishedLockGuard } from '../auth/published-lock.guard';
import type { RequestWithSession } from '../auth/session-context';
import { PublishingService } from './publishing.service';

/**
 * §5.7 publishing endpoints — §9.2's owner set plus §9.3's submit-review.
 *
 * NO AssignmentGuard, deliberately, and this is the only content controller
 * without one. R-02 is a row-level rule about "chapters and lessons"; §8 gives
 * the course row no assigned_admin_id at all. WriteTargetResolver's courseId
 * branch answers with every assignment in the course, which is right for
 * PATCH /courses/:courseId/structure — a reorder really does touch every row —
 * and wrong here: it would stop an admin from submitting a course for review
 * merely because a colleague is assigned to one of its lessons, which is the
 * normal multi-admin case and precisely the handoff submit-review exists for.
 *
 * PublishedLockGuard stays. R-01 is course-level and the course is exactly what
 * these endpoints write.
 */
@Controller('admin/courses')
@UseGuards(SessionGuard, RolesGuard, PublishedLockGuard)
export class PublishingController {
  constructor(@Inject(PublishingService) private readonly publishing: PublishingService) {}

  /** The publication state and what may follow it. Read by the publish panel. */
  @Get(':courseId/publication-status')
  @RequirePermission('submitCourseForReview')
  status(@Param('courseId') courseId: string) {
    return this.publishing.status(courseId);
  }

  /**
   * FR-PUB-01. §9.2 lists this among the OWNER endpoints, so `admin` is refused
   * here even though the panel would happily show an admin why a course is not
   * ready. §9.2 is the locked contract and outranks that convenience.
   */
  @Get(':courseId/publish-checklist')
  @RequirePermission('publishOrUnpublishCourse')
  checklist(@Param('courseId') courseId: string) {
    return this.publishing.checklist(courseId);
  }

  /** §9.3. Admin-callable: this is how an admin hands a course to the owner. */
  @Post(':courseId/submit-review')
  @RequirePermission('submitCourseForReview')
  submitReview(@Param('courseId') courseId: string) {
    return this.publishing.transition(courseId, 'in_review');
  }

  /**
   * FR-PUB-02. §9.2: `202`, or `422` with the checklist failures.
   *
   * 202 rather than 201 because NFR-04 forbids an HTTP request waiting on the
   * run: the body carries the job id to watch, not a published course.
   */
  @Post(':courseId/publish')
  @HttpCode(202)
  @RequirePermission('publishOrUnpublishCourse')
  publish(@Param('courseId') courseId: string, @Req() request: RequestWithSession) {
    return this.publishing.requestPublish(courseId, { userId: request.sessionContext!.userId });
  }

  /**
   * The reviewer's half of the handoff — §4.2 draws no edge for it.
   *
   * Owner-only: §3 gives review authority to the owner alone, and sending work
   * back is a review verdict. Without this an owner who finds a problem can only
   * publish anyway, and `in_review` becomes a state only a publish can leave.
   */
  @Post(':courseId/return-to-draft')
  @RequirePermission('publishOrUnpublishCourse')
  returnToDraft(@Param('courseId') courseId: string) {
    return this.publishing.transition(courseId, 'draft');
  }

  /**
   * FR-PUB-04 §9.2. Removes the course from the catalog and WRITES NOTHING ELSE.
   *
   * The snapshot row, both published lesson columns, every access_grant and
   * every lesson_progress row are untouched — which is what makes the
   * preservation guarantee structural rather than a promise. Republishing runs
   * the full checklist and the full job, because the draft may have been edited
   * while the course was withdrawn and a status flip would serve content the
   * checklist never saw.
   */
  @Post(':courseId/unpublish')
  @RequirePermission('publishOrUnpublishCourse')
  unpublish(@Param('courseId') courseId: string) {
    return this.publishing.transition(courseId, 'unpublished');
  }

  /**
   * §4.2's terminal state. Reachable only from `unpublished`, per its diagram:
   * archiving a live course would hide it from admin lists while it still served
   * learners.
   */
  @Post(':courseId/archive')
  @RequirePermission('publishOrUnpublishCourse')
  archive(@Param('courseId') courseId: string) {
    return this.publishing.transition(courseId, 'archived');
  }
}
