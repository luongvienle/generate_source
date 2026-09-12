import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { getPrismaClient } from '@knowledge-explorer/database';
import { errorCodes } from '@knowledge-explorer/shared';
import { blockListChecksum, parseLessonMarkdown, type BlockList } from '@knowledge-explorer/content';
import { AppModule } from '../src/app.module';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * §9.3 lesson draft content — the verification table in
 * specs/p2-authoring/spec.md.
 *
 * The guard split is the case no other suite covers: an admin must be able to
 * READ a lesson in a published course (so the editor can explain itself) while
 * the matching WRITE is refused by R-01.
 */

const run = randomBytes(4).toString('hex');
const prisma = getPrismaClient();

let app: INestApplication;
const tokens = { owner: '', adminA: '', adminB: '' };
const ids = {
  owner: '',
  adminA: '',
  adminB: '',
  draftLesson: '',
  assignedLesson: '',
  publishedLesson: '',
};

const as = (token: string) => ({ Cookie: `authjs.session-token=${token}` });

/** Reads the current draftUpdatedAt, so a save carries the token the API expects. */
async function currentToken(lessonId: string, token: string): Promise<string | null> {
  const response = await request(app.getHttpServer())
    .get(`/api/admin/lessons/${lessonId}/content`)
    .set(as(token));
  return response.body.draftUpdatedAt ?? null;
}

/** A save that first reads the current token, as the editor does. */
async function save(lessonId: string, token: string, markdown: string) {
  return request(app.getHttpServer())
    .put(`/api/admin/lessons/${lessonId}/content`)
    .set(as(token))
    .send({ markdown, expectedDraftUpdatedAt: await currentToken(lessonId, token) });
}

const parseOrThrow = (markdown: string): BlockList => {
  const result = parseLessonMarkdown(markdown, null);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.blockList;
};

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

async function seedLesson(
  courseSlugSuffix: string,
  publicationStatus: string,
  levelOrder: number,
  categoryId: string,
  assignedAdminId?: string,
): Promise<string> {
  const course = await prisma.course.create({
    data: {
      categoryId,
      slug: `content-${run}-${courseSlugSuffix}`,
      levelLabel: `L${levelOrder}`,
      levelOrder,
      title: `Course ${courseSlugSuffix}`,
      publicationStatus,
    },
    select: { id: true },
  });
  const chapter = await prisma.chapter.create({
    data: { courseId: course.id, chapterOrder: 1, title: 'Chapter one' },
    select: { id: true },
  });
  const lesson = await prisma.lesson.create({
    data: {
      chapterId: chapter.id,
      lessonOrder: 1,
      title: 'Lesson one',
      ...(assignedAdminId ? { assignedAdminId } : {}),
    },
    select: { id: true },
  });
  return lesson.id;
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
    data: { slug: `content-${run}`, displayName: 'Content' },
    select: { id: true },
  });

  ids.draftLesson = await seedLesson('draft', 'draft', 1, category.id);
  ids.assignedLesson = await seedLesson('assigned', 'draft', 2, category.id, ids.adminB);
  ids.publishedLesson = await seedLesson('published', 'published', 3, category.id);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe('GET /api/admin/lessons/:lessonId/content', () => {
  it('returns an empty shape for a lesson with no lesson_contents row', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/admin/lessons/${ids.draftLesson}/content`)
      .set(as(tokens.owner))
      .expect(200);

    expect(response.body).toMatchObject({
      markdown: '',
      blockList: { blocks: [], nextBlockSeq: 1 },
      draftUpdatedAt: null,
      contentStatus: 'empty',
    });
  });

  it('lets an admin read a lesson in a PUBLISHED course, though the write is refused', async () => {
    await request(app.getHttpServer())
      .get(`/api/admin/lessons/${ids.publishedLesson}/content`)
      .set(as(tokens.adminA))
      .expect(200);

    const write = await request(app.getHttpServer())
      .put(`/api/admin/lessons/${ids.publishedLesson}/content`)
      .set(as(tokens.adminA))
      .send({ markdown: '# Nope' })
      .expect(403);

    expect(write.body.errorCode).toBe(errorCodes.FORBIDDEN_COURSE_PUBLISHED);
  });

  it('404s for an unknown lesson', async () => {
    await request(app.getHttpServer())
      .get(`/api/admin/lessons/${randomBytes(16).toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')}/content`)
      .set(as(tokens.owner))
      .expect(404);
  });
});

