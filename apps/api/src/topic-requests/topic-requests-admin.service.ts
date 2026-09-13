import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { errorCodes, type RequestStatus } from '@knowledge-explorer/shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * §9.2's review queue — `reviewTopicRequests`, owner only by §3.
 *
 * Deliberately apart from apps/api/src/public/topic-requests.service.ts. That
 * file serves an anonymous page and must never select a user relation; this one
 * exists precisely to show the owner who asked, so the owner can recognise one
 * person filing five variations of the same topic. Keeping them in separate
 * services means the board cannot accidentally reuse a query written for the
 * queue — which is the single realistic way an email reaches a public page.
 *
 * R-01 AND R-02 DO NOT APPLY HERE, and their absence is not an oversight.
 * PublishedLockGuard and AssignmentGuard both resolve a course from the write
 * target through WriteTargetResolver; a topic request has no course. Setting
 * `linked_course_id` to a PUBLISHED course is not a write to that course, so
 * R-01 does not fire even then.
 */

const PENDING = 'pending';
const DUPLICATED = 'duplicated';

export const DEFAULT_QUEUE_PAGE_SIZE = 20;
export const MAX_QUEUE_PAGE_SIZE = 100;

export interface QueueRowView {
  readonly id: string;
  readonly requestedTopicTitle: string;
  readonly requestDescription: string | null;
  readonly requestStatus: RequestStatus;
  readonly upvoteCount: number;
  readonly createdAt: string;
  readonly reviewerNote: string | null;
  /** Owner-only. The board serializes no identity at all; this is the exception §3 allows. */
  readonly requestedByEmail: string;
  readonly linkedCourse: { readonly id: string; readonly slug: string; readonly title: string } | null;
  readonly duplicateOf: { readonly id: string; readonly requestedTopicTitle: string } | null;
}

/**
 * Courses the owner may link an accepted request to.
 *
 * Carried on the queue response rather than fetched from §9.4's `/courses`,
 * because that endpoint deliberately exposes slugs and not internal ids — the
 * public catalog has no business handing out primary keys — and
 * `linked_course_id` is an id. A separate admin course-list endpoint would be
 * new §9 surface for one picker.
 *
 * Unpublished courses are included: the owner may accept a request for a course
 * that is built but not yet live. The BOARD still renders no link until it is
 * published, which is the §4.3 behaviour the learner sees.
 *
 * BOUNDED AND SEARCHABLE, not a dump of the table. The development database
 * already holds three thousand courses, so a fixed top-N picker is guaranteed
 * not to contain the one the owner wants. Default order is newest first —
 * accepting a request usually follows publishing the course that answers it —
 * and `courseSearch` covers everything older.
 */
export interface CourseOption {
  readonly id: string;
  readonly title: string;
  readonly levelLabel: string;
  readonly publicationStatus: string;
}

export interface QueueView {
  readonly items: readonly QueueRowView[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly courseOptions: readonly CourseOption[];
}

export interface QueueQuery {
  readonly status: RequestStatus | 'all';
  readonly sort: 'upvotes' | 'newest';
  readonly page: number;
  readonly pageSize: number;
  /** Filters `courseOptions` only; the request list is unaffected. */
  readonly courseSearch?: string | undefined;
}

export const MAX_COURSE_OPTIONS = 50;

export interface ReviewInput {
  readonly requestStatus: RequestStatus;
  readonly reviewerNote?: string | undefined;
  readonly linkedCourseId?: string | undefined;
  readonly duplicateOfRequestId?: string | undefined;
}

const QUEUE_SELECT = {
  id: true,
  requestedTopicTitle: true,
  requestDescription: true,
  requestStatus: true,
  upvoteCount: true,
  reviewerNote: true,
  createdAt: true,
  requestedByUser: { select: { email: true } },
  linkedCourse: { select: { id: true, slug: true, title: true } },
  duplicateOfRequest: { select: { id: true, requestedTopicTitle: true } },
} as const;

@Injectable()
export class TopicRequestsAdminService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async queue(query: QueueQuery): Promise<QueueView> {
    const where = query.status === 'all' ? {} : { requestStatus: query.status };
    const orderBy =
      query.sort === 'newest'
        ? [{ createdAt: 'desc' as const }]
        : [{ upvoteCount: 'desc' as const }, { createdAt: 'desc' as const }];

