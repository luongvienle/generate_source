import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { getPrismaClient } from '@knowledge-explorer/database';
import { errorCodes } from '@knowledge-explorer/shared';
import { AppModule } from '../src/app.module';
import { ImageQueue } from '../src/jobs/image.queue';
import { REDIS_URL } from '../src/jobs/import.queue';
import { ImagesService } from '../src/content/images.service';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * §5.4 images — the verification table in specs/p3-images/spec.md.
 *
 * Runs against a real Postgres and a real MinIO, because the things worth
 * asserting here are exactly the ones a mocked store would not catch: that the
 * stored bytes are the SANITIZED bytes, and that a presigned URL actually
 * serves them.
 */

const run = randomBytes(4).toString('hex');
const prisma = getPrismaClient();
const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6380';
/** A queue of this suite's own, so enqueued jobs never leak into a shared one. */
const queueName = `image-e2e-${run}`;
let imageQueue: ImageQueue;

let app: INestApplication;
const tokens = { owner: '', adminA: '', adminB: '' };
const ids = {
  owner: '',
  adminA: '',
  adminB: '',
  draftLesson: '',
  assignedLesson: '',
  publishedLesson: '',
  noFigureLesson: '',
  secondChapterLesson: '',
  courseId: '',
};

const as = (token: string) => ({ Cookie: `authjs.session-token=${token}` });

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
// RIFF....WEBP — enough of a header for the sniffer, which is all that is read.
const webp = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WEBPVP8 '),
  Buffer.alloc(16),
]);
const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n');
const hostileSvg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="alert(1)">' +
    '<script>alert(2)</script><rect width="5" height="5" fill="#123456"/></svg>',
);

async function seedUser(local: string, userRole: string): Promise<[string, string]> {
  const user = await prisma.user.create({
    data: { email: `${local}-img-${run}@example.test`, name: local, userRole },
    select: { id: true },
  });
  const sessionToken = `tok-img-${run}-${randomBytes(6).toString('hex')}`;
  await prisma.session.create({
    data: { sessionToken, userId: user.id, expires: new Date(Date.now() + 3_600_000) },
  });
  return [user.id, sessionToken];
}

