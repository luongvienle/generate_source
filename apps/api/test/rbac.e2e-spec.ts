import { randomBytes } from 'node:crypto';
import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { getPrismaClient } from '@knowledge-explorer/database';
import { errorCodes } from '@knowledge-explorer/shared';
import { AppModule } from '../src/app.module';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * The eleven-row verification table from specs/p0-foundation/spec.md, asserted
 * over real HTTP against the migrated database.
 *
 * Sessions are inserted directly rather than obtained through the web app:
 * the API guard chain is P0's only enforcement point, and it reads `sessions`
 * regardless of which process wrote the row.
 */

const prisma = getPrismaClient();
const run = randomBytes(4).toString('hex');
const email = (local: string): string => `${local}-${run}@example.test`;

let app: INestApplication;
const ids = {
  owner: '',
  adminA: '',
  adminB: '',
  learner: '',
  category: '',
  draftCourse: '',
  publishedCourse: '',
  unassignedChapter: '',
  chapterAssignedToB: '',
  publishedLesson: '',
};
const tokens = { owner: '', adminA: '', adminB: '', learner: '', expired: '' };

async function seedUser(local: string, userRole: string): Promise<string> {
  const user = await prisma.user.create({
    data: { email: email(local), name: local, userRole },
    select: { id: true },
  });
  return user.id;
}

async function seedSession(userId: string, expiresAt: Date): Promise<string> {
  const sessionToken = `tok-${run}-${randomBytes(8).toString('hex')}`;
  await prisma.session.create({ data: { sessionToken, userId, expires: expiresAt } });
  return sessionToken;
}

/** Sends the session token the way Auth.js would. */
const as = (token: string) => ({ Cookie: `authjs.session-token=${token}` });

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api', { exclude: ['health'] });
  await app.init();

  ids.owner = await seedUser('owner', 'admin_owner');
  ids.adminA = await seedUser('admin-a', 'admin');
  ids.adminB = await seedUser('admin-b', 'admin');
  ids.learner = await seedUser('learner', 'learner');

  const hour = new Date(Date.now() + 60 * 60 * 1000);
  tokens.owner = await seedSession(ids.owner, hour);
  tokens.adminA = await seedSession(ids.adminA, hour);
  tokens.adminB = await seedSession(ids.adminB, hour);
  tokens.learner = await seedSession(ids.learner, hour);
  tokens.expired = await seedSession(ids.adminA, new Date(Date.now() - 60 * 1000));

  const category = await prisma.category.create({
    data: { slug: `cat-${run}`, displayName: 'Test category' },
    select: { id: true },
  });
  ids.category = category.id;

  const draftCourse = await prisma.course.create({
    data: {
      categoryId: ids.category,
      slug: `draft-${run}`,
      levelLabel: 'N5',
      levelOrder: 1,
      title: 'Draft course',
      publicationStatus: 'draft',
    },
    select: { id: true },
  });
  ids.draftCourse = draftCourse.id;

  const publishedCourse = await prisma.course.create({
    data: {
      categoryId: ids.category,
      slug: `published-${run}`,
      levelLabel: 'N4',
      levelOrder: 2,
      title: 'Published course',
      publicationStatus: 'published',
    },
    select: { id: true },
  });
  ids.publishedCourse = publishedCourse.id;

  const unassigned = await prisma.chapter.create({
    data: { courseId: ids.draftCourse, chapterOrder: 1, title: 'Unassigned' },
    select: { id: true },
  });
  ids.unassignedChapter = unassigned.id;

  const assignedToB = await prisma.chapter.create({
    data: {
      courseId: ids.draftCourse,
      chapterOrder: 2,
      title: 'Assigned to B',
      assignedAdminId: ids.adminB,
    },
    select: { id: true },
  });
  ids.chapterAssignedToB = assignedToB.id;

  const publishedChapter = await prisma.chapter.create({
    data: { courseId: ids.publishedCourse, chapterOrder: 1, title: 'Published chapter' },
    select: { id: true },
  });
  const publishedLesson = await prisma.lesson.create({
    data: { chapterId: publishedChapter.id, lessonOrder: 1, title: 'Published lesson' },
    select: { id: true },
  });
  ids.publishedLesson = publishedLesson.id;
});