describe('PUT /api/admin/lessons/:lessonId/content', () => {
  it('creates the lesson_contents row lazily, and moves empty -> drafting', async () => {
    const markdown = '# The A-row\n\nHiragana is a **syllabary**.\n';

    const response = await save(ids.draftLesson, tokens.owner, markdown);
    expect(response.status).toBe(200);

    expect(response.body.markdown).toBe(markdown);
    expect(response.body.blockList.blocks).toHaveLength(2);
    expect(response.body.blockList.blocks[0]).toMatchObject({
      blockId: 'b1',
      blockType: 'heading',
      depth: 1,
    });
    expect(response.body.lastEditedByUserId).toBe(ids.owner);
    expect(response.body.draftContentChecksum).toMatch(/^[0-9a-f]{64}$/u);
    expect(response.body.contentStatus).toBe('drafting');
  });

  it('stores the block list the SERVER parsed, not one the client supplied', async () => {
    const markdown = '# The A-row\n\nHiragana is a **syllabary**.\n';
    const stored = await prisma.lessonContent.findUnique({
      where: { lessonId: ids.draftLesson },
      select: { draftContentMarkdown: true, draftBlockList: true },
    });

    expect(stored?.draftContentMarkdown).toBe(markdown);
    expect(blockListChecksum(stored?.draftBlockList as never)).toBe(
      blockListChecksum(parseOrThrow(markdown)),
    );
  });

  it('treats byte-identical markdown as a no-op and does not advance draftUpdatedAt', async () => {
    const markdown = '# The A-row\n\nHiragana is a **syllabary**.\n';
    const before = await currentToken(ids.draftLesson, tokens.owner);

    const response = await save(ids.draftLesson, tokens.owner, markdown);
    expect(response.status).toBe(200);

    expect(await currentToken(ids.draftLesson, tokens.owner)).toBe(before);
  });

  it('persists a whitespace-only edit, leaving the checksum unchanged', async () => {
    const before = await request(app.getHttpServer())
      .get(`/api/admin/lessons/${ids.draftLesson}/content`)
      .set(as(tokens.owner));

    const reflowed = '# The A-row\n\nHiragana is\na **syllabary**.\n';
    const response = await save(ids.draftLesson, tokens.owner, reflowed);
    expect(response.status).toBe(200);

    // The markdown moved — the admin keeps their formatting...
    expect(response.body.markdown).toBe(reflowed);
    expect(response.body.draftUpdatedAt).not.toBe(before.body.draftUpdatedAt);
    // ...while the checksum did not, so no narration script goes stale (§6.5).
    expect(response.body.draftContentChecksum).toBe(before.body.draftContentChecksum);
  });

  it('refuses a stale write with 409 and hands back the current content', async () => {
    const stale = new Date(Date.now() - 60_000).toISOString();

    const response = await request(app.getHttpServer())
      .put(`/api/admin/lessons/${ids.draftLesson}/content`)
      .set(as(tokens.owner))
      .send({ markdown: '# Clobbered\n', expectedDraftUpdatedAt: stale })
      .expect(409);

    expect(response.body.errorCode).toBe(errorCodes.LESSON_CONTENT_CONFLICT);
    expect(response.body.current.markdown).toContain('The A-row');

    const after = await prisma.lessonContent.findUnique({
      where: { lessonId: ids.draftLesson },
      select: { draftContentMarkdown: true },
    });
    expect(after?.draftContentMarkdown).not.toContain('Clobbered');
  });

  it('rejects an unsupported construct with every error located, and writes nothing', async () => {
    const before = await prisma.lessonContent.findUnique({
      where: { lessonId: ids.draftLesson },
      select: { draftContentMarkdown: true },
    });

    const response = await save(ids.draftLesson, tokens.owner, '# Title\n\n---\n\n<b>x</b>\n');
    expect(response.status).toBe(422);

    expect(response.body.errorCode).toBe(errorCodes.LESSON_CONTENT_INVALID);
    expect(response.body.errors).toHaveLength(3);
    expect(response.body.errors[0]).toMatchObject({ line: 3, column: 1 });

    const after = await prisma.lessonContent.findUnique({
      where: { lessonId: ids.draftLesson },
      select: { draftContentMarkdown: true },
    });
    expect(after?.draftContentMarkdown).toBe(before?.draftContentMarkdown);
  });

  it('keeps contentStatus at drafting when the body is cleared', async () => {
    const response = await save(ids.draftLesson, tokens.owner, '');
    expect(response.status).toBe(200);
    expect(response.body.contentStatus).toBe('drafting');
  });
});

