import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { getPrismaClient } from '@knowledge-explorer/database';
import { hasAccessToCourse, hasAccessToLesson, isGrantActive } from '../src/entitlement';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * §7.3 entitlement resolution — the unit half of specs/p7-learner/spec.md's
 * verification. The endpoint half, which E-01 requires, is
 * apps/api/test/entitlement-gates.e2e-spec.ts.
 */

const run = randomBytes(4).toString('hex');
const prisma = getPrismaClient();

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-09-13T12:00:00.000Z');

let categoryId = '';
let otherCategoryId = '';
let paidCourseId = '';
let freeCourseId = '';
let otherCategoryCourseId = '';
let paidLessonId = '';
let previewLessonId = '';
let deletedLessonId = '';
let freeLessonId = '';
let learnerId = '';

async function seedCourse(
  suffix: string,
  pricingType: string,
  inCategoryId: string,
): Promise<string> {
  const course = await prisma.course.create({
    data: {
      categoryId: inCategoryId,
      slug: `ent-${suffix}-${run}`,
      levelLabel: suffix,
      levelOrder: Math.floor(Math.random() * 1_000_000),
      title: `Entitlement ${suffix}`,
      pricingType,
    },
    select: { id: true },
  });
  return course.id;
}

async function seedLesson(
  courseId: string,
  options: { isFreePreview?: boolean; deleted?: boolean } = {},
): Promise<string> {
  const chapter = await prisma.chapter.create({
    data: { courseId, chapterOrder: Math.floor(Math.random() * 1_000_000), title: 'Chapter' },
    select: { id: true },
  });
  const lesson = await prisma.lesson.create({
    data: {
      chapterId: chapter.id,
      lessonOrder: 1,
      title: 'Lesson',
      isFreePreview: options.isFreePreview ?? false,
      deletedAt: options.deleted ? new Date() : null,
    },
    select: { id: true },
  });
  return lesson.id;
}

/** One grant, scoped however the case needs it, cleaned up by the caller. */
async function grant(data: {
  scopeType: 'course' | 'category';
  scopeCourseId?: string;
  scopeCategoryId?: string;
  expiresAt?: Date | null;
  gracePeriodDays?: number;
  revokedAt?: Date | null;
}): Promise<string> {
  const row = await prisma.accessGrant.create({
    data: {
      userId: learnerId,
      scopeType: data.scopeType,
      scopeCourseId: data.scopeCourseId ?? null,
      scopeCategoryId: data.scopeCategoryId ?? null,
      accessSource: 'granted_by_owner',
      expiresAt: data.expiresAt === undefined ? new Date(Date.now() + 30 * DAY) : data.expiresAt,
      gracePeriodDays: data.gracePeriodDays ?? 0,
      revokedAt: data.revokedAt ?? null,
    },
    select: { id: true },
  });
  return row.id;
}

beforeAll(async () => {
  const category = await prisma.category.create({
    data: { slug: `ent-cat-${run}`, displayName: 'Entitlement' },
    select: { id: true },
  });
  categoryId = category.id;

  const otherCategory = await prisma.category.create({
    data: { slug: `ent-other-${run}`, displayName: 'Other' },
    select: { id: true },
  });
  otherCategoryId = otherCategory.id;

  paidCourseId = await seedCourse('paid', 'paid', categoryId);
  freeCourseId = await seedCourse('free', 'free', categoryId);
  otherCategoryCourseId = await seedCourse('other', 'paid', otherCategoryId);

  paidLessonId = await seedLesson(paidCourseId);
  previewLessonId = await seedLesson(paidCourseId, { isFreePreview: true });
  deletedLessonId = await seedLesson(paidCourseId, { isFreePreview: true, deleted: true });
  freeLessonId = await seedLesson(freeCourseId);

  const learner = await prisma.user.create({
    data: { email: `learner-ent-${run}@example.test`, name: 'Learner', userRole: 'learner' },
    select: { id: true },
  });
  learnerId = learner.id;
});

afterAll(async () => {
  await prisma.accessGrant.deleteMany({ where: { userId: learnerId } });
  await prisma.course.deleteMany({
    where: { id: { in: [paidCourseId, freeCourseId, otherCategoryCourseId] } },
  });
  await prisma.category.deleteMany({ where: { id: { in: [categoryId, otherCategoryId] } } });
  await prisma.user.delete({ where: { id: learnerId } });
});

/**
 * The pure predicate. No database, and an injected clock, so the grace-period
 * boundary is asserted from both sides rather than waited for.
 */