afterAll(async () => {
  await app.close();
  // created_by_user_id is ON DELETE NO ACTION, so break the self-reference first.
  await prisma.user.updateMany({
    where: { email: { endsWith: `-${run}@example.test` } },
    data: { createdByUserId: null },
  });
  await prisma.verificationToken.deleteMany({
    where: { identifier: { endsWith: `-${run}@example.test` } },
  });
  await prisma.course.deleteMany({ where: { categoryId: ids.category } });
  await prisma.category.deleteMany({ where: { id: ids.category } });
  await prisma.user.deleteMany({
    where: { email: { endsWith: `-${run}@example.test` } },
  });
  await prisma.$disconnect();
});

describe('row 1 — owner creates an admin account', () => {
  it('returns 201 and logs a sign-in link', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      logged.push(String(message));
    });

    const newAdmin = email('invited');
    const response = await request(app.getHttpServer())
      .post('/api/admin/admins')
      .set(as(tokens.owner))
      .send({ emailAddress: newAdmin, displayName: 'Invited' })
      .expect(201);

    spy.mockRestore();

    expect(response.body).toMatchObject({ email: newAdmin, userRole: 'admin', isActive: true });

    const linkLine = logged.find((line) => line.includes(newAdmin) && line.includes('token='));
    expect(linkLine, `no sign-in link logged; saw: ${logged.join(' | ')}`).toBeDefined();

    // The emailed token is single-use by construction: only its hash is stored.
    const stored = await prisma.verificationToken.findMany({
      where: { identifier: newAdmin },
    });
    expect(stored).toHaveLength(1);
    expect(linkLine).not.toContain(stored[0]!.token);
  });
});