describe('has_unpublished_changes (§4.3)', () => {
  const published = () =>
    prisma.course.findFirst({
      where: { slug: `content-${run}-published` },
      select: { id: true, hasUnpublishedChanges: true },
    });

  it('is raised when the owner changes published content', async () => {
    expect((await published())?.hasUnpublishedChanges).toBe(false);

    const response = await save(ids.publishedLesson, tokens.owner, '# Owner edit\n');
    expect(response.status).toBe(200);

    expect((await published())?.hasUnpublishedChanges).toBe(true);
  });

  it('is NOT raised by a whitespace-only edit', async () => {
    const course = await published();
    await prisma.course.update({
      where: { id: course!.id },
      data: { hasUnpublishedChanges: false },
    });

    const response = await save(ids.publishedLesson, tokens.owner, '# Owner    edit\n');
    expect(response.status).toBe(200);

    expect((await published())?.hasUnpublishedChanges).toBe(false);
  });
});

describe('R-01 and R-02 on the content routes', () => {
  it('refuses an admin writing a lesson assigned to someone else (R-02)', async () => {
    const response = await save(ids.assignedLesson, tokens.adminA, '# Mine now\n');

    expect(response.status).toBe(403);
    expect(response.body.errorCode).toBe(errorCodes.FORBIDDEN_NOT_ASSIGNED);
  });

  it('allows the assigned admin, and any admin on an unassigned lesson', async () => {
    expect((await save(ids.assignedLesson, tokens.adminB, 'Assigned admin writes.\n')).status).toBe(200);
    expect((await save(ids.draftLesson, tokens.adminA, 'Any admin writes.\n')).status).toBe(200);
  });

  it('reports canEdit and the reason the PUT would give', async () => {
    const ownerOnPublished = await request(app.getHttpServer())
      .get(`/api/admin/lessons/${ids.publishedLesson}/content`)
      .set(as(tokens.owner))
      .expect(200);
    expect(ownerOnPublished.body).toMatchObject({ canEdit: true, readOnlyReason: null });

    const adminOnPublished = await request(app.getHttpServer())
      .get(`/api/admin/lessons/${ids.publishedLesson}/content`)
      .set(as(tokens.adminA))
      .expect(200);
    expect(adminOnPublished.body).toMatchObject({
      canEdit: false,
      readOnlyReason: errorCodes.FORBIDDEN_COURSE_PUBLISHED,
    });

    const adminOnAssigned = await request(app.getHttpServer())
      .get(`/api/admin/lessons/${ids.assignedLesson}/content`)
      .set(as(tokens.adminA))
      .expect(200);
    expect(adminOnAssigned.body).toMatchObject({
      canEdit: false,
      readOnlyReason: errorCodes.FORBIDDEN_NOT_ASSIGNED,
    });

    const assignedAdmin = await request(app.getHttpServer())
      .get(`/api/admin/lessons/${ids.assignedLesson}/content`)
      .set(as(tokens.adminB))
      .expect(200);
    expect(assignedAdmin.body).toMatchObject({ canEdit: true, readOnlyReason: null });
  });
});