describe('isGrantActive', () => {
  it('refuses a revoked grant whose expiry is still far in the future', () => {
    // FR-COM-04: revocation takes effect on the next request. If revokedAt were
    // checked after expiresAt this case would pass and revocation would only
    // work on grants that had already lapsed.
    expect(
      isGrantActive(
        { revokedAt: new Date(now.getTime() - DAY), expiresAt: new Date(now.getTime() + 300 * DAY), gracePeriodDays: 0 },
        now,
      ),
    ).toBe(false);
  });

  it('allows a perpetual grant', () => {
    // §7.2: expiresAt is NULL only for owner-granted perpetual access.
    expect(isGrantActive({ revokedAt: null, expiresAt: null, gracePeriodDays: 0 }, now)).toBe(true);
  });

  it('refuses a perpetual grant that was revoked', () => {
    expect(isGrantActive({ revokedAt: now, expiresAt: null, gracePeriodDays: 0 }, now)).toBe(false);
  });

  it('allows an unexpired grant', () => {
    expect(
      isGrantActive({ revokedAt: null, expiresAt: new Date(now.getTime() + DAY), gracePeriodDays: 0 }, now),
    ).toBe(true);
  });

  it('refuses an expired grant with no grace period', () => {
    // §14 decision 2 leaves gracePeriodDays defaulting to 0, so this is today's
    // ordinary case rather than an edge one.
    expect(
      isGrantActive({ revokedAt: null, expiresAt: new Date(now.getTime() - DAY), gracePeriodDays: 0 }, now),
    ).toBe(false);
  });

  it('allows an expired grant still inside its grace period', () => {
    expect(
      isGrantActive({ revokedAt: null, expiresAt: new Date(now.getTime() - 2 * DAY), gracePeriodDays: 5 }, now),
    ).toBe(true);
  });

  it('refuses an expired grant once its grace period has passed', () => {
    expect(
      isGrantActive({ revokedAt: null, expiresAt: new Date(now.getTime() - 6 * DAY), gracePeriodDays: 5 }, now),
    ).toBe(false);
  });

  it('treats the grace boundary as exclusive', () => {
    // §7.3 is `>`, not `>=`: at the exact instant grace runs out, access ends.
    const expiresAt = new Date(now.getTime() - 5 * DAY);
    expect(isGrantActive({ revokedAt: null, expiresAt, gracePeriodDays: 5 }, now)).toBe(false);
  });
});

describe('hasAccessToCourse', () => {
  it('allows anyone into a free course, including an anonymous caller', async () => {
    // §7.3 returns before consulting userId at all.
    expect(await hasAccessToCourse(prisma, null, freeCourseId)).toBe(true);
    expect(await hasAccessToCourse(prisma, learnerId, freeCourseId)).toBe(true);
  });

  it('refuses an anonymous caller on a paid course', async () => {
    expect(await hasAccessToCourse(prisma, null, paidCourseId)).toBe(false);
  });

  it('refuses a signed-in learner holding no grant', async () => {
    expect(await hasAccessToCourse(prisma, learnerId, paidCourseId)).toBe(false);
  });

  it('allows a course-scoped grant', async () => {
    const id = await grant({ scopeType: 'course', scopeCourseId: paidCourseId });
    expect(await hasAccessToCourse(prisma, learnerId, paidCourseId)).toBe(true);
    await prisma.accessGrant.delete({ where: { id } });
  });

  it('allows a category-scoped grant to cover a course in that category', async () => {
    // §7.2's all_current_and_future policy, which needs no code: the match is on
    // the course's current category_id.
    const id = await grant({ scopeType: 'category', scopeCategoryId: categoryId });
    expect(await hasAccessToCourse(prisma, learnerId, paidCourseId)).toBe(true);
    expect(await hasAccessToCourse(prisma, learnerId, otherCategoryCourseId)).toBe(false);
    await prisma.accessGrant.delete({ where: { id } });
  });

  it('covers a course created after the category grant was written', async () => {
    const id = await grant({ scopeType: 'category', scopeCategoryId: categoryId });
    const laterCourseId = await seedCourse('later', 'paid', categoryId);
    expect(await hasAccessToCourse(prisma, learnerId, laterCourseId)).toBe(true);
    await prisma.course.delete({ where: { id: laterCourseId } });
    await prisma.accessGrant.delete({ where: { id } });
  });

  it('refuses an expired grant and a revoked one', async () => {
    const expired = await grant({
      scopeType: 'course',
      scopeCourseId: paidCourseId,
      expiresAt: new Date(Date.now() - DAY),
    });
    expect(await hasAccessToCourse(prisma, learnerId, paidCourseId)).toBe(false);
    await prisma.accessGrant.delete({ where: { id: expired } });

    const revoked = await grant({
      scopeType: 'course',
      scopeCourseId: paidCourseId,
      revokedAt: new Date(),
    });
    expect(await hasAccessToCourse(prisma, learnerId, paidCourseId)).toBe(false);
    await prisma.accessGrant.delete({ where: { id: revoked } });
  });

  it('refuses a course that does not exist', async () => {
    expect(await hasAccessToCourse(prisma, learnerId, '00000000-0000-0000-0000-000000000000')).toBe(
      false,
    );
  });
});

describe('hasAccessToLesson', () => {
  it('allows a free-preview lesson to anyone, with no grant', async () => {
    // FR-LRN-01, and the branch §7.3 takes before any grant lookup.
    expect(await hasAccessToLesson(prisma, null, previewLessonId)).toBe(true);
    expect(await hasAccessToLesson(prisma, learnerId, previewLessonId)).toBe(true);
  });

  it('refuses a paid lesson to a learner holding no grant', async () => {
    expect(await hasAccessToLesson(prisma, learnerId, paidLessonId)).toBe(false);
  });

  it('allows a paid lesson once a grant covers its course', async () => {
    const id = await grant({ scopeType: 'course', scopeCourseId: paidCourseId });
    expect(await hasAccessToLesson(prisma, learnerId, paidLessonId)).toBe(true);
    await prisma.accessGrant.delete({ where: { id } });
  });

  it('allows any lesson of a free course', async () => {
    expect(await hasAccessToLesson(prisma, null, freeLessonId)).toBe(true);
  });

  it('refuses a soft-deleted lesson even when it is a free preview', async () => {
    // §4.3 keeps deleted lessons in the last published snapshot, so a table of
    // contents can still name one. Serving its body would undo the delete.
    expect(await hasAccessToLesson(prisma, learnerId, deletedLessonId)).toBe(false);
  });

  it('refuses a lesson that does not exist', async () => {
    expect(await hasAccessToLesson(prisma, learnerId, '00000000-0000-0000-0000-000000000000')).toBe(
      false,
    );
  });
});