async function seedLesson(
  suffix: string,
  publicationStatus: string,
  levelOrder: number,
  categoryId: string,
  assignedAdminId?: string,
): Promise<{ lessonId: string; courseId: string }> {
  const course = await prisma.course.create({
    data: {
      categoryId,
      slug: `images-${run}-${suffix}`,
      levelLabel: `L${levelOrder}`,
      levelOrder,
      title: `Course ${suffix}`,
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
  return { lessonId: lesson.id, courseId: course.id };
}

/** Saves markdown through the real endpoint, so the stored block list is authoritative. */
async function saveContent(lessonId: string, token: string, markdown: string): Promise<void> {
  const current = await request(app.getHttpServer())
    .get(`/api/admin/lessons/${lessonId}/content`)
    .set(as(token));

  await request(app.getHttpServer())
    .put(`/api/admin/lessons/${lessonId}/content`)
    .set(as(token))
    .send({ markdown, expectedDraftUpdatedAt: current.body.draftUpdatedAt ?? null })
    .expect(200);
}

const readImages = async (lessonId: string, token: string) =>
  request(app.getHttpServer())
    .get(`/api/admin/lessons/${lessonId}/images`)
    .set(as(token))
    .expect(200);

const upload = (lessonId: string, token: string, blockReferenceId: string, file: Buffer, name: string) =>
  request(app.getHttpServer())
    .post(`/api/admin/lessons/${lessonId}/images/upload`)
    .set(as(token))
    .field('blockReferenceId', blockReferenceId)
    .attach('file', file, name);

const figureIds = async (lessonId: string, token: string): Promise<string[]> => {
  const response = await readImages(lessonId, token);
  return response.body.figures.map((figure: { blockId: string }) => figure.blockId);
};

const TWO_FIGURES = '# Lesson\n\n::figure\n\nSome prose.\n\n::figure\n';

beforeAll(async () => {
  imageQueue = new ImageQueue(redisUrl, queueName);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(REDIS_URL)
    .useValue(redisUrl)
    .overrideProvider(ImageQueue)
    .useValue(imageQueue)
    .compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api', { exclude: ['health'] });
  await app.init();

  [ids.owner, tokens.owner] = await seedUser('owner', 'admin_owner');
  [ids.adminA, tokens.adminA] = await seedUser('admin-a', 'admin');
  [ids.adminB, tokens.adminB] = await seedUser('admin-b', 'admin');

  const category = await prisma.category.create({
    data: { slug: `images-${run}`, displayName: 'Images' },
    select: { id: true },
  });

  const draft = await seedLesson('draft', 'draft', 1, category.id);
  ids.draftLesson = draft.lessonId;
  ids.courseId = draft.courseId;
  ids.assignedLesson = (await seedLesson('assigned', 'draft', 2, category.id, ids.adminB)).lessonId;
  ids.publishedLesson = (await seedLesson('published', 'published', 3, category.id)).lessonId;
  ids.noFigureLesson = (await seedLesson('nofigure', 'draft', 4, category.id)).lessonId;

  // A second lesson in the same course, for the NFR-05 roll-up.
  const secondChapter = await prisma.chapter.create({
    data: { courseId: ids.courseId, chapterOrder: 2, title: 'Chapter two' },
    select: { id: true },
  });
  const second = await prisma.lesson.create({
    data: { chapterId: secondChapter.id, lessonOrder: 1, title: 'Lesson two' },
    select: { id: true },
  });
  ids.secondChapterLesson = second.id;

  await saveContent(ids.draftLesson, tokens.owner, TWO_FIGURES);
  await saveContent(ids.noFigureLesson, tokens.owner, '# No figures here\n\nJust prose.\n');
  await saveContent(ids.assignedLesson, tokens.owner, TWO_FIGURES);
  await saveContent(ids.publishedLesson, tokens.owner, TWO_FIGURES);
  await saveContent(ids.secondChapterLesson, tokens.owner, '::figure\n');
}, 60_000);

afterAll(async () => {
  await imageQueue?.queue.obliterate({ force: true });
  await app?.close();
  await prisma.$disconnect();
});

describe('GET /api/admin/lessons/:lessonId/images', () => {
  it('returns one entry per figure block, in document order, with its number', async () => {
    const response = await readImages(ids.draftLesson, tokens.owner);

    expect(response.body.figures).toHaveLength(2);
    expect(response.body.figures.map((f: { figureNumber: number }) => f.figureNumber)).toEqual([
      1, 2,
    ]);
    expect(response.body.figures[0].candidates).toEqual([]);
    expect(response.body.figures[0].selectedImageId).toBeNull();
  });

  it('reports a lesson with no figure blocks as complete', async () => {
    const response = await readImages(ids.noFigureLesson, tokens.owner);

    expect(response.body.figures).toEqual([]);
    expect(response.body.isComplete).toBe(true);
  });

  it('lets an admin read a published lesson read-only, while the write is refused', async () => {
    const response = await readImages(ids.publishedLesson, tokens.adminA);
    expect(response.body.canEdit).toBe(false);
    expect(response.body.readOnlyReason).toBe(errorCodes.FORBIDDEN_COURSE_PUBLISHED);

    const [figure] = await figureIds(ids.publishedLesson, tokens.adminA);
    const write = await upload(ids.publishedLesson, tokens.adminA, figure!, png, 'a.png');

    expect(write.status).toBe(403);
    expect(write.body.errorCode).toBe(errorCodes.FORBIDDEN_COURSE_PUBLISHED);
  });
});

describe('POST /api/admin/lessons/:lessonId/images/upload', () => {
  it('stores a WebP as an uploaded candidate with no model or provider', async () => {
    const [figure] = await figureIds(ids.draftLesson, tokens.owner);
    const response = await upload(ids.draftLesson, tokens.owner, figure!, webp, 'diagram.webp');

    expect(response.status).toBe(201);
    const [candidate] = response.body.candidates;
    expect(candidate.imageSource).toBe('uploaded');
    expect(candidate.imageModelName).toBeNull();
    expect(candidate.imageProviderName).toBeNull();
    expect(candidate.isSelected).toBe(false);
  });

  it('refuses a PDF renamed .png — the filename is never consulted', async () => {
    const [figure] = await figureIds(ids.draftLesson, tokens.owner);
    const response = await upload(ids.draftLesson, tokens.owner, figure!, pdf, 'not-really.png');

    expect(response.status).toBe(422);
    expect(response.body.errorCode).toBe(errorCodes.IMAGE_TYPE_UNSUPPORTED);
  });

  it('refuses a file over 5 MB, from inside the interceptor', async () => {
    // Multer aborts before the whole body is buffered and throws a MulterError,
    // which is not an HttpException — MulterExceptionFilter is what turns it
    // into the same 422 and errorCode the byte-level check produces.
    const [figure] = await figureIds(ids.draftLesson, tokens.owner);
    const oversize = Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]);

    const response = await upload(ids.draftLesson, tokens.owner, figure!, oversize, 'big.png');

    expect(response.status).toBe(422);
    expect(response.body.errorCode).toBe(errorCodes.IMAGE_TOO_LARGE);
  });

  it('refuses an unknown blockReferenceId and writes nothing', async () => {
    const before = await prisma.lessonImage.count({ where: { lessonId: ids.draftLesson } });

    const response = await upload(ids.draftLesson, tokens.owner, 'fig-nope', png, 'a.png');
    expect(response.status).toBe(422);
    expect(response.body.errorCode).toBe(errorCodes.IMAGE_BLOCK_NOT_FOUND);

    expect(await prisma.lessonImage.count({ where: { lessonId: ids.draftLesson } })).toBe(before);
  });

  it('serves an uploaded SVG with its script stripped', async () => {
    const [figure] = await figureIds(ids.draftLesson, tokens.owner);
    const response = await upload(ids.draftLesson, tokens.owner, figure!, hostileSvg, 'd.svg');
    expect(response.status).toBe(201);

    const stored = await fetch(response.body.candidates[0].url);
    const served = await stored.text();

    // The bytes in the store are the sanitized ones; there is no path to the original.
    expect(served).not.toContain('<script');
    expect(served).not.toContain('onload');
    expect(served).toContain('#123456');
  });
});

describe('PATCH /api/admin/images/:imageId', () => {
  it('keeps exactly one candidate selected, however often selection moves', async () => {
    const [figure] = await figureIds(ids.assignedLesson, tokens.owner);
    const uploaded = await Promise.all([
      upload(ids.assignedLesson, tokens.owner, figure!, png, 'a.png'),
      upload(ids.assignedLesson, tokens.owner, figure!, png, 'b.png'),
      upload(ids.assignedLesson, tokens.owner, figure!, png, 'c.png'),
    ]);
    const candidateIds = uploaded.map((response) => response.body.candidates[0].imageId as string);

    for (const imageId of candidateIds) {
      await request(app.getHttpServer())
        .patch(`/api/admin/images/${imageId}`)
        .set(as(tokens.owner))
        .send({ isSelected: true })
        .expect(200);
    }

    const selected = await prisma.lessonImage.count({
      where: { lessonId: ids.assignedLesson, blockReferenceId: figure!, isSelected: true },
    });
    expect(selected).toBe(1);
  });

  it('leaves a different figure of the same lesson untouched', async () => {
    const [first, second] = await figureIds(ids.assignedLesson, tokens.owner);
    const other = await upload(ids.assignedLesson, tokens.owner, second!, png, 'other.png');

    await request(app.getHttpServer())
      .patch(`/api/admin/images/${other.body.candidates[0].imageId}`)
      .set(as(tokens.owner))
      .send({ isSelected: true })
      .expect(200);

    const firstStillSelected = await prisma.lessonImage.count({
      where: { lessonId: ids.assignedLesson, blockReferenceId: first!, isSelected: true },
    });
    expect(firstStillSelected).toBe(1);
  });

  it('carries caption and alt text forward when selection moves', async () => {
    const [figure] = await figureIds(ids.draftLesson, tokens.owner);
    const a = await upload(ids.draftLesson, tokens.owner, figure!, png, 'a.png');
    const b = await upload(ids.draftLesson, tokens.owner, figure!, png, 'b.png');
    const aId = a.body.candidates[0].imageId;
    const bId = b.body.candidates[0].imageId;

    await request(app.getHttpServer())
      .patch(`/api/admin/images/${aId}`)
      .set(as(tokens.owner))
      .send({ isSelected: true, captionText: 'Stroke order', alternativeText: 'Three strokes' })
      .expect(200);

    const afterSwitch = await request(app.getHttpServer())
      .patch(`/api/admin/images/${bId}`)
      .set(as(tokens.owner))
      .send({ isSelected: true })
      .expect(200);

    // They describe the figure, not the candidate: the admin writes them once.
    expect(afterSwitch.body.captionText).toBe('Stroke order');
    expect(afterSwitch.body.alternativeText).toBe('Three strokes');
    expect(afterSwitch.body.selectedImageId).toBe(bId);
  });

  it('accepts a caption on a candidate that is not selected', async () => {
    const [, second] = await figureIds(ids.draftLesson, tokens.owner);
    const uploaded = await upload(ids.draftLesson, tokens.owner, second!, png, 'c.png');

    await request(app.getHttpServer())
      .patch(`/api/admin/images/${uploaded.body.candidates[0].imageId}`)
      .set(as(tokens.owner))
      .send({ captionText: 'written before choosing' })
      .expect(200);

    const row = await prisma.lessonImage.findUnique({
      where: { id: uploaded.body.candidates[0].imageId },
      select: { captionText: true, isSelected: true },
    });
    expect(row?.captionText).toBe('written before choosing');
    expect(row?.isSelected).toBe(false);
  });

  it('404s an image that does not exist', async () => {
    const response = await request(app.getHttpServer())
      .patch('/api/admin/images/00000000-0000-0000-0000-000000000000')
      .set(as(tokens.owner))
      .send({ isSelected: true });

    expect(response.status).toBe(404);
    expect(response.body.errorCode).toBe(errorCodes.IMAGE_NOT_FOUND);
  });
});

describe('image completeness (FR-IMG-03)', () => {
  it('needs a selection and both text fields, and writes no status column', async () => {
    const lesson = (await seedLesson('complete', 'draft', 5, (await prisma.category.findFirstOrThrow({ where: { slug: `images-${run}` } })).id)).lessonId;
    await saveContent(lesson, tokens.owner, '::figure\n');
    const [figure] = await figureIds(lesson, tokens.owner);

    const statusBefore = await prisma.lesson.findUnique({
      where: { id: lesson },
      select: { contentStatus: true },
    });

    const uploaded = await upload(lesson, tokens.owner, figure!, png, 'a.png');
    const imageId = uploaded.body.candidates[0].imageId;

    const unselected = await readImages(lesson, tokens.owner);
    expect(unselected.body.isComplete).toBe(false);

    const selectResponse = await request(app.getHttpServer())
      .patch(`/api/admin/images/${imageId}`)
      .set(as(tokens.owner))
      .send({ isSelected: true });
    expect(
      selectResponse.status,
      `select failed: ${JSON.stringify(selectResponse.body)} imageId=${String(imageId)}`,
    ).toBe(200);
    expect((await readImages(lesson, tokens.owner)).body.isComplete).toBe(false);

    await request(app.getHttpServer())
      .patch(`/api/admin/images/${imageId}`)
      .set(as(tokens.owner))
      .send({ captionText: 'A caption', alternativeText: '   ' })
      .expect(200);
    // Whitespace-only alt text is not alt text.
    expect((await readImages(lesson, tokens.owner)).body.isComplete).toBe(false);

    await request(app.getHttpServer())
      .patch(`/api/admin/images/${imageId}`)
      .set(as(tokens.owner))
      .send({ alternativeText: 'What the picture shows' })
      .expect(200);
    expect((await readImages(lesson, tokens.owner)).body.isComplete).toBe(true);

    const statusAfter = await prisma.lesson.findUnique({
      where: { id: lesson },
      select: { contentStatus: true },
    });
    // P3 changes no status column; the drafting → ready transition is P6's.
    expect(statusAfter?.contentStatus).toBe(statusBefore?.contentStatus);
  });

  it('hides rows whose figure block was removed, without deleting them', async () => {
    const categoryId = (
      await prisma.category.findFirstOrThrow({ where: { slug: `images-${run}` } })
    ).id;
    const lesson = (await seedLesson('orphan', 'draft', 6, categoryId)).lessonId;
    await saveContent(lesson, tokens.owner, '::figure\n');
    const [figure] = await figureIds(lesson, tokens.owner);
    await upload(lesson, tokens.owner, figure!, png, 'a.png');

    // The admin deletes the figure line and saves.
    await saveContent(lesson, tokens.owner, 'Just prose now.\n');

    const response = await readImages(lesson, tokens.owner);
    expect(response.body.figures).toEqual([]);

    // The row survives: a lesson-body edit never destroys generated work.
    expect(await prisma.lessonImage.count({ where: { lessonId: lesson } })).toBe(1);
  });
});

describe('NFR-05 image counts', () => {
  /**
   * Derived from rows rather than a counter column. §9.2's endpoint that would
   * expose this is deferred to P10 — §3 has no permission row for viewing cost
   * data — so the derivation is asserted directly, ready for that phase.
   */
  it('counts generated candidates per lesson and rolls them up per course', async () => {
    const service = app.get(ImagesService);

    const generated = (lessonId: string, blockReferenceId: string, n: number) =>
      prisma.lessonImage.createMany({
        data: Array.from({ length: n }, (_, index) => ({
          lessonId,
          blockReferenceId,
          imageFileUrl: `lessons/${lessonId}/${blockReferenceId}/gen-${run}-${index}.png`,
          captionText: '',
          alternativeText: '',
          imageSource: 'ai_generated',
        })),
      });

    const before = await service.generatedImageCounts(ids.courseId);

    const [figure] = await figureIds(ids.draftLesson, tokens.owner);
    const [otherFigure] = await figureIds(ids.secondChapterLesson, tokens.owner);
    await generated(ids.draftLesson, figure!, 4);
    await generated(ids.secondChapterLesson, otherFigure!, 2);

    const after = await service.generatedImageCounts(ids.courseId);

    // Both chapters roll up into the one course.
    expect(after.total - before.total).toBe(6);
    expect((after.perLesson[ids.draftLesson] ?? 0) - (before.perLesson[ids.draftLesson] ?? 0)).toBe(4);
    expect(after.perLesson[ids.secondChapterLesson]).toBe(2);
  });

  it('ignores uploads, which cost nothing', async () => {
    const service = app.get(ImagesService);
    const before = await service.generatedImageCounts(ids.courseId);

    const [figure] = await figureIds(ids.draftLesson, tokens.owner);
    await upload(ids.draftLesson, tokens.owner, figure!, png, 'not-counted.png');

    const after = await service.generatedImageCounts(ids.courseId);
    expect(after.total).toBe(before.total);
  });
});

describe('POST /api/admin/lessons/:lessonId/images/generate', () => {
  const generate = (lessonId: string, token: string, body: object) =>
    request(app.getHttpServer())
      .post(`/api/admin/lessons/${lessonId}/images/generate`)
      .set(as(token))
      .send(body);

  /** Job ids are qualified `image:<n>`; BullMQ itself wants the bare counter. */
  const bare = (jobId: string) => jobId.replace(/^image:/u, '');

  it('returns 202 and records a generate_image job targeting the lesson', async () => {
    const [figure] = await figureIds(ids.draftLesson, tokens.owner);
    const response = await generate(ids.draftLesson, tokens.owner, {
      blockReferenceId: figure,
      imagePromptText: 'Three hiragana characters written stroke by stroke',
      candidateCount: 3,
    });

    expect(response.status).toBe(202);
    expect(response.body.jobId).toMatch(/^image:/u);

    const row = await prisma.generationJob.findUniqueOrThrow({
      where: { id: response.body.generationJobId },
    });
    expect(row.jobType).toBe('generate_image');
    // targetEntityId is the lesson: the column is a UUID and a blockId is not.
    expect(row.targetEntityId).toBe(ids.draftLesson);
    expect(row.jobStatus).toBe('queued');

    // The composed, versioned prompt travels with the job (NFR-08).
    const job = await imageQueue.queue.getJob(bare(response.body.jobId));
    expect(job?.data.blockReferenceId).toBe(figure);
    expect(job?.data.composedPrompt).toContain('[image/v1]');
    expect(job?.data.composedPrompt).toContain('Three hiragana characters');
    expect(job?.data.candidateCount).toBe(3);
  });

  it('defaults candidateCount to 4 and refuses 1 or 5', async () => {
    const [figure] = await figureIds(ids.draftLesson, tokens.owner);

    const defaulted = await generate(ids.draftLesson, tokens.owner, {
      blockReferenceId: figure,
      imagePromptText: 'A diagram',
    });
    expect(defaulted.status).toBe(202);
    expect((await imageQueue.queue.getJob(bare(defaulted.body.jobId)))?.data.candidateCount).toBe(4);

    for (const candidateCount of [1, 5]) {
      const response = await generate(ids.draftLesson, tokens.owner, {
        blockReferenceId: figure,
        imagePromptText: 'A diagram',
        candidateCount,
      });
      expect(response.status).toBe(400);
    }
  });

  it('refuses an unknown block, writing no row and enqueuing nothing', async () => {
    const jobsBefore = await prisma.generationJob.count({
      where: { targetEntityId: ids.draftLesson, jobType: 'generate_image' },
    });
    const queuedBefore = await imageQueue.queue.getJobCountByTypes('waiting', 'delayed', 'active');

    const response = await generate(ids.draftLesson, tokens.owner, {
      blockReferenceId: 'fig-nope',
      imagePromptText: 'A diagram',
    });

    expect(response.status).toBe(422);
    expect(response.body.errorCode).toBe(errorCodes.IMAGE_BLOCK_NOT_FOUND);
    expect(
      await prisma.generationJob.count({
        where: { targetEntityId: ids.draftLesson, jobType: 'generate_image' },
      }),
    ).toBe(jobsBefore);
    expect(await imageQueue.queue.getJobCountByTypes('waiting', 'delayed', 'active')).toBe(
      queuedBefore,
    );
  });

  it('applies R-01 to generation, as it does to every other image write', async () => {
    const [figure] = await figureIds(ids.publishedLesson, tokens.adminA);
    const response = await generate(ids.publishedLesson, tokens.adminA, {
      blockReferenceId: figure,
      imagePromptText: 'A diagram',
    });

    expect(response.status).toBe(403);
    expect(response.body.errorCode).toBe(errorCodes.FORBIDDEN_COURSE_PUBLISHED);
  });
});

describe('candidate ordering', () => {
  it('is stable across reads, though a generation shares one timestamp', async () => {
    // createMany gives every candidate of one job the same createdAt, so
    // ordering by it alone reshuffles between reads and the drawer's "second
    // candidate" stops being the same picture.
    const categoryId = (
      await prisma.category.findFirstOrThrow({ where: { slug: `images-${run}` } })
    ).id;
    const lesson = (await seedLesson('ordering', 'draft', 7, categoryId)).lessonId;
    await saveContent(lesson, tokens.owner, '::figure\n');
    const [figure] = await figureIds(lesson, tokens.owner);

    const sharedTimestamp = new Date();
    await prisma.lessonImage.createMany({
      data: Array.from({ length: 6 }, (_, index) => ({
        lessonId: lesson,
        blockReferenceId: figure!,
        imageFileUrl: `lessons/${lesson}/${figure}/order-${index}.png`,
        captionText: '',
        alternativeText: '',
        imageSource: 'ai_generated',
        createdAt: sharedTimestamp,
      })),
    });

    const first = await readImages(lesson, tokens.owner);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const again = await readImages(lesson, tokens.owner);
      expect(again.body.figures[0].candidates.map((c: { imageId: string }) => c.imageId)).toEqual(
        first.body.figures[0].candidates.map((c: { imageId: string }) => c.imageId),
      );
    }
  });
});
