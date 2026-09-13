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

  /**
   * P6 extends R-01 to `publishing`. That window is exactly when a non-owner
   * edit would corrupt the snapshot the publish job is copying, and before P6
   * the guard recognised only `published` and let the write through.
   */
  it('treats a course mid-publish as published, for a non-owner', async () => {
    const course = await prisma.course.create({
      data: {
        categoryId: ids.category,
        slug: `publishing-${run}`,
        levelLabel: 'N3',
        levelOrder: 9,
        title: 'Mid-publish course',
        publicationStatus: 'publishing',
      },
      select: { id: true },
    });
    const chapter = await prisma.chapter.create({
      data: { courseId: course.id, chapterOrder: 1, title: 'Chapter one' },
      select: { id: true },
    });
    const lesson = await prisma.lesson.create({
      data: { chapterId: chapter.id, lessonOrder: 1, title: 'Mid-publish lesson' },
      select: { id: true },
    });

    const refused = await request(app.getHttpServer())
      .patch(`/api/admin/lessons/${lesson.id}`)
      .set(as(tokens.adminA))
      .send({ title: 'admin edit during publish' })
      .expect(403);
    expect(refused.body.errorCode).toBe(errorCodes.FORBIDDEN_COURSE_PUBLISHED);

    // The owner started the run and is not locked out of their own course.
    await request(app.getHttpServer())
      .patch(`/api/admin/lessons/${lesson.id}`)
      .set(as(tokens.owner))
      .send({ title: 'owner edit during publish' })
      .expect(200);
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

/**
 * Every route P1 adds, gated by §3.
 *
 * This asserts only the authorization outcome, not behavior — each route's
 * behavior lives in import.e2e-spec.ts, structure.e2e-spec.ts,
 * assignment.e2e-spec.ts and job-stream.e2e-spec.ts. What is under test here is
 * that the gate exists at all, which is what removing a @RequirePermission would
 * break and what deny-by-default is meant to catch.
 */
describe('§3 gate on every route P1, P2, P3 and P4 add', () => {
  type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';
  interface Route {
    readonly name: string;
    readonly method: Method;
    readonly path: () => string;
    readonly body?: () => object;
    /** Roles §3 permits. Everyone else must be refused. */
    readonly allowed: ReadonlyArray<'owner' | 'admin'>;
  }

  // A well-formed id matching no row, as the images route above uses: the §3
  // gate runs before the handler can 404, which is the whole point of this table.
  const NO_SUCH_LESSON = '00000000-0000-0000-0000-000000000000';
  const NO_SUCH_LESSON_NARRATION = `/api/admin/lessons/${NO_SUCH_LESSON}/narration-script`;
  const NO_SUCH_LESSON_STALENESS = `/api/admin/lessons/${NO_SUCH_LESSON}/staleness`;

  const routes: readonly Route[] = [
    {
      name: 'GET /import-template',
      method: 'get',
      path: () => '/api/admin/import-template',
      allowed: ['owner'],
    },
    {
      name: 'GET /import-schema',
      method: 'get',
      path: () => '/api/admin/import-schema',
      allowed: ['owner'],
    },
    {
      name: 'POST /courses/import/dry-run',
      method: 'post',
      path: () => '/api/admin/courses/import/dry-run',
      body: () => ({}),
      allowed: ['owner'],
    },
    {
      name: 'POST /courses/import',
      method: 'post',
      path: () => '/api/admin/courses/import',
      body: () => ({}),
      allowed: ['owner'],
    },
    {
      name: 'GET /jobs/:jobId/stream',
      method: 'get',
      path: () => '/api/admin/jobs/does-not-exist/stream',
      // §9.3 lists the streams as admin-or-owner. P1 could declare the narrower
      // `importCurriculumOutline` because import was the only producer; with a
      // second one the §3 gate is the broader action and JobWatchGuard narrows
      // per job — job-stream.e2e-spec.ts asserts an admin is still refused an
      // import job.
      allowed: ['owner', 'admin'],
    },
    {
      name: 'POST /categories',
      method: 'post',
      path: () => '/api/admin/categories',
      body: () => ({ slug: `gate-${run}`, displayName: 'Gate' }),
      allowed: ['owner'],
    },
    {
      name: 'PATCH /courses/:id/pricing-type',
      method: 'patch',
      path: () => `/api/admin/courses/${ids.draftCourse}/pricing-type`,
      body: () => ({ pricingType: 'free' }),
      allowed: ['owner'],
    },
    {
      name: 'PATCH /courses/:id/structure',
      method: 'patch',
      path: () => `/api/admin/courses/${ids.draftCourse}/structure`,
      body: () => ({ chapters: [] }),
      allowed: ['owner', 'admin'],
    },
    {
      name: 'POST /chapters',
      method: 'post',
      path: () => '/api/admin/chapters',
      body: () => ({}),
      allowed: ['owner', 'admin'],
    },
    {
      name: 'DELETE /chapters/:id',
      method: 'delete',
      path: () => `/api/admin/chapters/${ids.unassignedChapter}`,
      allowed: ['owner', 'admin'],
    },
    {
      name: 'POST /lessons',
      method: 'post',
      path: () => '/api/admin/lessons',
      body: () => ({}),
      allowed: ['owner', 'admin'],
    },
    {
      name: 'DELETE /lessons/:id',
      method: 'delete',
      path: () => `/api/admin/lessons/${ids.publishedLesson}`,
      allowed: ['owner', 'admin'],
    },
    {
      name: 'GET /my-assignments',
      method: 'get',
      path: () => '/api/admin/my-assignments',
      allowed: ['owner', 'admin'],
    },
    {
      name: 'GET /lessons/:id/content',
      method: 'get',
      path: () => `/api/admin/lessons/${ids.publishedLesson}/content`,
      allowed: ['owner', 'admin'],
    },
    {
      name: 'PUT /lessons/:id/content',
      method: 'put',
      path: () => `/api/admin/lessons/${ids.publishedLesson}/content`,
      body: () => ({ markdown: '# rbac probe\n' }),
      allowed: ['owner', 'admin'],
    },
    {
      name: 'GET /lessons/:id/images',
      method: 'get',
      path: () => `/api/admin/lessons/${ids.publishedLesson}/images`,
      allowed: ['owner', 'admin'],
    },
    {
      name: 'POST /lessons/:id/images/upload',
      method: 'post',
      path: () => `/api/admin/lessons/${ids.publishedLesson}/images/upload`,
      body: () => ({ blockReferenceId: 'fig1' }),
      allowed: ['owner', 'admin'],
    },
    {
      name: 'GET /courses/:courseId/stream',
      method: 'get',
      path: () => `/api/admin/courses/${ids.draftCourse}/stream`,
      allowed: ['owner', 'admin'],
    },
    {
      name: 'PATCH /images/:imageId',
      method: 'patch',
      // A well-formed id that matches no row: the §3 gate runs before the
      // handler can 404, which is the whole point of this table.
      path: () => '/api/admin/images/00000000-0000-0000-0000-000000000000',
      body: () => ({ isSelected: true }),
      allowed: ['owner', 'admin'],
    },
    {
      name: 'GET /lessons/:lessonId/narration-script',
      method: 'get',
      path: () => NO_SUCH_LESSON_NARRATION,
      allowed: ['owner', 'admin'],
    },
    {
      name: 'POST /lessons/:lessonId/narration-script',
      method: 'post',
      path: () => NO_SUCH_LESSON_NARRATION,
      body: () => ({}),
      allowed: ['owner', 'admin'],
    },
    {
      name: 'PUT /lessons/:lessonId/narration-script',
      method: 'put',
      path: () => NO_SUCH_LESSON_NARRATION,
      body: () => ({ scriptChecksum: 'anything', approve: true }),
      allowed: ['owner', 'admin'],
    },
    {
      name: 'GET /lessons/:lessonId/staleness',
      method: 'get',
      path: () => NO_SUCH_LESSON_STALENESS,
      allowed: ['owner', 'admin'],
    },
  ];

  // Independent of what earlier tests in this file did to these accounts.
  beforeAll(async () => {
    await prisma.user.update({ where: { id: ids.adminB }, data: { isActive: true } });
  });

  /**
   * Past the §3 gate means neither refusal RolesGuard can produce. Checking only
   * FORBIDDEN_ROLE would pass vacuously if a route lost its @RequirePermission,
   * since deny-by-default then answers FORBIDDEN_NO_POLICY instead — which is
   * exactly the mutation the binding check exercises.
   */
  const passedTheGate = (errorCode: unknown): boolean =>
    errorCode !== errorCodes.FORBIDDEN_ROLE && errorCode !== errorCodes.FORBIDDEN_NO_POLICY;

  const send = (route: Route, token?: string) => {
    const call = request(app.getHttpServer())[route.method](route.path());
    if (token) void call.set(as(token));
    return route.body ? call.send(route.body()) : call;
  };

  for (const route of routes) {
    it(`${route.name} refuses a learner`, async () => {
      const response = await send(route, tokens.learner);
      expect(response.status).toBe(403);
      expect(response.body.errorCode).toBe(errorCodes.FORBIDDEN_ROLE);
    });

    it(`${route.name} answers 401, not 403, when unauthenticated`, async () => {
      const response = await send(route);
      expect(response.status).toBe(401);
      expect(response.body.errorCode).toBe(errorCodes.UNAUTHENTICATED);
    });

    if (!route.allowed.includes('admin')) {
      it(`${route.name} refuses an admin`, async () => {
        const response = await send(route, tokens.adminB);
        expect(response.status).toBe(403);
        expect(response.body.errorCode).toBe(errorCodes.FORBIDDEN_ROLE);
      });
    } else {
      it(`${route.name} lets an admin past the §3 gate`, async () => {
        const response = await send(route, tokens.adminB);
        expect(passedTheGate(response.body?.errorCode)).toBe(true);
      });
    }

    it(`${route.name} lets the owner past the §3 gate`, async () => {
      const response = await send(route, tokens.owner);
      expect(passedTheGate(response.body?.errorCode)).toBe(true);
    });
  }
});
