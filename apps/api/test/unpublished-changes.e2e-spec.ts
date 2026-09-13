import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { getPrismaClient } from '@knowledge-explorer/database';
import {
  blockListChecksum,
  buildSegment,
  parseLessonMarkdown,
  scriptChecksum,
  type Block,
} from '@knowledge-explorer/content';
import { AppModule } from '../src/app.module';
import { REDIS_URL } from '../src/jobs/import.queue';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * FR-PUB-03 across every admin write path.
 *
 * Before P6 exactly two paths set `has_unpublished_changes` — the draft save and
 * a re-import — so an owner could select a new illustration, rewrite a narration
 * segment or reorder the whole course and never be told the live course had
 * moved on. This suite walks the endpoints one at a time so a path added later
 * without the flag fails here rather than being discovered by a learner.
 *
 * Every write uses the OWNER token: R-01 refuses a non-owner on a published
 * course, which is the subject of rbac.e2e-spec.ts rather than this file.
 */

const run = randomBytes(4).toString('hex');
const prisma = getPrismaClient();
const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6380';

let app: INestApplication;
let categoryId = '';
let ownerId = '';
let ownerToken = '';
let levelOrder = 0;

const as = (token: string) => ({ Cookie: `authjs.session-token=${token}` });
const api = () => request(app.getHttpServer());

const BODY = '# Writing systems\n\nJapanese uses three scripts.\n\n::figure\n';

async function seedCourse(suffix: string, publicationStatus: string) {
  levelOrder += 1;
  const course = await prisma.course.create({
    data: {
      categoryId,
      slug: `flag-${run}-${suffix}`,
      levelLabel: `L${levelOrder}`,
      levelOrder,
      title: `Course ${suffix}`,
      publicationStatus,
      languageCode: 'vi',
    },
    select: { id: true },
  });
  const chapter = await prisma.chapter.create({
    data: { courseId: course.id, chapterOrder: 1, title: 'Chapter one' },
    select: { id: true },
  });
  const lesson = await prisma.lesson.create({
    data: { chapterId: chapter.id, lessonOrder: 1, title: 'Lesson one', contentStatus: 'drafting' },
    select: { id: true },
  });

  const parsed = parseLessonMarkdown(BODY, null);
  if (!parsed.ok) throw new Error('seed markdown did not parse');
  await prisma.lessonContent.create({
    data: {
      lessonId: lesson.id,
      draftContentMarkdown: BODY,
      draftBlockList: parsed.blockList as unknown as object,
      draftContentChecksum: blockListChecksum(parsed.blockList),
      draftUpdatedAt: new Date(),
    },
  });

  const figure = parsed.blockList.blocks.find((block) => block.blockType === 'figure')!;
  const image = await prisma.lessonImage.create({
    data: {
      lessonId: lesson.id,
      blockReferenceId: figure.blockId,
      figureNumber: 1,
      imageFileUrl: `lessons/${lesson.id}/images/a.png`,
      captionText: 'A caption',
      alternativeText: 'Alt text',
      imageSource: 'ai_generated',
      isSelected: true,
    },
    select: { id: true },
  });

  const segments = (parsed.blockList.blocks as Block[]).map((block, index) =>
    buildSegment({ block, segmentOrder: index, narrationText: `Đọc ${block.blockId}.`, isEdited: false }),
  );
  const checksum = scriptChecksum(segments);
  await prisma.narrationScript.create({
    data: {
      lessonId: lesson.id,
      scriptSegments: { segments, totalEstimatedSeconds: 30 } as unknown as object,
      scriptChecksum: checksum,
      sourceContentChecksum: blockListChecksum(parsed.blockList),
      scriptStatus: 'ready',
    },
  });

  return {
    courseId: course.id,
    chapterId: chapter.id,
    lessonId: lesson.id,
    imageId: image.id,
    scriptChecksum: checksum,
    firstBlockId: parsed.blockList.blocks[0]!.blockId,
  };
}

const flagOf = async (courseId: string): Promise<boolean> =>
  (
    await prisma.course.findUnique({
      where: { id: courseId },
      select: { hasUnpublishedChanges: true },
    })
  )?.hasUnpublishedChanges ?? false;

const clearFlag = (courseId: string) =>
  prisma.course.update({ where: { id: courseId }, data: { hasUnpublishedChanges: false } });

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(REDIS_URL)
    .useValue(redisUrl)
    .compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api', { exclude: ['health'] });
  await app.init();

  const owner = await prisma.user.create({
    data: { email: `flag-owner-${run}@example.test`, name: 'owner', userRole: 'admin_owner' },
    select: { id: true },
  });
  ownerId = owner.id;
  ownerToken = `tok-flag-${run}`;
  await prisma.session.create({
    data: { sessionToken: ownerToken, userId: ownerId, expires: new Date(Date.now() + 3_600_000) },
  });

  const category = await prisma.category.create({
    data: { slug: `flag-${run}`, displayName: 'Flag' },
    select: { id: true },
  });
  categoryId = category.id;
});

afterAll(async () => {
  await app?.close();
});