describe('row 2 — reusing a sign-in link', () => {
  /**
   * Consuming a link is the Auth.js callback's job and lives in admin-web, not
   * in this API. It is covered where it actually runs:
   *   - apps/admin-web/test/verification-token.spec.ts  (adapter level)
   *   - scripts/verify-magic-link.sh                    (real HTTP, live server)
   */
  it('mints a token this API never stores in the clear', async () => {
    const address = email('single-use');
    await request(app.getHttpServer())
      .post('/api/admin/admins')
      .set(as(tokens.owner))
      .send({ emailAddress: address })
      .expect(201);

    const stored = await prisma.verificationToken.findMany({ where: { identifier: address } });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.token).toMatch(/^[0-9a-f]{64}$/);
    expect(stored[0]!.expires.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('rows 3-5 — role gate on /api/admin/*', () => {
  it('row 3: admin creating an admin account is refused', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/admin/admins')
      .set(as(tokens.adminA))
      .send({ emailAddress: email('nope') })
      .expect(403);
    expect(response.body.errorCode).toBe(errorCodes.FORBIDDEN_ROLE);
  });

  it('row 4: a learner is refused on an admin route', async () => {
    const response = await request(app.getHttpServer())
      .patch(`/api/admin/chapters/${ids.unassignedChapter}`)
      .set(as(tokens.learner))
      .send({ title: 'learner edit' })
      .expect(403);
    expect(response.body.errorCode).toBe(errorCodes.FORBIDDEN_ROLE);
  });

  it('row 5: an unauthenticated call is 401, not 403', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/admin/admins')
      .send({ emailAddress: email('anon') })
      .expect(401);
    expect(response.body.errorCode).toBe(errorCodes.UNAUTHENTICATED);
  });

  it('treats an expired session as unauthenticated', async () => {
    await request(app.getHttpServer())
      .post('/api/admin/admins')
      .set(as(tokens.expired))
      .send({ emailAddress: email('expired') })
      .expect(401);
  });
});

describe('rows 6-7 — rule R-02, assignment scoping', () => {
  it('row 6: an admin may edit an unassigned chapter in a draft course', async () => {
    const response = await request(app.getHttpServer())
      .patch(`/api/admin/chapters/${ids.unassignedChapter}`)
      .set(as(tokens.adminA))
      .send({ title: 'renamed by A' })
      .expect(200);
    expect(response.body).toMatchObject({ title: 'renamed by A' });
  });

  it('row 7: an admin may not edit a chapter assigned to another admin', async () => {
    const response = await request(app.getHttpServer())
      .patch(`/api/admin/chapters/${ids.chapterAssignedToB}`)
      .set(as(tokens.adminA))
      .send({ title: 'renamed by A' })
      .expect(403);
    expect(response.body.errorCode).toBe(errorCodes.FORBIDDEN_NOT_ASSIGNED);

    const unchanged = await prisma.chapter.findUnique({
      where: { id: ids.chapterAssignedToB },
      select: { title: true },
    });
    expect(unchanged?.title).toBe('Assigned to B');
  });

  it('the assigned admin may edit their own chapter', async () => {
    await request(app.getHttpServer())
      .patch(`/api/admin/chapters/${ids.chapterAssignedToB}`)
      .set(as(tokens.adminB))
      .send({ title: 'renamed by B' })
      .expect(200);
  });
});

describe('rows 8-9 — rule R-01, published-course lock', () => {
  it('row 8: an admin may not edit a lesson in a published course', async () => {
    const response = await request(app.getHttpServer())
      .patch(`/api/admin/lessons/${ids.publishedLesson}`)
      .set(as(tokens.adminA))
      .send({ title: 'admin edit' })
      .expect(403);
    expect(response.body.errorCode).toBe(errorCodes.FORBIDDEN_COURSE_PUBLISHED);

    const unchanged = await prisma.lesson.findUnique({
      where: { id: ids.publishedLesson },
      select: { title: true },
    });
    expect(unchanged?.title).toBe('Published lesson');
  });

  it('row 9: the owner may edit a lesson in a published course', async () => {
    const response = await request(app.getHttpServer())
      .patch(`/api/admin/lessons/${ids.publishedLesson}`)
      .set(as(tokens.owner))
      .send({ title: 'owner edit' })
      .expect(200);
    expect(response.body).toMatchObject({ title: 'owner edit' });
  });
});

describe('row 10 — disabling an admin takes effect immediately', () => {
  it('refuses the next call with no restart', async () => {
    // Establish that the call currently succeeds.
    await request(app.getHttpServer())
      .patch(`/api/admin/chapters/${ids.unassignedChapter}`)
      .set(as(tokens.adminA))
      .send({ title: 'before disable' })
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/api/admin/admins/${ids.adminA}`)
      .set(as(tokens.owner))
      .send({ isActive: false })
      .expect(200);

    // Same process, same session cookie, no cache flush.
    const response = await request(app.getHttpServer())
      .patch(`/api/admin/chapters/${ids.unassignedChapter}`)
      .set(as(tokens.adminA))
      .send({ title: 'after disable' })
      .expect(403);
    expect(response.body.errorCode).toBe(errorCodes.ACCOUNT_DISABLED);

    const unchanged = await prisma.chapter.findUnique({
      where: { id: ids.unassignedChapter },
      select: { title: true },
    });
    expect(unchanged?.title).toBe('before disable');
  });
});

describe('row 11 — client-supplied role is ignored', () => {
  it('an injected userRole changes nothing, in body, query or header', async () => {
    const plain = await request(app.getHttpServer())
      .post('/api/admin/admins')
      .set(as(tokens.adminB))
      .send({ emailAddress: email('plain') });

    const injected = await request(app.getHttpServer())
      .post('/api/admin/admins?userRole=admin_owner')
      .set({ ...as(tokens.adminB), 'X-User-Role': 'admin_owner' })
      .send({ emailAddress: email('injected'), userRole: 'admin_owner' });

    expect(plain.status).toBe(403);
    expect(injected.status).toBe(plain.status);
    expect(injected.body.errorCode).toBe(plain.body.errorCode);

    // Neither attempt created anything.
    const created = await prisma.user.findMany({
      where: { email: { in: [email('plain'), email('injected')] } },
    });
    expect(created).toEqual([]);
  });
});

describe('deny-by-default', () => {
  it('refuses every role on an endpoint that declares no permission', async () => {
    for (const token of [tokens.owner, tokens.adminB, tokens.learner]) {
      const response = await request(app.getHttpServer())
        .get('/api/admin/policy-fixture')
        .set(as(token))
        .expect(403);
      expect(response.body.errorCode).toBe(errorCodes.FORBIDDEN_NO_POLICY);
    }
  });
});
