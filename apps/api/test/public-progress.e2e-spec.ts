import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { getPrismaClient } from '@knowledge-explorer/database';
import { AppModule } from '../src/app.module';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * FR-LRN-02, FR-LRN-03 and §9.4's `/me/courses`.
 *
 * Two properties carry most of the weight here, and both are §7.4's:
 *   - progress is never deleted on expiry, and
 *   - an expired course stays listed, with its progress, rather than vanishing.
 * "Preserved progress is the strongest reason a learner renews", so losing it
 * on expiry would be a revenue bug wearing a data-cleanup costume.
 */

const run = randomBytes(4).toString('hex');
const prisma = getPrismaClient();
const api = () => request(app.getHttpServer());
const DAY = 24 * 60 * 60 * 1000;

const asLearner = (token: string) => ({ Cookie: `authjs.learner-session-token=${token}` });

let app: INestApplication;
let ownerId = '';
let learnerId = '';
let learnerToken = '';
let ownerToken = '';
let adminToken = '';
let categoryId = '';
let courseId = '';
let lessonIds: string[] = [];
let grantId = '';

async function seedUser(local: string, userRole: string): Promise<[string, string]> {
  const user = await prisma.user.create({
    data: { email: `${local}-prog-${run}@example.test`, name: local, userRole },
    select: { id: true },
  });
  const sessionToken = `tok-prog-${run}-${randomBytes(6).toString('hex')}`;
  await prisma.session.create({
    data: { sessionToken, userId: user.id, expires: new Date(Date.now() + 3_600_000) },
  });
  return [user.id, sessionToken];
}

beforeAll(async () => {
  [ownerId, ownerToken] = await seedUser('owner', 'admin_owner');
  [learnerId, learnerToken] = await seedUser('learner', 'learner');
  [, adminToken] = await seedUser('admin', 'admin');

  const category = await prisma.category.create({
    data: { slug: `prog-${run}`, displayName: `Tiến độ ${run}` },
    select: { id: true },
  });
  categoryId = category.id;

  const course = await prisma.course.create({
    data: {
      categoryId,
      slug: `prog-${run}-course`,
      levelLabel: 'N5',
      levelOrder: 1,
      title: 'Khoá tiến độ',
      pricingType: 'paid',
      publicationStatus: 'published',
      publishedAt: new Date(),
    },
    select: { id: true },
  });
  courseId = course.id;

  const chapter = await prisma.chapter.create({
    data: { courseId, chapterOrder: 1, title: 'Chương 1' },
    select: { id: true },
  });

  for (const order of [1, 2, 3, 4]) {
    const lesson = await prisma.lesson.create({
      data: { chapterId: chapter.id, lessonOrder: order, title: `Bài ${order}`, estimatedMinutes: 10 },
      select: { id: true },
    });
    await prisma.lessonContent.create({
      data: {
        lessonId: lesson.id,
        publishedContentMarkdown: `# Bài ${order}\n\nNội dung.\n`,
        publishedBlockList: { blocks: [], nextBlockSeq: 1 } as object,
        publishedAt: new Date(),
      },
    });
    lessonIds.push(lesson.id);
  }

  await prisma.publishedCourseStructure.create({
    data: {
      courseId,
      publishedVersionNumber: 1,
      totalLessonCount: lessonIds.length,
      publishedByUserId: ownerId,
      structurePayload: {
        courseId,
        publishedVersionNumber: 1,
        totalLessonCount: lessonIds.length,
        chapters: [
          {
            chapterId: chapter.id,
            order: 1,
            title: 'Chương 1',
            description: null,
            lessons: lessonIds.map((lessonId, index) => ({
              lessonId,
              order: index + 1,
              title: `Bài ${index + 1}`,
              estimatedMinutes: 10,
              isFreePreview: false,
              hasAudio: false,
              audioDurationSeconds: null,
              figureCount: 0,
            })),
          },
        ],
      } as object,
    },
  });

  const grant = await prisma.accessGrant.create({
    data: {
      userId: learnerId,
      scopeType: 'course',
      scopeCourseId: courseId,
      accessSource: 'purchase',
      expiresAt: new Date(Date.now() + 30 * DAY),
    },
    select: { id: true },
  });
  grantId = grant.id;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api', { exclude: ['health'] });
  await app.init();
});