describe('FR-PUB-03 on a published course', () => {
  let seed: Awaited<ReturnType<typeof seedCourse>>;

  beforeEach(async () => {
    seed = await seedCourse(randomBytes(3).toString('hex'), 'published');
    await clearFlag(seed.courseId);
    expect(await flagOf(seed.courseId)).toBe(false);
  });

  it('flags a draft content save', async () => {
    const current = await api()
      .get(`/api/admin/lessons/${seed.lessonId}/content`)
      .set(as(ownerToken));
    await api()
      .put(`/api/admin/lessons/${seed.lessonId}/content`)
      .set(as(ownerToken))
      .send({
        markdown: `${BODY}\nA new paragraph.\n`,
        expectedDraftUpdatedAt: (current.body as { draftUpdatedAt: string }).draftUpdatedAt,
      })
      .expect(200);

    expect(await flagOf(seed.courseId)).toBe(true);
  });

  it('flags a new chapter', async () => {
    await api()
      .post('/api/admin/chapters')
      .set(as(ownerToken))
      .send({ courseId: seed.courseId, chapterOrder: 2, title: 'Chapter two' })
      .expect(201);

    expect(await flagOf(seed.courseId)).toBe(true);
  });

  it('flags a chapter edit', async () => {
    await api()
      .patch(`/api/admin/chapters/${seed.chapterId}`)
      .set(as(ownerToken))
      .send({ title: 'Renamed chapter' })
      .expect(200);

    expect(await flagOf(seed.courseId)).toBe(true);
  });

  it('flags a chapter soft delete', async () => {
    await api()
      .delete(`/api/admin/chapters/${seed.chapterId}`)
      .set(as(ownerToken))
      .expect(200);

    expect(await flagOf(seed.courseId)).toBe(true);
  });

  it('flags a new lesson', async () => {
    await api()
      .post('/api/admin/lessons')
      .set(as(ownerToken))
      .send({ chapterId: seed.chapterId, lessonOrder: 2, title: 'Lesson two' })
      .expect(201);

    expect(await flagOf(seed.courseId)).toBe(true);
  });

  it('flags a lesson edit', async () => {
    await api()
      .patch(`/api/admin/lessons/${seed.lessonId}`)
      .set(as(ownerToken))
      .send({ title: 'Renamed lesson' })
      .expect(200);

    expect(await flagOf(seed.courseId)).toBe(true);
  });

  it('flags a free-preview toggle', async () => {
    // P7 added `isFreePreview` to the same PATCH, so it inherits this flagging
    // rather than adding a second markUnpublishedChangesForLesson call. It is in
    // §4.3's snapshot, so a publish genuinely has to catch up on it.
    const response = await api()
      .patch(`/api/admin/lessons/${seed.lessonId}`)
      .set(as(ownerToken))
      .send({ isFreePreview: true })
      .expect(200);

    expect((response.body as { isFreePreview: boolean }).isFreePreview).toBe(true);
    expect(await flagOf(seed.courseId)).toBe(true);
  });

  it('flags a lesson soft delete', async () => {
    await api()
      .delete(`/api/admin/lessons/${seed.lessonId}`)
      .set(as(ownerToken))
      .expect(200);

    expect(await flagOf(seed.courseId)).toBe(true);
  });

  it('flags a structure reorder', async () => {
    await api()
      .patch(`/api/admin/courses/${seed.courseId}/structure`)
      .set(as(ownerToken))
      .send({ chapters: [{ chapterId: seed.chapterId, lessonIds: [seed.lessonId] }] })
      .expect(200);

    expect(await flagOf(seed.courseId)).toBe(true);
  });

  it('flags an image caption edit', async () => {
    await api()
      .patch(`/api/admin/images/${seed.imageId}`)
      .set(as(ownerToken))
      .send({ captionText: 'A better caption' })
      .expect(200);

    expect(await flagOf(seed.courseId)).toBe(true);
  });

  it('flags a narration segment edit', async () => {
    await api()
      .put(`/api/admin/lessons/${seed.lessonId}/narration-script`)
      .set(as(ownerToken))
      .send({
        scriptChecksum: seed.scriptChecksum,
        segments: [{ blockId: seed.firstBlockId, narrationText: 'Một bản đọc mới.' }],
      })
      .expect(200);

    expect(await flagOf(seed.courseId)).toBe(true);
  });
});

describe('FR-PUB-03 on a course that is not published', () => {
  it('leaves the flag alone on a draft course, which has nothing to differ from', async () => {
    const seed = await seedCourse(randomBytes(3).toString('hex'), 'draft');

    await api()
      .patch(`/api/admin/lessons/${seed.lessonId}`)
      .set(as(ownerToken))
      .send({ title: 'Renamed while draft' })
      .expect(200);
    await api()
      .patch(`/api/admin/images/${seed.imageId}`)
      .set(as(ownerToken))
      .send({ captionText: 'Caption while draft' })
      .expect(200);

    expect(await flagOf(seed.courseId)).toBe(false);
  });

  it('leaves the flag alone on an unpublished course', async () => {
    const seed = await seedCourse(randomBytes(3).toString('hex'), 'unpublished');

    await api()
      .patch(`/api/admin/lessons/${seed.lessonId}`)
      .set(as(ownerToken))
      .send({ title: 'Renamed while withdrawn' })
      .expect(200);

    expect(await flagOf(seed.courseId)).toBe(false);
  });
});
