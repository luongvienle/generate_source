import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { getPrismaClient } from '@knowledge-explorer/database';
import { errorCodes } from '@knowledge-explorer/shared';
import { AppModule } from '../src/app.module';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * Assignment: the verification table in specs/p1-curriculum/spec.md.
 *
 * assignedAdminId is owner-only on a route admins may otherwise call, so the
 * mixed-field case is the one that matters — it must write NEITHER field, which
 * is why enforcement is a guard rather than a check inside the handler.
 */

const run = randomBytes(4).toString('hex');
const prisma = getPrismaClient();

let app: INestApplication;
const tokens = { owner: '', adminA: '', adminB: '' };
const ids = { owner: '', adminA: '', adminB: '', category: '', lesson: '', chapter: '' };

const as = (token: string) => ({ Cookie: `authjs.session-token=${token}` });

async function seedUser(local: string, userRole: string): Promise<[string, string]> {
  const user = await prisma.user.create({
    data: { email: `${local}-${run}@example.test`, name: local, userRole },
    select: { id: true },
  });
  const sessionToken = `tok-${run}-${randomBytes(6).toString('hex')}`;
  await prisma.session.create({
    data: { sessionToken, userId: user.id, expires: new Date(Date.now() + 3_600_000) },
  });
  return [user.id, sessionToken];
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api', { exclude: ['health'] });
  await app.init();

  [ids.owner, tokens.owner] = await seedUser('owner', 'admin_owner');
  [ids.adminA, tokens.adminA] = await seedUser('admin-a', 'admin');
  [ids.adminB, tokens.adminB] = await seedUser('admin-b', 'admin');

  const category = await prisma.category.create({
    data: { slug: `assign-${run}`, displayName: 'Assignment' },
    select: { id: true },
  });
  ids.category = category.id;

  const course = await prisma.course.create({
    data: {
      categoryId: category.id,
      slug: `assign-${run}-n1`,
      levelLabel: 'N1',
      levelOrder: 1,
      title: 'Assignment course',
      publicationStatus: 'draft',
    },
    select: { id: true },
  });

  const chapter = await prisma.chapter.create({
    data: { courseId: course.id, chapterOrder: 1, title: 'Chapter one' },
    select: { id: true },
  });
  ids.chapter = chapter.id;

  const lesson = await prisma.lesson.create({
    data: { chapterId: chapter.id, lessonOrder: 1, title: 'Lesson one' },
    select: { id: true },
  });
  ids.lesson = lesson.id;
}, 30_000);

afterAll(async () => {
  await app.close();
  await prisma.course.deleteMany({ where: { categoryId: ids.category } });
  await prisma.category.delete({ where: { id: ids.category } });
  await prisma.session.deleteMany({ where: { userId: { in: [ids.owner, ids.adminA, ids.adminB] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ids.owner, ids.adminA, ids.adminB] } } });
  await prisma.$disconnect();
});

describe('assignedAdminId is owner-only', () => {
  it('lets the owner assign a lesson', async () => {
    const response = await request(app.getHttpServer())
      .patch(`/api/admin/lessons/${ids.lesson}`)
      .set(as(tokens.owner))
      .send({ assignedAdminId: ids.adminA })
      .expect(200);

    expect(response.body.assignedAdminId).toBe(ids.adminA);
  });

  it('lets an admin edit the title on that same route', async () => {
    await request(app.getHttpServer())
      .patch(`/api/admin/lessons/${ids.lesson}`)
      .set(as(tokens.adminA))
      .send({ title: 'Renamed by the assigned admin' })
      .expect(200);

    const row = await prisma.lesson.findUniqueOrThrow({ where: { id: ids.lesson } });
    expect(row.title).toBe('Renamed by the assigned admin');
  });

  it('refuses an admin setting assignedAdminId', async () => {
    const response = await request(app.getHttpServer())
      .patch(`/api/admin/lessons/${ids.lesson}`)
      .set(as(tokens.adminA))
      .send({ assignedAdminId: ids.adminA })
      .expect(403);

    expect(response.body.errorCode).toBe(errorCodes.FORBIDDEN_OWNER_ONLY_FIELD);
  });

  it('writes NEITHER field when an admin sends title and assignedAdminId together', async () => {
    const before = await prisma.lesson.findUniqueOrThrow({ where: { id: ids.lesson } });

    await request(app.getHttpServer())
      .patch(`/api/admin/lessons/${ids.lesson}`)
      .set(as(tokens.adminA))
      .send({ title: 'Should not land', assignedAdminId: null })
      .expect(403);

    const after = await prisma.lesson.findUniqueOrThrow({ where: { id: ids.lesson } });
    expect(after.title).toBe(before.title);
    expect(after.assignedAdminId).toBe(before.assignedAdminId);
  });

  it('refuses an admin clearing an assignment with null, not just setting one', async () => {
    await request(app.getHttpServer())
      .patch(`/api/admin/chapters/${ids.chapter}`)
      .set(as(tokens.adminA))
      .send({ assignedAdminId: null })
      .expect(403);
  });

  it('lets the owner assign a chapter', async () => {
    const response = await request(app.getHttpServer())
      .patch(`/api/admin/chapters/${ids.chapter}`)
      .set(as(tokens.owner))
      .send({ assignedAdminId: ids.adminB })
      .expect(200);

    expect(response.body.assignedAdminId).toBe(ids.adminB);
    await prisma.chapter.update({ where: { id: ids.chapter }, data: { assignedAdminId: null } });
  });
});

describe('GET /my-assignments', () => {
  it('returns the caller’s lessons with chapter and course context', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/admin/my-assignments')
      .set(as(tokens.adminA))
      .expect(200);

    expect(response.body).toHaveLength(1);
    expect(response.body[0].id).toBe(ids.lesson);
    expect(response.body[0].chapter.title).toBe('Chapter one');
    expect(response.body[0].chapter.course.slug).toBe(`assign-${run}-n1`);
  });

  it('does not return another admin’s lesson', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/admin/my-assignments')
      .set(as(tokens.adminB))
      .expect(200);

    expect(response.body.map((lesson: { id: string }) => lesson.id)).not.toContain(ids.lesson);
  });

  it('excludes a soft-deleted lesson', async () => {
    await prisma.lesson.update({ where: { id: ids.lesson }, data: { deletedAt: new Date() } });

    const response = await request(app.getHttpServer())
      .get('/api/admin/my-assignments')
      .set(as(tokens.adminA))
      .expect(200);
    expect(response.body).toHaveLength(0);

    await prisma.lesson.update({ where: { id: ids.lesson }, data: { deletedAt: null } });
  });
});
