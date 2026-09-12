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
 * Chapter and lesson CRUD, and the structure rewrite — the verification table in
 * specs/p1-curriculum/spec.md.
 *
 * The reversal case is the one that matters: §8's ordering indexes are unique
 * INDEXes, checked per row, so a naive sequential rewrite passes a small shuffle
 * and fails a full reversal.
 */

const run = randomBytes(4).toString('hex');
const prisma = getPrismaClient();

let app: INestApplication;
const tokens = { owner: '', adminA: '', adminB: '' };
const ids = { owner: '', adminA: '', adminB: '', category: '', draft: '', published: '' };
const chapterIds: string[] = [];

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

const chapters = () =>
  prisma.chapter.findMany({
    where: { courseId: ids.draft, deletedAt: null },
    orderBy: { chapterOrder: 'asc' },
    include: { lessons: { where: { deletedAt: null }, orderBy: { lessonOrder: 'asc' } } },
  });

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api', { exclude: ['health'] });
  await app.init();

  [ids.owner, tokens.owner] = await seedUser('owner', 'admin_owner');
  [ids.adminA, tokens.adminA] = await seedUser('admin-a', 'admin');
  [ids.adminB, tokens.adminB] = await seedUser('admin-b', 'admin');

  const category = await prisma.category.create({
    data: { slug: `structure-${run}`, displayName: 'Structure' },
    select: { id: true },
  });
  ids.category = category.id;

  const draft = await prisma.course.create({
    data: {
      categoryId: category.id,
      slug: `structure-${run}-draft`,
      levelLabel: 'D1',
      levelOrder: 1,
      title: 'Draft course',
      publicationStatus: 'draft',
    },
    select: { id: true },
  });
  ids.draft = draft.id;

  const published = await prisma.course.create({
    data: {
      categoryId: category.id,
      slug: `structure-${run}-published`,
      levelLabel: 'P1',
      levelOrder: 2,
      title: 'Published course',
      publicationStatus: 'published',
    },
    select: { id: true },
  });
  ids.published = published.id;

  // Five chapters, each with two lessons.
  for (let index = 1; index <= 5; index += 1) {
    const chapter = await prisma.chapter.create({
      data: { courseId: draft.id, chapterOrder: index, title: `Chapter ${index}` },
      select: { id: true },
    });
    chapterIds.push(chapter.id);
    for (let lesson = 1; lesson <= 2; lesson += 1) {
      await prisma.lesson.create({
        data: { chapterId: chapter.id, lessonOrder: lesson, title: `Lesson ${index}.${lesson}` },
      });
    }
  }

  await prisma.chapter.create({
    data: { courseId: published.id, chapterOrder: 1, title: 'Published chapter' },
  });
}, 30_000);

afterAll(async () => {
  await app.close();
  await prisma.course.deleteMany({ where: { categoryId: ids.category } });
  await prisma.category.delete({ where: { id: ids.category } });
  await prisma.session.deleteMany({ where: { userId: { in: [ids.owner, ids.adminA, ids.adminB] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ids.owner, ids.adminA, ids.adminB] } } });
  await prisma.$disconnect();
});

const fullOrder = async () =>
  (await chapters()).map((chapter) => ({
    chapterId: chapter.id,
    lessonIds: chapter.lessons.map((lesson) => lesson.id),
  }));

