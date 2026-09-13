import type { PrismaClient } from '@knowledge-explorer/database';

/**
 * §7.3's entitlement resolution, and the only place an access decision is made.
 *
 * It lives here for the reason §3 lives once in `packages/shared/src/roles.ts`:
 * a rule recorded twice drifts, and this particular rule is the one E-01 calls
 * out by name — "`hasAccessToLesson` must gate BOTH `GET /lessons/:lessonId`
 * and `GET /media/:mediaId/signed-url`. Missing either one leaks paid audio."
 * A second access check written into a controller or a page is that leak.
 *
 * READS ONLY. E-02 rejects materializing expiry into a status column, so
 * nothing here writes: "if the job stalls, expired learners keep access, and if
 * it over-runs, paying learners lose it."
 *
 * §11 assigns this package `PaymentProvider` as well. That half is P8's; P7
 * fills only the entitlement half.
 */

/** The grant fields §7.3's predicate reads, and nothing more. */
export interface GrantWindow {
  readonly revokedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly gracePeriodDays: number;
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

const addDays = (date: Date, days: number): Date =>
  new Date(date.getTime() + days * MILLISECONDS_PER_DAY);

/**
 * §7.3, verbatim in behaviour.
 *
 * REVOCATION IS CHECKED FIRST, and the order is load-bearing rather than
 * stylistic: FR-COM-04 says revocation "takes effect on the next request", so a
 * revoked grant must be refused even while its `expiresAt` is still comfortably
 * in the future. Reversing these two lines would make revocation reachable only
 * once the grant had expired anyway.
 *
 * `expiresAt === null` is perpetual access, which §7.2 permits for
 * `granted_by_owner` alone. Nothing here enforces that restriction — it is a
 * property of how the row was written, and P8 owns the writer.
 *
 * Takes a clock rather than calling `Date.now()`, so the grace-period boundary
 * is testable from both sides without waiting for it.
 */
export function isGrantActive(grant: GrantWindow, now: Date): boolean {
  if (grant.revokedAt) return false;
  if (grant.expiresAt === null) return true;
  return addDays(grant.expiresAt, grant.gracePeriodDays) > now;
}

/**
 * §7.3's `hasAccessToCourse`.
 *
 * `userId` is nullable because §7.3 itself never consults it for a free course:
 * the `pricingType === 'free'` branch returns before any grant lookup. Anonymous
 * access to free content is therefore what the specification computes, not an
 * addition P7 made — and a `null` caller that reaches the lookup simply matches
 * no grants.
 *
 * §7.2's bundle policy is locked to `all_current_and_future`, and it needs no
 * code: a category-scoped grant is matched by the course's CURRENT
 * `category_id` at read time, so a course published after the grant was bought
 * is covered with no job and no backfill. "No job updates grants when a new
 * course is published."
 */
export async function hasAccessToCourse(
  prisma: PrismaClient,
  userId: string | null,
  courseId: string,
): Promise<boolean> {
  const course = await prisma.course.findUnique({
    where: { id: courseId },
    select: { id: true, categoryId: true, pricingType: true },
  });
  if (!course) return false;
  if (course.pricingType === 'free') return true;
  if (!userId) return false;

  return hasActiveGrant(prisma, userId, course.id, course.categoryId);
}

/**
 * §7.3's `hasAccessToLesson`.
 *
 * §7.3 writes `lesson.courseId`; §8 puts no such column on `lessons`, which
 * reach their course through `chapters`. The join is that bridge and nothing
 * more — the decision itself is unchanged.
 *
 * A soft-deleted lesson is refused rather than read. §4.3 keeps deleted lessons
 * in the last published snapshot until the next publish, so a table of contents
 * can still name one; serving its body would undo the delete.
 */
export async function hasAccessToLesson(
  prisma: PrismaClient,
  userId: string | null,
  lessonId: string,
): Promise<boolean> {
  const lesson = await prisma.lesson.findUnique({
    where: { id: lessonId },
    select: {
      isFreePreview: true,
      deletedAt: true,
      chapter: { select: { deletedAt: true, courseId: true } },
    },
  });
  if (!lesson || lesson.deletedAt || lesson.chapter.deletedAt) return false;
  if (lesson.isFreePreview) return true;

  return hasAccessToCourse(prisma, userId, lesson.chapter.courseId);
}

/**
 * §7.3's `hasActiveGrant`, over the two scopes a course can be reached by.
 *
 * §7.3's pseudocode passes `{ scopeType, scopeId }` pairs, but §8 gives
 * `access_grants` two nullable columns — `scope_course_id` and
 * `scope_category_id` — rather than one polymorphic id. The columns are read as
 * they are; inventing a synthetic `scopeId` here would put a second shape
 * between the specification and the schema for no gain.
 *
 * `isGrantActive` decides, not the query. Pushing expiry into SQL would put the
 * §7.3 predicate in two places, and the grace-period arithmetic is exactly the
 * part that must not be duplicated.
 */
async function hasActiveGrant(
  prisma: PrismaClient,
  userId: string,
  courseId: string,
  categoryId: string,
): Promise<boolean> {
  const grants = await prisma.accessGrant.findMany({
    where: {
      userId,
      OR: [
        { scopeType: 'course', scopeCourseId: courseId },
        { scopeType: 'category', scopeCategoryId: categoryId },
      ],
    },
    select: { revokedAt: true, expiresAt: true, gracePeriodDays: true },
  });

  const now = new Date();
  return grants.some((grant) => isGrantActive(grant, now));
}
