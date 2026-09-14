import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { getPrismaClient } from '@knowledge-explorer/database';
import { blockListChecksum, parseLessonMarkdown } from '@knowledge-explorer/content';
import { vietnamDayEnd, vietnamToday } from '@knowledge-explorer/commerce';
import { AppModule } from '../src/app.module';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * FR-COM-04 — specs/p8a-commerce/spec.md, "Manual grants".
 *
 * Three properties here would pass a casual reading while being wrong:
 *
 *  - **revocation takes effect on the very next request.** Asserted against the
 *    real reader endpoint, not by reading the column back: a cached entitlement
 *    anywhere between the two would pass a column check and fail the learner.
 *  - **an expired-but-live grant is listed as inactive.** The list filters on
 *    `revoked_at` alone, and `isActive` must come from `isGrantActive` — a filter
 *    that silently dropped expired rows would hide exactly the grants an owner
 *    looks up to renew.
 *  - **today is a valid expiry date, yesterday is not**, in Asia/Ho_Chi_Minh.
 */

const run = randomBytes(4).toString('hex');
const prisma = getPrismaClient();
const api = () => request(app.getHttpServer());
const DAY = 86_400_000;

let app: INestApplication;
const users: Record<string, { id: string; token: string; email: string }> = {};
let categoryK = '';
let categoryJ = '';
let paidCourseId = '';
let paidLessonId = '';

const adminCookie = (token: string) => `authjs.session-token=${token}`;
const learnerCookie = (token: string) => `authjs.learner-session-token=${token}`;

async function seedUser(key: string, userRole: string): Promise<void> {
  const email = `${key}-grants-${run}@example.test`;
  const user = await prisma.user.create({ data: { email, userRole }, select: { id: true } });
  const token = `tok-grants-${run}-${randomBytes(6).toString('hex')}`;
  await prisma.session.create({
    data: { sessionToken: token, userId: user.id, expires: new Date(Date.now() + 3_600_000) },
  });
  users[key] = { id: user.id, token, email };
}

/** A published paid course with one readable lesson — the reader is the revocation witness. */
async function seedPaidCourse(): Promise<void> {
  const course = await prisma.course.create({
    data: {
      categoryId: categoryK,
      slug: `grants-${run}-paid`,
      levelLabel: 'N5',
      levelOrder: 1,
      title: `Paid ${run}`,
      pricingType: 'paid',
      publicationStatus: 'published',
      publishedAt: new Date(),
    },
    select: { id: true },
  });
  paidCourseId = course.id;

  const chapter = await prisma.chapter.create({
    data: { courseId: course.id, chapterOrder: 1, title: 'Chương 1' },
    select: { id: true },
  });
  const lesson = await prisma.lesson.create({
    data: { chapterId: chapter.id, lessonOrder: 1, title: 'Bài 1', contentStatus: 'published' },
    select: { id: true },
  });
  paidLessonId = lesson.id;

  const body = '# Bài 1\n\nNội dung trả phí.\n';
  const parsed = parseLessonMarkdown(body, null);
  if (!parsed.ok) throw new Error('seed markdown did not parse');
  await prisma.lessonContent.create({
    data: {
      lessonId: lesson.id,
      draftContentMarkdown: body,
      draftBlockList: parsed.blockList as unknown as object,
      draftContentChecksum: blockListChecksum(parsed.blockList),
      publishedContentMarkdown: body,
      publishedBlockList: parsed.blockList as unknown as object,
      publishedAt: new Date(),
    },
  });

  await prisma.publishedCourseStructure.create({
    data: {
      courseId: course.id,
      totalLessonCount: 1,
      publishedByUserId: users['owner']!.id,
      structurePayload: {
        courseId: course.id,
        publishedVersionNumber: 1,
        totalLessonCount: 1,
        chapters: [
          {
            chapterId: chapter.id,
            order: 1,
            title: 'Chương 1',
            description: null,
            lessons: [
              {
                lessonId: lesson.id,
                order: 1,
                title: 'Bài 1',
                estimatedMinutes: null,
                isFreePreview: false,
                hasAudio: false,
                audioDurationSeconds: null,
                figureCount: 0,
              },
            ],
          },
        ],
      } as object,
    },
  });
}

const grant = (body: Record<string, unknown>, token = users['owner']!.token) =>
  api().post('/api/admin/grants').set('Cookie', adminCookie(token)).send(body);

const readLesson = (token: string) =>
  api().get(`/api/lessons/${paidLessonId}`).set('Cookie', learnerCookie(token));

/** A `YYYY-MM-DD` that many days from today in Vietnam. */
const vietnamDate = (daysFromToday: number) => vietnamToday(new Date(Date.now() + daysFromToday * DAY));