describe('PATCH /courses/:courseId/structure', () => {
  it('reverses five chapters in one request without violating idx_chapters_order', async () => {
    const order = await fullOrder();
    const reversed = [...order].reverse();

    await request(app.getHttpServer())
      .patch(`/api/admin/courses/${ids.draft}/structure`)
      .set(as(tokens.owner))
      .send({ chapters: reversed })
      .expect(200);

    const after = await chapters();
    expect(after.map((c) => c.id)).toEqual(reversed.map((c) => c.chapterId));
    expect(after.map((c) => c.chapterOrder)).toEqual([1, 2, 3, 4, 5]);
  });

  it('moves a lesson between chapters in that same single request', async () => {
    const order = await fullOrder();
    const [first, second] = order;
    const moved = first!.lessonIds[1]!;

    const next = [
      { chapterId: first!.chapterId, lessonIds: first!.lessonIds.filter((id) => id !== moved) },
      { chapterId: second!.chapterId, lessonIds: [moved, ...second!.lessonIds] },
      ...order.slice(2),
    ];

    await request(app.getHttpServer())
      .patch(`/api/admin/courses/${ids.draft}/structure`)
      .set(as(tokens.owner))
      .send({ chapters: next })
      .expect(200);

    const after = await chapters();
    expect(after[0]!.lessons.map((l) => l.id)).toEqual(next[0]!.lessonIds);
    expect(after[1]!.lessons.map((l) => l.id)).toEqual(next[1]!.lessonIds);
    // Both chapters stay contiguous from 1.
    expect(after[0]!.lessons.map((l) => l.lessonOrder)).toEqual([1]);
    expect(after[1]!.lessons.map((l) => l.lessonOrder)).toEqual([1, 2, 3]);
  });

  it('refuses whole, writing nothing, when the payload omits an existing lesson', async () => {
    const before = await chapters();
    const order = await fullOrder();
    order[0] = { chapterId: order[0]!.chapterId, lessonIds: [] };

    const response = await request(app.getHttpServer())
      .patch(`/api/admin/courses/${ids.draft}/structure`)
      .set(as(tokens.owner))
      .send({ chapters: order })
      .expect(422);

    expect(response.body.errorCode).toBe(errorCodes.STRUCTURE_MISMATCH);
    expect(await chapters()).toEqual(before);
  });

  it('refuses whole when the payload names a row from another course', async () => {
    const before = await chapters();
    const stranger = await prisma.chapter.findFirstOrThrow({ where: { courseId: ids.published } });
    const order = await fullOrder();

    const response = await request(app.getHttpServer())
      .patch(`/api/admin/courses/${ids.draft}/structure`)
      .set(as(tokens.owner))
      .send({ chapters: [...order, { chapterId: stranger.id, lessonIds: [] }] })
      .expect(422);

    expect(response.body.errorCode).toBe(errorCodes.STRUCTURE_MISMATCH);
    expect(await chapters()).toEqual(before);
  });

  it('lets an admin reorder a draft course with no assignment', async () => {
    await request(app.getHttpServer())
      .patch(`/api/admin/courses/${ids.draft}/structure`)
      .set(as(tokens.adminA))
      .send({ chapters: await fullOrder() })
      .expect(200);
  });

  it('refuses an admin on a published course (R-01)', async () => {
    const published = await prisma.chapter.findFirstOrThrow({ where: { courseId: ids.published } });
    const response = await request(app.getHttpServer())
      .patch(`/api/admin/courses/${ids.published}/structure`)
      .set(as(tokens.adminA))
      .send({ chapters: [{ chapterId: published.id, lessonIds: [] }] })
      .expect(403);

    expect(response.body.errorCode).toBe(errorCodes.FORBIDDEN_COURSE_PUBLISHED);
  });

  it('allows the owner on a published course', async () => {
    const published = await prisma.chapter.findFirstOrThrow({ where: { courseId: ids.published } });
    await request(app.getHttpServer())
      .patch(`/api/admin/courses/${ids.published}/structure`)
      .set(as(tokens.owner))
      .send({ chapters: [{ chapterId: published.id, lessonIds: [] }] })
      .expect(200);
  });

  it('refuses an admin when any targeted row belongs to another admin (R-02)', async () => {
    const [first] = await chapters();
    await prisma.chapter.update({
      where: { id: first!.id },
      data: { assignedAdminId: ids.adminB },
    });

    const response = await request(app.getHttpServer())
      .patch(`/api/admin/courses/${ids.draft}/structure`)
      .set(as(tokens.adminA))
      .send({ chapters: await fullOrder() })
      .expect(403);

    expect(response.body.errorCode).toBe(errorCodes.FORBIDDEN_NOT_ASSIGNED);
    await prisma.chapter.update({ where: { id: first!.id }, data: { assignedAdminId: null } });
  });
});