    const [rows, total, courseOptions] = await Promise.all([
      this.prisma.client.topicRequest.findMany({
        where,
        select: QUEUE_SELECT,
        orderBy,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.client.topicRequest.count({ where }),
      this.prisma.client.course.findMany({
        // Courses are not soft-deleted — only chapters and lessons carry deleted_at.
        where: query.courseSearch
          ? { title: { contains: query.courseSearch, mode: 'insensitive' } }
          : {},
        select: { id: true, title: true, levelLabel: true, publicationStatus: true },
        // Newest first: the course that answers a request is usually the one
        // just published. Anything older is reached through courseSearch.
        orderBy: { createdAt: 'desc' },
        take: MAX_COURSE_OPTIONS,
      }),
    ]);

    return {
      items: rows.map((row) => ({
        id: row.id,
        requestedTopicTitle: row.requestedTopicTitle,
        requestDescription: row.requestDescription,
        requestStatus: row.requestStatus as RequestStatus,
        upvoteCount: row.upvoteCount,
        createdAt: row.createdAt.toISOString(),
        reviewerNote: row.reviewerNote,
        requestedByEmail: row.requestedByUser.email,
        linkedCourse: row.linkedCourse,
        duplicateOf: row.duplicateOfRequest,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
      courseOptions,
    };
  }

  /**
   * §9.2: accept, reject, mark duplicate, or reopen.
   *
   * Cross-field rules live here rather than in a zod refinement because each one
   * needs its OWN error code — a discriminated union would collapse "you did not
   * say what it duplicates" and "you did not say why you rejected it" into one
   * generic parse failure, and the screen could not tell the owner which.
   *
   * EVERY rule is checked before anything is written, so a refused review writes
   * neither field. That is OwnerFieldGuard's principle — refuse the whole
   * request rather than apply the valid half — applied where no guard can see:
   * these fields are conditional on each other, not on the caller's role.
   */
  async review(requestId: string, reviewerId: string, input: ReviewInput): Promise<QueueRowView> {
    const existing = await this.prisma.client.topicRequest.findUnique({
      where: { id: requestId },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException({ errorCode: errorCodes.TOPIC_REQUEST_NOT_FOUND });
    }

    await this.assertConsistent(requestId, input);

    const row = await this.prisma.client.topicRequest.update({
      where: { id: requestId },
      data: {
        requestStatus: input.requestStatus,
        reviewedByUserId: reviewerId,
        // Reopening clears the whole ruling. A pending request carrying a stale
        // note reads as a decision that was not made.
        reviewerNote: input.requestStatus === PENDING ? null : (input.reviewerNote ?? null),
        linkedCourseId: input.requestStatus === 'accepted' ? (input.linkedCourseId ?? null) : null,
        duplicateOfRequestId:
          input.requestStatus === DUPLICATED ? (input.duplicateOfRequestId ?? null) : null,
      },
      select: QUEUE_SELECT,
    });

    return {
      id: row.id,
      requestedTopicTitle: row.requestedTopicTitle,
      requestDescription: row.requestDescription,
      requestStatus: row.requestStatus as RequestStatus,
      upvoteCount: row.upvoteCount,
      createdAt: row.createdAt.toISOString(),
      reviewerNote: row.reviewerNote,
      requestedByEmail: row.requestedByUser.email,
      linkedCourse: row.linkedCourse,
      duplicateOf: row.duplicateOfRequest,
    };
  }

  private async assertConsistent(requestId: string, input: ReviewInput): Promise<void> {
    const { requestStatus, reviewerNote, linkedCourseId, duplicateOfRequestId } = input;

    if (requestStatus === 'rejected' && !reviewerNote) {
      throw new BadRequestException({ errorCode: errorCodes.TOPIC_REQUEST_NOTE_REQUIRED });
    }

    /**
     * A field that does not belong with the chosen status is a malformed body,
     * not a missing course — so it reports INVALID_BODY, the same code the
     * controller's zod failure uses. Reusing LINKED_COURSE_NOT_FOUND here would
     * tell a client the course is gone when it is perfectly fine.
     */
    if (requestStatus !== 'accepted' && linkedCourseId) {
      throw new BadRequestException({
        errorCode: 'INVALID_BODY',
        message: 'linkedCourseId is only meaningful on an accepted request.',
      });
    }
    if (linkedCourseId) {
      const course = await this.prisma.client.course.findUnique({
        where: { id: linkedCourseId },
        select: { id: true },
      });
      if (!course) {
        throw new BadRequestException({
          errorCode: errorCodes.TOPIC_REQUEST_LINKED_COURSE_NOT_FOUND,
        });
      }
    }

    if (requestStatus !== DUPLICATED && duplicateOfRequestId) {
      throw new BadRequestException({
        errorCode: 'INVALID_BODY',
        message: 'duplicateOfRequestId is only meaningful on a duplicated request.',
      });
    }
    if (requestStatus === DUPLICATED) {
      if (!duplicateOfRequestId) {
        throw new BadRequestException({
          errorCode: errorCodes.TOPIC_REQUEST_DUPLICATE_TARGET_REQUIRED,
        });
      }
      if (duplicateOfRequestId === requestId) {
        throw new BadRequestException({
          errorCode: errorCodes.TOPIC_REQUEST_DUPLICATE_TARGET_INVALID,
        });
      }
      const target = await this.prisma.client.topicRequest.findUnique({
        where: { id: duplicateOfRequestId },
        select: { requestStatus: true },
      });
      // No chains: a duplicate of a duplicate would make "the original" a walk
      // rather than a lookup, and the queue renders one hop.
      if (!target || target.requestStatus === DUPLICATED) {
        throw new BadRequestException({
          errorCode: errorCodes.TOPIC_REQUEST_DUPLICATE_TARGET_INVALID,
        });
      }
    }
  }
}
