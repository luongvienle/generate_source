import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { getPrismaClient } from '@knowledge-explorer/database';
import { AppModule } from '../src/app.module';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * The two apps' session cookies, and why they are read separately.
 *
 * admin-web and learner-web both serve `localhost` in development and cookies
 * ignore port, so they cannot share a cookie name without overwriting each
 * other. Giving learner-web its own name solves that — but it would have been
 * tempting to add the new name to `SESSION_COOKIE_NAMES` and let one reader
 * accept all six. That is the failure this file exists to prevent:
 * `readSessionToken` returns the FIRST recognised cookie it meets while
 * scanning the header, so a request carrying both would resolve to whichever
 * the browser happened to serialise first — and identity would depend on
 * `Cookie` header order.
 *
 * Instead `readSessionToken` reads only admin-web's names and
 * `readLearnerSessionToken` only learner-web's. Every assertion below sends
 * both cookies in both orders and pins the result.
 */

const run = randomBytes(4).toString('hex');
const prisma = getPrismaClient();
const api = () => request(app.getHttpServer());

let app: INestApplication;
let ownerId = '';
let learnerId = '';
let ownerToken = '';
let learnerToken = '';
let categoryId = '';
let courseId = '';
let paidLessonId = '';

async function seedUser(local: string, userRole: string): Promise<[string, string]> {
  const user = await prisma.user.create({
    data: { email: `${local}-cookie-${run}@example.test`, name: local, userRole },
    select: { id: true },
  });
  const sessionToken = `tok-cookie-${run}-${randomBytes(6).toString('hex')}`;
  await prisma.session.create({
    data: { sessionToken, userId: user.id, expires: new Date(Date.now() + 3_600_000) },
  });
  return [user.id, sessionToken];
}

beforeAll(async () => {
  [ownerId, ownerToken] = await seedUser('owner', 'admin_owner');
  [learnerId, learnerToken] = await seedUser('learner', 'learner');

  const category = await prisma.category.create({
    data: { slug: `cookie-${run}`, displayName: 'Cookie' },
    select: { id: true },
  });
  categoryId = category.id;

  // A PAID course, so the reader's answer depends on WHO is resolved rather
  // than being 200 for everyone.
  const course = await prisma.course.create({
    data: {
      categoryId,
      slug: `cookie-${run}-course`,
      levelLabel: 'N1',
      levelOrder: 1,
      title: 'Khoá trả phí',
      pricingType: 'paid',
      publicationStatus: 'published',
      publishedAt: new Date(),
    },
    select: { id: true },
  });
  courseId = course.id;

  const chapter = await prisma.chapter.create({
    data: { courseId: course.id, chapterOrder: 1, title: 'Chương 1' },
    select: { id: true },
  });
  const lesson = await prisma.lesson.create({
    data: { chapterId: chapter.id, lessonOrder: 1, title: 'Bài 1' },
    select: { id: true },
  });
  paidLessonId = lesson.id;
  await prisma.lessonContent.create({
    data: {
      lessonId: lesson.id,
      publishedContentMarkdown: '# Bài 1\n\nNội dung.\n',
      publishedBlockList: { blocks: [], nextBlockSeq: 1 } as object,
      publishedAt: new Date(),
    },
  });

  // Only the learner holds a grant. The owner deliberately holds none.
  await prisma.accessGrant.create({
    data: {
      userId: learnerId,
      scopeType: 'course',
      scopeCourseId: course.id,
      accessSource: 'granted_by_owner',
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api', { exclude: ['health'] });
  await app.init();
});

afterAll(async () => {
  await app?.close();
  await prisma.accessGrant.deleteMany({ where: { userId: learnerId } });
  await prisma.course.deleteMany({ where: { id: courseId } });
  await prisma.category.deleteMany({ where: { id: categoryId } });
  await prisma.session.deleteMany({ where: { userId: { in: [ownerId, learnerId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, learnerId] } } });
});

describe('each endpoint reads its own cookie, whatever order they arrive in', () => {
  const adminFirst = () => ({
    Cookie: `authjs.session-token=${ownerToken}; authjs.learner-session-token=${learnerToken}`,
  });
  const learnerFirst = () => ({
    Cookie: `authjs.learner-session-token=${learnerToken}; authjs.session-token=${ownerToken}`,
  });

  it('resolves an admin endpoint to the owner in both orders', async () => {
    // /api/admin/admins requires manageAdminAccounts, which only admin_owner
    // holds — a 200 proves the OWNER was resolved and not the learner.
    await api().get('/api/admin/admins').set(adminFirst()).expect(200);
    await api().get('/api/admin/admins').set(learnerFirst()).expect(200);
  });

  it('resolves a public endpoint to the learner in both orders', async () => {
    // The learner holds the grant and the owner does not, so a 200 on a PAID
    // lesson proves the learner was resolved. Were the reader to accept the
    // admin cookie, the owner would resolve, hold no grant, and this would 403.
    await api().get(`/api/lessons/${paidLessonId}`).set(adminFirst()).expect(200);
    await api().get(`/api/lessons/${paidLessonId}`).set(learnerFirst()).expect(200);
  });

  it('treats a lone learner cookie as unauthenticated on an admin endpoint', async () => {
    await api()
      .get('/api/admin/admins')
      .set({ Cookie: `authjs.learner-session-token=${learnerToken}` })
      .expect(401);
  });

  it('treats a lone admin cookie as anonymous on a public endpoint', async () => {
    // The owner's session is real and valid, and the learner API still sees a
    // visitor — which is §3: the owner does not hold
    // buyAccessReadListenTrackProgress, and previewing unpublished work is
    // admin-web's job. A 403 rather than a 401: §7.3 answered, not the guard.
    const response = await api()
      .get(`/api/lessons/${paidLessonId}`)
      .set({ Cookie: `authjs.session-token=${ownerToken}` })
      .expect(403);
    expect((response.body as { errorCode: string }).errorCode).toBe('LESSON_NOT_ENTITLED');
  });
});