describe('chapter and lesson CRUD', () => {
  it('creates a chapter and a lesson', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/admin/chapters')
      .set(as(tokens.owner))
      .send({ courseId: ids.draft, chapterOrder: 99, title: 'Created chapter' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/admin/lessons')
      .set(as(tokens.owner))
      .send({ chapterId: created.body.id, lessonOrder: 1, title: 'Created lesson' })
      .expect(201);

    const chapter = await prisma.chapter.findUniqueOrThrow({
      where: { id: created.body.id },
      include: { lessons: true },
    });
    expect(chapter.lessons).toHaveLength(1);
    expect(chapter.lessons[0]!.contentStatus).toBe('empty');
  });

  it('soft-deletes a lesson: deleted_at set, row still present', async () => {
    const lesson = await prisma.lesson.findFirstOrThrow({
      where: { chapter: { courseId: ids.draft }, deletedAt: null },
    });

    await request(app.getHttpServer())
      .delete(`/api/admin/lessons/${lesson.id}`)
      .set(as(tokens.owner))
      .expect(200);

    const row = await prisma.lesson.findUniqueOrThrow({ where: { id: lesson.id } });
    expect(row.deletedAt).not.toBeNull();
  });

  it('soft-deletes a chapter and the lessons under it', async () => {
    const chapter = await prisma.chapter.findFirstOrThrow({
      where: { courseId: ids.draft, deletedAt: null, lessons: { some: { deletedAt: null } } },
      include: { lessons: { where: { deletedAt: null } } },
    });

    await request(app.getHttpServer())
      .delete(`/api/admin/chapters/${chapter.id}`)
      .set(as(tokens.owner))
      .expect(200);

    const after = await prisma.chapter.findUniqueOrThrow({
      where: { id: chapter.id },
      include: { lessons: true },
    });
    expect(after.deletedAt).not.toBeNull();
    expect(after.lessons.every((lesson) => lesson.deletedAt !== null)).toBe(true);
  });

  it('refuses an admin editing a lesson assigned to another admin (R-02)', async () => {
    const lesson = await prisma.lesson.findFirstOrThrow({
      where: { chapter: { courseId: ids.draft }, deletedAt: null },
    });
    await prisma.lesson.update({ where: { id: lesson.id }, data: { assignedAdminId: ids.adminB } });

    const response = await request(app.getHttpServer())
      .patch(`/api/admin/lessons/${lesson.id}`)
      .set(as(tokens.adminA))
      .send({ title: 'Nope' })
      .expect(403);

    expect(response.body.errorCode).toBe(errorCodes.FORBIDDEN_NOT_ASSIGNED);
    await prisma.lesson.update({ where: { id: lesson.id }, data: { assignedAdminId: null } });
  });

  it('allows an admin on an unassigned lesson whose chapter belongs to someone else', async () => {
    // R-02 is strictly row-level by decision: a chapter assignment does not reach
    // its lessons. Asserted so the decision is visible rather than accidental.
    const chapter = await prisma.chapter.findFirstOrThrow({
      where: { courseId: ids.draft, deletedAt: null, lessons: { some: { deletedAt: null } } },
      include: { lessons: { where: { deletedAt: null } } },
    });
    await prisma.chapter.update({
      where: { id: chapter.id },
      data: { assignedAdminId: ids.adminB },
    });

    await request(app.getHttpServer())
      .patch(`/api/admin/lessons/${chapter.lessons[0]!.id}`)
      .set(as(tokens.adminA))
      .send({ title: 'Allowed by the row-level reading of R-02' })
      .expect(200);

    await prisma.chapter.update({ where: { id: chapter.id }, data: { assignedAdminId: null } });
  });
});

describe('§9.2 categories and pricing', () => {
  it('lets the owner create a category', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/admin/categories')
      .set(as(tokens.owner))
      .send({ slug: `made-${run}`, displayName: 'Made by the owner', displayOrder: 3 })
      .expect(201);

    expect(response.body.slug).toBe(`made-${run}`);
    await prisma.category.delete({ where: { id: response.body.id } });
  });

  it('reports a duplicate slug as a conflict, not a database fault', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/admin/categories')
      .set(as(tokens.owner))
      .send({ slug: `structure-${run}`, displayName: 'Duplicate' })
      .expect(409);

    expect(response.body.errorCode).toBe('CATEGORY_SLUG_TAKEN');
  });

  it('refuses an admin creating a category', async () => {
    await request(app.getHttpServer())
      .post('/api/admin/categories')
      .set(as(tokens.adminA))
      .send({ slug: `nope-${run}`, displayName: 'Nope' })
      .expect(403);
  });

  it('lets the owner switch pricing type, and refuses an admin', async () => {
    const response = await request(app.getHttpServer())
      .patch(`/api/admin/courses/${ids.draft}/pricing-type`)
      .set(as(tokens.owner))
      .send({ pricingType: 'paid' })
      .expect(200);
    expect(response.body.pricingType).toBe('paid');

    await request(app.getHttpServer())
      .patch(`/api/admin/courses/${ids.draft}/pricing-type`)
      .set(as(tokens.adminA))
      .send({ pricingType: 'free' })
      .expect(403);
  });
});