afterAll(async () => {
  await app?.close();
  await prisma.lessonProgress.deleteMany({ where: { userId: learnerId } });
  await prisma.accessGrant.deleteMany({ where: { userId: learnerId } });
  await prisma.publishedCourseStructure.deleteMany({ where: { courseId } });
  await prisma.course.deleteMany({ where: { id: courseId } });
  await prisma.category.deleteMany({ where: { id: categoryId } });
  await prisma.user.deleteMany({
    where: { email: { contains: `-prog-${run}@example.test` } },
  });
});

beforeEach(async () => {
  await prisma.lessonProgress.deleteMany({ where: { userId: learnerId } });
  await prisma.accessGrant.update({
    where: { id: grantId },
    data: { expiresAt: new Date(Date.now() + 30 * DAY), gracePeriodDays: 0 },
  });
});

const putProgress = (lessonId: string, body: object, token = learnerToken) =>
  api().put(`/api/lessons/${lessonId}/progress`).set(asLearner(token)).send(body);

describe('FR-LRN-02: the progress write', () => {
  it('upserts on (userId, lessonId)', async () => {
    await putProgress(lessonIds[0]!, {
      completed: false,
      scrollPercentage: 40,
      audioPositionMs: 8_000,
    }).expect(200);

    await putProgress(lessonIds[0]!, {
      completed: false,
      scrollPercentage: 75,
      audioPositionMs: 20_000,
    }).expect(200);

    const rows = await prisma.lessonProgress.findMany({
      where: { userId: learnerId, lessonId: lessonIds[0]! },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lastScrollPercentage).toBe(75);
    expect(rows[0]?.lastAudioPositionMs).toBe(20_000);
    expect(rows[0]?.progressStatus).toBe('in_progress');
  });

  it('records completion with a timestamp', async () => {
    await putProgress(lessonIds[0]!, {
      completed: true,
      scrollPercentage: 100,
      audioPositionMs: 0,
    }).expect(200);

    const row = await prisma.lessonProgress.findUniqueOrThrow({
      where: { userId_lessonId: { userId: learnerId, lessonId: lessonIds[0]! } },
    });
    expect(row.progressStatus).toBe('completed');
    expect(row.completedAt).not.toBeNull();
  });

  it('refuses a scroll percentage outside the column range', async () => {
    // §8 stores this as SMALLINT 0-100; the schema is the source of the bound.
    await putProgress(lessonIds[0]!, {
      completed: false,
      scrollPercentage: 120,
      audioPositionMs: 0,
    }).expect(400);
  });

  it('refuses an unknown field rather than ignoring it', async () => {
    await putProgress(lessonIds[0]!, {
      completed: false,
      scrollPercentage: 10,
      audioPositionMs: 0,
      lastPage: 3,
    }).expect(400);
  });
});

describe('§3: progress is learner-only, and entitlement-gated on top', () => {
  it('refuses an owner with FORBIDDEN_ROLE', async () => {
    // buyAccessReadListenTrackProgress is learner-only in §3 — admin_owner and
    // admin are both false. The locked matrix, asserted rather than worked
    // around.
    const response = await putProgress(
      lessonIds[0]!,
      { completed: true, scrollPercentage: 0, audioPositionMs: 0 },
      ownerToken,
    ).expect(403);
    expect((response.body as { errorCode: string }).errorCode).toBe('FORBIDDEN_ROLE');
  });

  it('refuses an admin with FORBIDDEN_ROLE', async () => {
    await putProgress(
      lessonIds[0]!,
      { completed: true, scrollPercentage: 0, audioPositionMs: 0 },
      adminToken,
    ).expect(403);
  });

  it('refuses an anonymous caller', async () => {
    await api()
      .put(`/api/lessons/${lessonIds[0]!}/progress`)
      .send({ completed: true, scrollPercentage: 0, audioPositionMs: 0 })
      .expect(401);
  });

  it('refuses a lesson the learner may no longer read', async () => {
    // Without this gate an expired learner could keep marking lessons complete
    // in a course they cannot open — §7.3 bypassed through a write path.
    await prisma.accessGrant.update({
      where: { id: grantId },
      data: { expiresAt: new Date(Date.now() - DAY) },
    });

    const response = await putProgress(lessonIds[0]!, {
      completed: true,
      scrollPercentage: 0,
      audioPositionMs: 0,
    }).expect(403);
    expect((response.body as { errorCode: string }).errorCode).toBe('LESSON_NOT_ENTITLED');
  });
});

describe('FR-LRN-03 and §9.4: /me/courses', () => {
  const myCourses = (token = learnerToken) =>
    api().get('/api/me/courses').set(asLearner(token)).expect(200);

  it('computes the percentage over the snapshot lesson count', async () => {
    await putProgress(lessonIds[0]!, { completed: true, scrollPercentage: 100, audioPositionMs: 0 });
    await putProgress(lessonIds[1]!, { completed: true, scrollPercentage: 100, audioPositionMs: 0 });

    const response = await myCourses();
    const course = (response.body as { courseSlug: string; progressPercentage: number; totalLessonCount: number }[])
      .find((row) => row.courseSlug === `prog-${run}-course`);

    // 2 of 4, and the denominator is the snapshot's — the same number the table
    // of contents shows the learner.
    expect(course?.totalLessonCount).toBe(4);
    expect(course?.progressPercentage).toBe(50);
  });

  it('reports daysRemaining and the resume target', async () => {
    await putProgress(lessonIds[2]!, { completed: false, scrollPercentage: 30, audioPositionMs: 0 });

    const response = await myCourses();
    const course = (response.body as { courseSlug: string; daysRemaining: number; resumeLessonId: string }[])
      .find((row) => row.courseSlug === `prog-${run}-course`);

    expect(course?.daysRemaining).toBeGreaterThan(28);
    expect(course?.resumeLessonId).toBe(lessonIds[2]!);
  });

  it('§7.4: keeps an expired course listed, with its progress intact', async () => {
    await putProgress(lessonIds[0]!, { completed: true, scrollPercentage: 100, audioPositionMs: 0 });
    await prisma.accessGrant.update({
      where: { id: grantId },
      data: { expiresAt: new Date(Date.now() - DAY) },
    });

    const response = await myCourses();
    const course = (response.body as { courseSlug: string; isExpired: boolean; progressPercentage: number }[])
      .find((row) => row.courseSlug === `prog-${run}-course`);

    // "It is not hidden." Progress is what brings the learner back to renew.
    expect(course).toBeDefined();
    expect(course?.isExpired).toBe(true);
    expect(course?.progressPercentage).toBe(25);

    // E-02: nothing wrote an "expired" status anywhere; it is computed on read.
    const grant = await prisma.accessGrant.findUniqueOrThrow({ where: { id: grantId } });
    expect(grant.revokedAt).toBeNull();
  });

  it('never deletes progress on expiry', async () => {
    await putProgress(lessonIds[0]!, { completed: true, scrollPercentage: 100, audioPositionMs: 0 });
    await prisma.accessGrant.update({
      where: { id: grantId },
      data: { expiresAt: new Date(Date.now() - 400 * DAY) },
    });

    await myCourses();
    const rows = await prisma.lessonProgress.findMany({ where: { userId: learnerId } });
    expect(rows.length).toBeGreaterThan(0);
  });

  it('honours a grace period before calling a course expired', async () => {
    await prisma.accessGrant.update({
      where: { id: grantId },
      data: { expiresAt: new Date(Date.now() - 2 * DAY), gracePeriodDays: 5 },
    });

    const response = await myCourses();
    const course = (response.body as { courseSlug: string; isExpired: boolean }[]).find(
      (row) => row.courseSlug === `prog-${run}-course`,
    );
    expect(course?.isExpired).toBe(false);
  });

  it('refuses an owner with FORBIDDEN_ROLE', async () => {
    await api().get('/api/me/courses').set(asLearner(ownerToken)).expect(403);
  });

  it('refuses an anonymous caller', async () => {
    await api().get('/api/me/courses').expect(401);
  });
});