beforeAll(async () => {
  await seedUser('owner', 'admin_owner');
  await seedUser('admin', 'admin');
  await seedUser('reader', 'learner');
  await seedUser('bundle', 'learner');
  await seedUser('lapsed', 'learner');

  categoryK = (
    await prisma.category.create({
      data: { slug: `grants-${run}-k`, displayName: `K ${run}` },
      select: { id: true },
    })
  ).id;
  categoryJ = (
    await prisma.category.create({
      data: { slug: `grants-${run}-j`, displayName: `J ${run}` },
      select: { id: true },
    })
  ).id;
  await seedPaidCourse();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api', { exclude: ['health'] });
  await app.init();
});

afterAll(async () => {
  const userIds = Object.values(users).map((user) => user.id);
  await prisma.accessGrant.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.publishedCourseStructure.deleteMany({ where: { courseId: paidCourseId } });
  await prisma.course.deleteMany({ where: { slug: { startsWith: `grants-${run}-` } } });
  await prisma.category.deleteMany({ where: { slug: { startsWith: `grants-${run}-` } } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

let readerGrantId = '';

describe('FR-COM-04 — granting', () => {
  it('grants a dated course grant ending at 23:59:59.999 Vietnam time on the chosen day', async () => {
    const expiresOn = vietnamDate(30);

    const response = await grant({
      learnerEmail: users['reader']!.email,
      scopeType: 'course',
      courseId: paidCourseId,
      expiresOn,
    }).expect(201);

    readerGrantId = response.body.grantId;
    expect(response.body).toMatchObject({
      learnerEmail: users['reader']!.email,
      scopeType: 'course',
      courseId: paidCourseId,
      accessSource: 'granted_by_owner',
      expiresAt: vietnamDayEnd(expiresOn).toISOString(),
      gracePeriodDays: 0,
      isActive: true,
      grantedByEmail: users['owner']!.email,
      revokedAt: null,
    });
  });

  it('grants perpetual category access as a NULL expiry, matching the email case-insensitively', async () => {
    const response = await grant({
      learnerEmail: users['bundle']!.email.toUpperCase(),
      scopeType: 'category',
      categoryId: categoryJ,
      expiresOn: null,
      gracePeriodDays: 3,
    }).expect(201);

    expect(response.body).toMatchObject({ scopeType: 'category', expiresAt: null, isActive: true });
    const row = await prisma.accessGrant.findUniqueOrThrow({
      where: { id: response.body.grantId },
      select: { expiresAt: true, gracePeriodDays: true, grantedByUserId: true },
    });
    expect(row).toEqual({ expiresAt: null, gracePeriodDays: 3, grantedByUserId: users['owner']!.id });
  });

  it('accepts an expiry of today, which ends tonight in Vietnam', async () => {
    await grant({
      learnerEmail: users['bundle']!.email,
      scopeType: 'category',
      categoryId: categoryK,
      expiresOn: vietnamDate(0),
    }).expect(201);
  });

  it('refuses a second live grant for the same learner and scope, carrying the existing one', async () => {
    const response = await grant({
      learnerEmail: users['reader']!.email,
      scopeType: 'course',
      courseId: paidCourseId,
      expiresOn: null,
    }).expect(409);

    expect(response.body.errorCode).toBe('GRANT_ALREADY_EXISTS');
    expect(response.body.grant).toMatchObject({
      grantId: readerGrantId,
      accessSource: 'granted_by_owner',
    });
  });

  it.each([
    ['an unknown email', { learnerEmail: `nobody-${run}@example.test` }, 404, 'USER_NOT_FOUND'],
    ['a date that has already ended', { expiresOn: vietnamDate(-1) }, 400, 'GRANT_EXPIRY_IN_PAST'],
    ['an impossible date', { expiresOn: '2026-02-30' }, 400, 'INVALID_BODY'],
    ['a date in another format', { expiresOn: '30/09/2026' }, 400, 'INVALID_BODY'],
    ['a negative grace period', { gracePeriodDays: -1 }, 400, 'INVALID_BODY'],
    ['an unknown course', { courseId: '00000000-0000-4000-8000-000000000000' }, 404, 'COURSE_NOT_FOUND'],
    ['a missing expiry', { expiresOn: undefined }, 400, 'INVALID_BODY'],
    ['an unknown field', { renewalCount: 5 }, 400, 'INVALID_BODY'],
  ])('refuses %s', async (_label, override: Record<string, unknown>, status, errorCode) => {
    const body: Record<string, unknown> = {
      learnerEmail: users['lapsed']!.email,
      scopeType: 'course',
      courseId: paidCourseId,
      expiresOn: vietnamDate(10),
      ...override,
    };
    // `{ expiresOn: undefined }` means "omit the key", which JSON would do anyway —
    // deleting it makes the intent explicit rather than a serializer detail.
    if ('expiresOn' in override && override['expiresOn'] === undefined) delete body['expiresOn'];

    const response = await grant(body).expect(status);
    expect(response.body.errorCode).toBe(errorCode);
  });

  it('refuses a grant to an owner or admin account with 422', async () => {
    const response = await grant({
      learnerEmail: users['admin']!.email,
      scopeType: 'course',
      courseId: paidCourseId,
      expiresOn: null,
    }).expect(422);
    expect(response.body.errorCode).toBe('GRANT_TARGET_NOT_LEARNER');
  });
});

describe('listing grants', () => {
  it('lists an expired-but-live grant under status=live, marked inactive by isGrantActive', async () => {
    const lapsed = await prisma.accessGrant.create({
      data: {
        userId: users['lapsed']!.id,
        scopeType: 'category',
        scopeCategoryId: categoryK,
        accessSource: 'purchase',
        expiresAt: new Date(Date.now() - 10 * DAY),
        gracePeriodDays: 2,
      },
      select: { id: true },
    });

    const response = await api()
      .get('/api/admin/grants')
      .query({ learnerEmail: `-grants-${run}@` })
      .set('Cookie', adminCookie(users['owner']!.token))
      .expect(200);

    const byId = new Map(
      response.body.items.map((item: { grantId: string }) => [item.grantId, item]),
    );
    expect(byId.get(lapsed.id)).toMatchObject({ isActive: false, revokedAt: null });
    expect(byId.get(readerGrantId)).toMatchObject({ isActive: true });
  });
});

describe('FR-COM-04 — revoking', () => {
  it('takes effect on the very next request to the reader', async () => {
    await readLesson(users['reader']!.token).expect(200);

    await api()
      .delete(`/api/admin/grants/${readerGrantId}`)
      .set('Cookie', adminCookie(users['owner']!.token))
      .expect(204);

    const refused = await readLesson(users['reader']!.token).expect(403);
    expect(refused.body.errorCode).toBe('LESSON_NOT_ENTITLED');
  });

  it('is idempotent and keeps the first revocation time', async () => {
    const first = await prisma.accessGrant.findUniqueOrThrow({
      where: { id: readerGrantId },
      select: { revokedAt: true },
    });
    expect(first.revokedAt).not.toBeNull();

    await api()
      .delete(`/api/admin/grants/${readerGrantId}`)
      .set('Cookie', adminCookie(users['owner']!.token))
      .expect(204);

    const second = await prisma.accessGrant.findUniqueOrThrow({
      where: { id: readerGrantId },
      select: { revokedAt: true },
    });
    expect(second.revokedAt).toEqual(first.revokedAt);
  });

  it('moves the grant from status=live to status=revoked', async () => {
    const live = await api()
      .get('/api/admin/grants')
      .query({ status: 'live', courseId: paidCourseId })
      .set('Cookie', adminCookie(users['owner']!.token))
      .expect(200);
    expect(live.body.items.map((item: { grantId: string }) => item.grantId)).not.toContain(
      readerGrantId,
    );

    const revoked = await api()
      .get('/api/admin/grants')
      .query({ status: 'revoked', courseId: paidCourseId })
      .set('Cookie', adminCookie(users['owner']!.token))
      .expect(200);
    const row = revoked.body.items.find((item: { grantId: string }) => item.grantId === readerGrantId);
    expect(row).toMatchObject({ isActive: false });
    expect(row.revokedAt).not.toBeNull();
  });

  it('allows a fresh grant after revocation, as a new row', async () => {
    const response = await grant({
      learnerEmail: users['reader']!.email,
      scopeType: 'course',
      courseId: paidCourseId,
      expiresOn: vietnamDate(5),
    }).expect(201);

    expect(response.body.grantId).not.toBe(readerGrantId);
    await readLesson(users['reader']!.token).expect(200);
  });

  it('404s an unknown or malformed grant', async () => {
    for (const id of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
      const response = await api()
        .delete(`/api/admin/grants/${id}`)
        .set('Cookie', adminCookie(users['owner']!.token))
        .expect(404);
      expect(response.body.errorCode).toBe('GRANT_NOT_FOUND');
    }
  });
});

describe('§3 — only the owner grants or revokes', () => {
  it('refuses a plain admin with 403 FORBIDDEN_ROLE on every endpoint', async () => {
    const token = users['admin']!.token;
    // Built lazily, one at a time: a supertest request binds its own ephemeral
    // listener when constructed, and one built long before it is awaited can find
    // that listener already gone.
    const calls = [
      () => api().get('/api/admin/grants').set('Cookie', adminCookie(token)),
      () => api().post('/api/admin/grants').set('Cookie', adminCookie(token)).send({}),
      () => api().delete(`/api/admin/grants/${readerGrantId}`).set('Cookie', adminCookie(token)),
    ];
    for (const call of calls) {
      const response = await call().expect(403);
      expect(response.body.errorCode).toBe('FORBIDDEN_ROLE');
    }
  });

  it("refuses learner-web's cookie with 401", async () => {
    await api()
      .get('/api/admin/grants')
      .set('Cookie', learnerCookie(users['reader']!.token))
      .expect(401);
  });
});
