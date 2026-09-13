import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { getPrismaClient, loadPublishChecklistInput } from '@knowledge-explorer/database';
import { blockListChecksum, buildSegment, parseLessonMarkdown, scriptChecksum, type Block } from '@knowledge-explorer/content';
import { AppModule } from '../src/app.module';
import { REDIS_URL } from '../src/jobs/import.queue';
import { PublishQueue } from '../src/jobs/publish.queue';
import { JobStatusService } from '../src/jobs/job-status.service';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * §5.7 publishing — the API half of specs/p6-publishing/spec.md's verification.
 *
 * Nothing here runs the worker. These assertions are about what the API REFUSES
 * before a job exists, what it writes when it takes the publishing lock, and
 * what the checklist computes on read. The run itself is
 * apps/worker/test/publish-processor.spec.ts.
 */

const run = randomBytes(4).toString('hex');
const prisma = getPrismaClient();
const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6380';

let app: INestApplication;
let publishQueue: PublishQueue;
let jobStatus: JobStatusService;
/** A queue of this suite's own, so enqueued jobs never leak into a shared one. */
const queueName = `publish-e2e-${run}`;
let categoryId = '';
const tokens = { owner: '', admin: '', learner: '' };
const ids = { owner: '', admin: '' };

const as = (token: string) => ({ Cookie: `authjs.session-token=${token}` });
const api = () => request(app.getHttpServer());

/** A body with no figure block, so checklist item 3 passes vacuously. */
const PLAIN_BODY =
  '# Writing systems\n\nJapanese uses three scripts in combination.\n\nHiragana is a syllabary.\n';

/** A body with one figure block, so item 3 has something to fail on. */
const FIGURE_BODY = '# Stroke order\n\nThe first stroke runs left to right.\n\n::figure\n';

let levelOrder = 0;

async function seedUser(local: string, userRole: string): Promise<[string, string]> {
  const user = await prisma.user.create({
    data: { email: `${local}-pub-${run}@example.test`, name: local, userRole },
    select: { id: true },
  });
  const sessionToken = `tok-pub-${run}-${randomBytes(6).toString('hex')}`;
  await prisma.session.create({
    data: { sessionToken, userId: user.id, expires: new Date(Date.now() + 3_600_000) },
  });
  return [user.id, sessionToken];
}

interface SeedOptions {
  /** §5.7 item 5 wants 3 chapters of 2 lessons; the default satisfies it. */
  readonly chapters?: number;
  readonly lessonsPerChapter?: number;
  readonly publicationStatus?: string;
  /** §5.7 item 6. */
  readonly coverImageUrl?: string | null;
  readonly pricingType?: string;
  /** Per-lesson body. `null` leaves the lesson empty, failing items 1 and 2. */
  readonly body?: string | null;
  /** Whether each lesson gets an approved script and ready audio (items 4 and 7). */
  readonly withNarration?: boolean;
}

/**
 * A course seeded directly to a known checklist verdict.
 *
 * Everything earlier phases own is written through Prisma rather than driven
 * through their endpoints: a checklist assertion should fail when the checklist
 * is wrong, not when P2's autosave contract moved.
 */
async function seedCourse(suffix: string, options: SeedOptions = {}) {
  const {
    chapters = 3,
    lessonsPerChapter = 2,
    publicationStatus = 'draft',
    coverImageUrl = 'https://cdn.example.test/cover.png',
    pricingType = 'free',
    body = PLAIN_BODY,
    withNarration = true,
  } = options;

  levelOrder += 1;
  const course = await prisma.course.create({
    data: {
      categoryId,
      slug: `pub-${run}-${suffix}`,
      levelLabel: `L${levelOrder}`,
      levelOrder,
      title: `Course ${suffix}`,
      publicationStatus,
      pricingType,
      coverImageUrl,
      languageCode: 'vi',
    },
    select: { id: true },
  });

  const lessonIds: string[] = [];
  for (let c = 1; c <= chapters; c += 1) {
    const chapter = await prisma.chapter.create({
      data: { courseId: course.id, chapterOrder: c, title: `Chapter ${c}` },
      select: { id: true },
    });
    for (let l = 1; l <= lessonsPerChapter; l += 1) {
      const lesson = await prisma.lesson.create({
        data: {
          chapterId: chapter.id,
          lessonOrder: l,
          title: `Lesson ${c}.${l}`,
          estimatedMinutes: 10,
          contentStatus: body === null ? 'empty' : 'drafting',
        },
        select: { id: true },
      });
      lessonIds.push(lesson.id);
      if (body !== null) {
        await seedBody(lesson.id, body);
        if (withNarration) await seedNarrationAndAudio(lesson.id);
      }
    }
  }
  return { courseId: course.id, lessonIds };
}

async function seedBody(lessonId: string, markdown: string): Promise<void> {
  const parsed = parseLessonMarkdown(markdown, null);
  if (!parsed.ok) throw new Error('seed markdown did not parse');
  const data = {
    draftContentMarkdown: markdown,
    draftBlockList: parsed.blockList as unknown as object,
    draftContentChecksum: blockListChecksum(parsed.blockList),
    draftUpdatedAt: new Date(),
  };
  await prisma.lessonContent.upsert({
    where: { lessonId },
    create: { lessonId, ...data },
    update: data,
  });
}

/** An approved, fresh script and a ready, fresh audio — items 4 and 7 passing. */
async function seedNarrationAndAudio(lessonId: string): Promise<void> {
  const content = await prisma.lessonContent.findUnique({
    where: { lessonId },
    select: { draftBlockList: true, draftContentChecksum: true },
  });
  const blocks = (content?.draftBlockList as unknown as { blocks: Block[] }).blocks;
  const segments = blocks.map((block, index) =>
    buildSegment({
      block,
      segmentOrder: index,
      narrationText: `Bản đọc cho khối ${block.blockId}.`,
      isEdited: false,
    }),
  );
  const checksum = scriptChecksum(segments);

  const payload = {
    scriptSegments: { segments, totalEstimatedSeconds: 30 } as unknown as object,
    scriptChecksum: checksum,
    sourceContentChecksum: content?.draftContentChecksum ?? '',
    scriptStatus: 'ready',
    generatorModelName: 'fake-narrator-v1',
    generatorPromptVersion: 'narration/v1',
    reviewedByUserId: ids.owner,
    reviewedAt: new Date(),
  };
  await prisma.narrationScript.upsert({
    where: { lessonId },
    create: { lessonId, ...payload },
    update: payload,
  });

  const audio = await prisma.lessonAudio.create({
    data: {
      lessonId,
      voiceIdentifier: 'alloy',
      voiceProviderName: 'fake',
      mergedAudioFileUrl: `lessons/${lessonId}/audio/merged/seeded.mp3`,
      totalDurationSeconds: 12,
      totalCharacterCount: 120,
      sourceScriptChecksum: checksum,
      audioStatus: 'ready',
    },
    select: { id: true },
  });

  let cursor = 0;
  for (const segment of segments) {
    await prisma.audioSegment.create({
      data: {
        lessonAudioId: audio.id,
        blockReferenceId: segment.blockId,
        segmentOrder: segment.segmentOrder,
        startMillisecond: cursor,
        endMillisecond: cursor + 1_000,
        segmentAudioFileUrl: `lessons/${lessonId}/audio/segments/${segment.blockId}.mp3`,
        sourceSegmentChecksum: segment.segmentChecksum,
      },
    });
    cursor += 1_000;
  }
}

/** A selected image for every figure block in a lesson — item 3 passing. */
async function seedSelectedImages(lessonId: string): Promise<void> {
  const content = await prisma.lessonContent.findUnique({
    where: { lessonId },
    select: { draftBlockList: true },
  });
  const blocks = (content?.draftBlockList as unknown as { blocks: Block[] }).blocks;
  for (const block of blocks.filter((b) => b.blockType === 'figure')) {
    await prisma.lessonImage.create({
      data: {
        lessonId,
        blockReferenceId: block.blockId,
        figureNumber: block.figureNumber ?? 1,
        imageFileUrl: `lessons/${lessonId}/images/${block.blockId}.png`,
        captionText: 'Stroke order for the first character',
        alternativeText: 'A diagram showing three numbered strokes',
        imageSource: 'ai_generated',
        isSelected: true,
      },
    });
  }
}

beforeAll(async () => {
  publishQueue = new PublishQueue(redisUrl, queueName);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(REDIS_URL)
    .useValue(redisUrl)
    .overrideProvider(PublishQueue)
    .useValue(publishQueue)
    .compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api', { exclude: ['health'] });
  await app.init();
  jobStatus = app.get(JobStatusService);

  [ids.owner, tokens.owner] = await seedUser('owner', 'admin_owner');
  [ids.admin, tokens.admin] = await seedUser('admin', 'admin');
  [, tokens.learner] = await seedUser('learner', 'learner');

  const category = await prisma.category.create({
    data: { slug: `pub-${run}`, displayName: 'Publishing' },
    select: { id: true },
  });
  categoryId = category.id;
});

afterAll(async () => {
  await publishQueue?.queue.obliterate({ force: true }).catch(() => undefined);
  await app?.close();
});

describe('PATCH /admin/courses/:courseId — course metadata (FR-PUB-01 item 6)', () => {
  it('lets the owner set a cover image and reads it back', async () => {
    const { courseId } = await seedCourse('meta', { coverImageUrl: null, withNarration: false });

    const response = await api()
      .patch(`/api/admin/courses/${courseId}`)
      .set(as(tokens.owner))
      .send({ coverImageUrl: 'https://cdn.example.test/n5.png', overviewSummary: 'Beginner level' })
      .expect(200);

    expect(response.body).toMatchObject({
      coverImageUrl: 'https://cdn.example.test/n5.png',
      overviewSummary: 'Beginner level',
    });

    const stored = await prisma.course.findUnique({
      where: { id: courseId },
      select: { coverImageUrl: true, overviewSummary: true },
    });
    expect(stored?.coverImageUrl).toBe('https://cdn.example.test/n5.png');
  });

  it('accepts the JSONB list fields §8 gives the course', async () => {
    const { courseId } = await seedCourse('meta-lists', { withNarration: false });

    await api()
      .patch(`/api/admin/courses/${courseId}`)
      .set(as(tokens.owner))
      .send({ prerequisites: ['N5 kana'], learningObjectives: ['Read hiragana'], estimatedTotalMinutes: 600 })
      .expect(200);

    const stored = await prisma.course.findUnique({
      where: { id: courseId },
      select: { prerequisites: true, learningObjectives: true, estimatedTotalMinutes: true },
    });
    expect(stored?.prerequisites).toEqual(['N5 kana']);
    expect(stored?.estimatedTotalMinutes).toBe(600);
  });

  it('clears a field with null, which is how a cover image is removed', async () => {
    const { courseId } = await seedCourse('meta-clear', { withNarration: false });

    await api()
      .patch(`/api/admin/courses/${courseId}`)
      .set(as(tokens.owner))
      .send({ coverImageUrl: null })
      .expect(200);

    const stored = await prisma.course.findUnique({
      where: { id: courseId },
      select: { coverImageUrl: true },
    });
    expect(stored?.coverImageUrl).toBeNull();
  });

  it('refuses an admin, because §3 gives course configuration to the owner alone', async () => {
    const { courseId } = await seedCourse('meta-admin', { withNarration: false });

    const response = await api()
      .patch(`/api/admin/courses/${courseId}`)
      .set(as(tokens.admin))
      .send({ coverImageUrl: 'https://cdn.example.test/x.png' })
      .expect(403);

    expect(response.body.errorCode).toBe('FORBIDDEN_ROLE');
  });

  it('refuses a learner', async () => {
    const { courseId } = await seedCourse('meta-learner', { withNarration: false });
    await api()
      .patch(`/api/admin/courses/${courseId}`)
      .set(as(tokens.learner))
      .send({ coverImageUrl: 'https://cdn.example.test/x.png' })
      .expect(403);
  });

  it('rejects an unknown field, so a metadata write cannot smuggle one', async () => {
    const { courseId } = await seedCourse('meta-strict', { withNarration: false });

    const response = await api()
      .patch(`/api/admin/courses/${courseId}`)
      .set(as(tokens.owner))
      .send({ coverImageUrl: 'https://cdn.example.test/x.png', assignedAdminId: ids.admin })
      .expect(400);

    expect(response.body.errorCode).toBe('INVALID_BODY');
  });

  it('rejects an empty body', async () => {
    const { courseId } = await seedCourse('meta-empty', { withNarration: false });
    await api().patch(`/api/admin/courses/${courseId}`).set(as(tokens.owner)).send({}).expect(400);
  });

  it('rejects a cover image that is not a URL', async () => {
    const { courseId } = await seedCourse('meta-badurl', { withNarration: false });
    await api()
      .patch(`/api/admin/courses/${courseId}`)
      .set(as(tokens.owner))
      .send({ coverImageUrl: 'not-a-url' })
      .expect(400);
  });

  it('404s an unknown course', async () => {
    const response = await api()
      .patch('/api/admin/courses/3f1a0c8e-1f0e-4c3a-9a3b-2c6f5d4e7b81')
      .set(as(tokens.owner))
      .send({ coverImageUrl: 'https://cdn.example.test/x.png' })
      .expect(404);

    expect(response.body.errorCode).toBe('COURSE_NOT_FOUND');
  });
});

describe('§4.2 lifecycle transitions', () => {
  it('lets an admin submit a draft course for review', async () => {
    const { courseId } = await seedCourse('submit', { withNarration: false });

    const response = await api()
      .post(`/api/admin/courses/${courseId}/submit-review`)
      .set(as(tokens.admin))
      .expect(201);

    expect(response.body.publicationStatus).toBe('in_review');
    const stored = await prisma.course.findUnique({
      where: { id: courseId },
      select: { publicationStatus: true },
    });
    expect(stored?.publicationStatus).toBe('in_review');
  });

  it('lets an admin submit a course containing another admin’s lesson', async () => {
    // R-02 is row-level and the course row carries no assignment; a colleague
    // owning one lesson must not block the handoff submit-review exists for.
    const { courseId, lessonIds } = await seedCourse('submit-multi', { withNarration: false });
    await prisma.lesson.update({
      where: { id: lessonIds[0]! },
      data: { assignedAdminId: ids.owner },
    });

    await api()
      .post(`/api/admin/courses/${courseId}/submit-review`)
      .set(as(tokens.admin))
      .expect(201);
  });

  it('refuses an admin the reviewer’s return-to-draft, per §3', async () => {
    const { courseId } = await seedCourse('return-admin', {
      publicationStatus: 'in_review',
      withNarration: false,
    });

    const response = await api()
      .post(`/api/admin/courses/${courseId}/return-to-draft`)
      .set(as(tokens.admin))
      .expect(403);

    expect(response.body.errorCode).toBe('FORBIDDEN_ROLE');
  });

  it('lets the owner send a reviewed course back to draft', async () => {
    const { courseId } = await seedCourse('return-owner', {
      publicationStatus: 'in_review',
      withNarration: false,
    });

    const response = await api()
      .post(`/api/admin/courses/${courseId}/return-to-draft`)
      .set(as(tokens.owner))
      .expect(201);

    expect(response.body.publicationStatus).toBe('draft');
  });

  it('lets the owner archive an unpublished course', async () => {
    const { courseId } = await seedCourse('archive', {
      publicationStatus: 'unpublished',
      withNarration: false,
    });

    const response = await api()
      .post(`/api/admin/courses/${courseId}/archive`)
      .set(as(tokens.owner))
      .expect(201);

    expect(response.body.publicationStatus).toBe('archived');
    expect(response.body.allowedTransitions).toEqual([]);
  });

  it('refuses to archive a draft course, naming what it could do instead', async () => {
    const { courseId } = await seedCourse('archive-draft', { withNarration: false });

    const response = await api()
      .post(`/api/admin/courses/${courseId}/archive`)
      .set(as(tokens.owner))
      .expect(409);

    expect(response.body).toMatchObject({
      errorCode: 'INVALID_PUBLICATION_TRANSITION',
      currentStatus: 'draft',
      requestedStatus: 'archived',
    });
    expect(response.body.allowedTransitions).toEqual(['in_review', 'publishing']);
  });

  it('refuses to archive a published course, which would hide a live course', async () => {
    const { courseId } = await seedCourse('archive-live', {
      publicationStatus: 'published',
      withNarration: false,
    });

    await api()
      .post(`/api/admin/courses/${courseId}/archive`)
      .set(as(tokens.owner))
      .expect(409);
  });

  it('makes archived terminal', async () => {
    const { courseId } = await seedCourse('terminal', {
      publicationStatus: 'archived',
      withNarration: false,
    });

    await api()
      .post(`/api/admin/courses/${courseId}/return-to-draft`)
      .set(as(tokens.owner))
      .expect(409);
    await api()
      .post(`/api/admin/courses/${courseId}/submit-review`)
      .set(as(tokens.owner))
      .expect(409);
  });

  it('refuses a learner every transition', async () => {
    const { courseId } = await seedCourse('learner-lifecycle', { withNarration: false });
    await api()
      .post(`/api/admin/courses/${courseId}/submit-review`)
      .set(as(tokens.learner))
      .expect(403);
    await api()
      .post(`/api/admin/courses/${courseId}/archive`)
      .set(as(tokens.learner))
      .expect(403);
  });

  it('404s an unknown course', async () => {
    await api()
      .post('/api/admin/courses/3f1a0c8e-1f0e-4c3a-9a3b-2c6f5d4e7b81/submit-review')
      .set(as(tokens.owner))
      .expect(404);
  });

  it('reports publication status and what may follow it', async () => {
    const { courseId } = await seedCourse('status', { withNarration: false });

    const response = await api()
      .get(`/api/admin/courses/${courseId}/publication-status`)
      .set(as(tokens.admin))
      .expect(200);

    expect(response.body).toMatchObject({
      publicationStatus: 'draft',
      hasUnpublishedChanges: false,
      publishedVersionNumber: null,
    });
    expect(response.body.allowedTransitions).toEqual(['in_review', 'publishing']);
  });
});

describe('GET /admin/courses/:courseId/publish-checklist (FR-PUB-01)', () => {
  const checklist = (courseId: string, token = tokens.owner) =>
    api().get(`/api/admin/courses/${courseId}/publish-checklist`).set(as(token));

  const itemOf = (body: { items: { id: string }[] }, id: string) =>
    body.items.find((i) => i.id === id) as {
      id: string;
      passed: boolean;
      reason: string;
      offenders: string[];
      requirement: string;
    };

  it('passes all seven items for a fully authored course', async () => {
    const { courseId } = await seedCourse('pass');

    const response = await checklist(courseId).expect(200);

    expect(response.body.items).toHaveLength(7);
    expect(response.body.passed).toBe(true);
    for (const item of response.body.items) {
      expect(item.passed, `${item.id}: ${item.reason}`).toBe(true);
    }
  });

  it('quotes §5.7 verbatim on every item', async () => {
    const { courseId } = await seedCourse('requirements');
    const response = await checklist(courseId).expect(200);

    expect(itemOf(response.body, 'structure_minimums').requirement).toBe(
      'The course has at least 3 chapters and every chapter has at least 2 lessons.',
    );
  });

  it('fails items 1 and 2 for an unauthored lesson, naming it', async () => {
    const { courseId } = await seedCourse('empty', { body: null });

    const response = await checklist(courseId).expect(200);

    expect(response.body.passed).toBe(false);
    const content = itemOf(response.body, 'lesson_content_present');
    expect(content.passed).toBe(false);
    expect(content.offenders).toContain('Lesson 1.1');
    expect(itemOf(response.body, 'no_empty_lesson').passed).toBe(false);
  });

  it('fails item 3 when a figure block has no selected image', async () => {
    const { courseId } = await seedCourse('figure-bare', { body: FIGURE_BODY });

    const item = itemOf(await checklist(courseId).expect(200).then((r) => r.body), 'figures_illustrated');
    expect(item.passed).toBe(false);
    expect(item.offenders[0]).toContain('no image selected');
  });

  it('passes item 3 once every figure has a selected, captioned image', async () => {
    const { courseId, lessonIds } = await seedCourse('figure-fixed', { body: FIGURE_BODY });
    for (const lessonId of lessonIds) await seedSelectedImages(lessonId);

    const item = itemOf(await checklist(courseId).expect(200).then((r) => r.body), 'figures_illustrated');
    expect(item.passed).toBe(true);
  });

  it('fails item 3 when the selected image has no alt text', async () => {
    const { courseId, lessonIds } = await seedCourse('figure-noalt', { body: FIGURE_BODY });
    for (const lessonId of lessonIds) await seedSelectedImages(lessonId);
    await prisma.lessonImage.updateMany({
      where: { lessonId: lessonIds[0] },
      data: { alternativeText: '' },
    });

    const item = itemOf(await checklist(courseId).expect(200).then((r) => r.body), 'figures_illustrated');
    expect(item.passed).toBe(false);
    expect(item.offenders[0]).toContain('no alt text');
  });

  it('fails item 4 when a body edit leaves the script stale (§6.5, computed)', async () => {
    const { courseId, lessonIds } = await seedCourse('stale-script');
    // The script's source checksum now points at content that has moved on.
    await seedBody(lessonIds[0]!, `${PLAIN_BODY}\nA newly added paragraph.\n`);

    const item = itemOf(await checklist(courseId).expect(200).then((r) => r.body), 'artifacts_fresh');
    expect(item.passed).toBe(false);
    expect(item.offenders.join(' ')).toContain('narration script is stale');
  });

  it('fails item 4 when the course voice moved on, leaving audio stale', async () => {
    const { courseId } = await seedCourse('stale-voice');
    await prisma.course.update({ where: { id: courseId }, data: { voiceIdentifier: 'shimmer' } });

    const item = itemOf(await checklist(courseId).expect(200).then((r) => r.body), 'artifacts_fresh');
    expect(item.passed).toBe(false);
    expect(item.offenders.join(' ')).toContain('audio is stale');
  });

  it('fails item 4 for a failed script, which outranks stale', async () => {
    const { courseId, lessonIds } = await seedCourse('failed-script');
    await prisma.narrationScript.update({
      where: { lessonId: lessonIds[0]! },
      data: { scriptStatus: 'failed' },
    });

    const item = itemOf(await checklist(courseId).expect(200).then((r) => r.body), 'artifacts_fresh');
    expect(item.offenders.join(' ')).toContain('narration script is failed');
  });

  it('passes item 4 for a lesson with no narration at all', async () => {
    // §5.7 speaks about artifacts that exist. Requiring narration everywhere
    // would be a requirement FR-PUB-01 does not make.
    const { courseId } = await seedCourse('no-narration', { withNarration: false });

    const item = itemOf(await checklist(courseId).expect(200).then((r) => r.body), 'artifacts_fresh');
    expect(item.passed).toBe(true);
  });

  it('fails item 5 with too few chapters, and says how many are missing', async () => {
    const { courseId } = await seedCourse('two-chapters', { chapters: 2 });

    const item = itemOf(await checklist(courseId).expect(200).then((r) => r.body), 'structure_minimums');
    expect(item.passed).toBe(false);
    expect(item.reason).toContain('2 of the 3 chapters');
  });

  it('fails item 5 when a chapter has a single lesson, naming the chapter', async () => {
    const { courseId } = await seedCourse('thin-chapter', { lessonsPerChapter: 1 });

    const item = itemOf(await checklist(courseId).expect(200).then((r) => r.body), 'structure_minimums');
    expect(item.passed).toBe(false);
    expect(item.reason).toContain('"Chapter 1" has 1 of the 2 lessons');
  });

  it('fails item 6 without a cover image', async () => {
    const { courseId } = await seedCourse('no-cover', { coverImageUrl: null });

    const item = itemOf(await checklist(courseId).expect(200).then((r) => r.body), 'category_and_cover');
    expect(item.passed).toBe(false);
    expect(item.reason).toContain('cover image');
  });

  it('fails item 7 for a paid course with no active product', async () => {
    const { courseId } = await seedCourse('paid-bare', { pricingType: 'paid' });

    const item = itemOf(await checklist(courseId).expect(200).then((r) => r.body), 'active_product_for_paid');
    expect(item.passed).toBe(false);
    expect(item.reason).toContain('no active product');
  });

  it('passes item 7 once an active product references the course', async () => {
    const { courseId } = await seedCourse('paid-ok', { pricingType: 'paid' });
    await prisma.product.create({
      data: {
        productType: 'single_course',
        courseId,
        displayName: 'N5 access',
        priceAmount: '250000',
        createdByUserId: ids.owner,
        isActive: true,
      },
    });

    const item = itemOf(await checklist(courseId).expect(200).then((r) => r.body), 'active_product_for_paid');
    expect(item.passed).toBe(true);
  });

  it('ignores an inactive product', async () => {
    const { courseId } = await seedCourse('paid-inactive', { pricingType: 'paid' });
    await prisma.product.create({
      data: {
        productType: 'single_course',
        courseId,
        displayName: 'Retired',
        priceAmount: '250000',
        createdByUserId: ids.owner,
        isActive: false,
      },
    });

    const item = itemOf(await checklist(courseId).expect(200).then((r) => r.body), 'active_product_for_paid');
    expect(item.passed).toBe(false);
  });

  it('passes item 7 vacuously for a free course', async () => {
    const { courseId } = await seedCourse('free');
    const item = itemOf(await checklist(courseId).expect(200).then((r) => r.body), 'active_product_for_paid');
    expect(item.passed).toBe(true);
    expect(item.reason).toContain('free');
  });

  it('excludes soft-deleted lessons, per §4.3', async () => {
    const { courseId, lessonIds } = await seedCourse('soft-deleted');
    // An empty lesson would fail items 1 and 2 — unless it is deleted.
    const chapter = await prisma.lesson.findUnique({
      where: { id: lessonIds[0]! },
      select: { chapterId: true },
    });
    const ghost = await prisma.lesson.create({
      data: { chapterId: chapter!.chapterId, lessonOrder: 99, title: 'Ghost', contentStatus: 'empty' },
      select: { id: true },
    });
    expect(itemOf(await checklist(courseId).expect(200).then((r) => r.body), 'no_empty_lesson').passed).toBe(false);

    await prisma.lesson.update({ where: { id: ghost.id }, data: { deletedAt: new Date() } });
    expect(itemOf(await checklist(courseId).expect(200).then((r) => r.body), 'no_empty_lesson').passed).toBe(true);
  });

  it('refuses an admin, because §9.2 lists the checklist as an owner endpoint', async () => {
    const { courseId } = await seedCourse('checklist-admin');
    const response = await checklist(courseId, tokens.admin).expect(403);
    expect(response.body.errorCode).toBe('FORBIDDEN_ROLE');
  });

  it('404s an unknown course', async () => {
    await checklist('3f1a0c8e-1f0e-4c3a-9a3b-2c6f5d4e7b81').expect(404);
  });

  it('evaluates a 12-lesson course in a bounded number of queries, not N+1', async () => {
    const { courseId } = await seedCourse('query-count', { chapters: 4, lessonsPerChapter: 3 });

    let queries = 0;
    const counting = prisma.$extends({
      query: {
        async $allOperations({ query, args }: { query: (a: unknown) => Promise<unknown>; args: unknown }) {
          queries += 1;
          return query(args);
        },
      },
    }) as unknown as typeof prisma;

    const input = await loadPublishChecklistInput(counting, courseId, 'alloy');
    expect(input?.chapters.flatMap((c) => c.lessons)).toHaveLength(12);
    // Six reads: course, chapters(+lessons), contents, scripts, audios, images,
    // products. A per-lesson implementation would be an order of magnitude more.
    expect(queries).toBeLessThan(25);
  });
});

describe('POST /admin/courses/:courseId/publish (FR-PUB-02)', () => {
  const publish = (courseId: string, token = tokens.owner) =>
    api().post(`/api/admin/courses/${courseId}/publish`).set(as(token));

  it('refuses a failing course with 422 and the whole checklist', async () => {
    const { courseId } = await seedCourse('publish-422', { chapters: 2, coverImageUrl: null });

    const response = await publish(courseId).expect(422);

    expect(response.body.errorCode).toBe('PUBLISH_CHECKLIST_FAILED');
    expect(response.body.checklist.items).toHaveLength(7);
    expect(response.body.checklist.passed).toBe(false);
    // The course must not have been locked by a refused publish.
    const stored = await prisma.course.findUnique({
      where: { id: courseId },
      select: { publicationStatus: true },
    });
    expect(stored?.publicationStatus).toBe('draft');
  });

  it('accepts a passing course with 202, a qualified job id and the lock taken', async () => {
    const { courseId } = await seedCourse('publish-202');

    const response = await publish(courseId).expect(202);

    expect(response.body.jobId).toMatch(/^publish:\d+$/);
    expect(response.body.generationJobId).toBeTruthy();

    const stored = await prisma.course.findUnique({
      where: { id: courseId },
      select: { publicationStatus: true },
    });
    expect(stored?.publicationStatus).toBe('publishing');

    const job = await prisma.generationJob.findUnique({
      where: { id: response.body.generationJobId },
      select: { jobType: true, targetEntityId: true, jobStatus: true },
    });
    expect(job).toMatchObject({
      jobType: 'publish_course',
      targetEntityId: courseId,
      jobStatus: 'queued',
    });
  });

  it('refuses a second publish while one is in flight, naming the job', async () => {
    const { courseId } = await seedCourse('publish-inflight');
    await publish(courseId).expect(202);

    const response = await publish(courseId).expect(409);
    expect(response.body.errorCode).toBe('PUBLISH_IN_FLIGHT');
    expect(response.body.jobId).toMatch(/^publish:\d+$/);
  });

  it('refuses an admin, per §3', async () => {
    const { courseId } = await seedCourse('publish-admin');
    const response = await publish(courseId, tokens.admin).expect(403);
    expect(response.body.errorCode).toBe('FORBIDDEN_ROLE');
  });

  it('refuses to publish an archived course', async () => {
    const { courseId } = await seedCourse('publish-archived', { publicationStatus: 'archived' });
    const response = await publish(courseId).expect(409);
    expect(response.body.errorCode).toBe('INVALID_PUBLICATION_TRANSITION');
  });

  it('publishes changes to an already-published course', async () => {
    const { courseId } = await seedCourse('publish-changes', { publicationStatus: 'published' });
    await publish(courseId).expect(202);
  });

  it('restores the previous status when the enqueue fails, rather than wedging the lock', async () => {
    const { courseId } = await seedCourse('publish-enqueue-fail', {
      publicationStatus: 'published',
    });

    const original = publishQueue.enqueuePublish.bind(publishQueue);
    publishQueue.enqueuePublish = () => Promise.reject(new Error('redis is down'));
    try {
      await publish(courseId).expect(500);
    } finally {
      publishQueue.enqueuePublish = original;
    }

    const stored = await prisma.course.findUnique({
      where: { id: courseId },
      select: { publicationStatus: true },
    });
    // Back to `published`, NOT `draft`: a failed publish must never withdraw a
    // course learners are reading.
    expect(stored?.publicationStatus).toBe('published');
  });

  it('404s an unknown course', async () => {
    await publish('3f1a0c8e-1f0e-4c3a-9a3b-2c6f5d4e7b81').expect(404);
  });

  /**
   * The job id the 202 hands back must actually resolve, or the panel attaches
   * to a stream that 404s and hangs on its last known state while the run
   * succeeds behind it. JobStatusService keeps a PARTIAL map of queue instances
   * and skips a definition it has no instance for, so forgetting to register a
   * new producer there fails silently — it did in P6, and this is the guard.
   */
  it('resolves the job id it returns, so a watcher can attach to it', async () => {
    const { courseId } = await seedCourse('publish-resolvable');
    const { body } = await publish(courseId).expect(202);

    const snapshot = await jobStatus.snapshot(body.jobId as string);
    expect(snapshot).toBeDefined();
    expect(snapshot).toMatchObject({
      jobId: body.jobId,
      jobType: 'publish_course',
      targetEntityId: courseId,
    });
  });
});

describe('POST /admin/courses/:courseId/unpublish (FR-PUB-04)', () => {
  const unpublish = (courseId: string, token = tokens.owner) =>
    api().post(`/api/admin/courses/${courseId}/unpublish`).set(as(token));

  /** A published course with a snapshot, a grant and progress, as P8 and P7 will leave it. */
  async function seedLiveCourse(suffix: string) {
    const { courseId, lessonIds } = await seedCourse(suffix, { publicationStatus: 'published' });
    await prisma.publishedCourseStructure.create({
      data: {
        courseId,
        structurePayload: { courseId, publishedVersionNumber: 1, chapters: [], totalLessonCount: 0 } as object,
        totalLessonCount: 6,
        publishedVersionNumber: 1,
        publishedByUserId: ids.owner,
      },
    });
    await prisma.lessonContent.updateMany({
      where: { lessonId: { in: lessonIds } },
      data: { publishedContentMarkdown: PLAIN_BODY, publishedAt: new Date() },
    });
    const [, learnerToken] = await seedUser(`learner-${suffix}`, 'learner');
    const learner = await prisma.session.findUnique({
      where: { sessionToken: learnerToken },
      select: { userId: true },
    });
    await prisma.accessGrant.create({
      data: {
        userId: learner!.userId,
        scopeType: 'course',
        scopeCourseId: courseId,
        accessSource: 'granted_by_owner',
        grantedByUserId: ids.owner,
      },
    });
    await prisma.lessonProgress.create({
      data: { userId: learner!.userId, lessonId: lessonIds[0]!, progressStatus: 'in_progress' },
    });
    return { courseId, lessonIds, learnerId: learner!.userId };
  }

  it('removes the course from the catalog and preserves everything else', async () => {
    const { courseId, lessonIds, learnerId } = await seedLiveCourse('unpub');

    const response = await unpublish(courseId).expect(201);
    expect(response.body.publicationStatus).toBe('unpublished');

    // The published track is untouched — that is what makes re-publishing cheap
    // and what keeps progress meaningful.
    const structure = await prisma.publishedCourseStructure.findUnique({ where: { courseId } });
    expect(structure).not.toBeNull();
    expect(structure?.publishedVersionNumber).toBe(1);

    const contents = await prisma.lessonContent.findMany({
      where: { lessonId: { in: lessonIds } },
      select: { publishedContentMarkdown: true },
    });
    expect(contents.every((c) => c.publishedContentMarkdown === PLAIN_BODY)).toBe(true);

    expect(
      await prisma.accessGrant.count({ where: { userId: learnerId, scopeCourseId: courseId } }),
    ).toBe(1);
    expect(await prisma.lessonProgress.count({ where: { userId: learnerId } })).toBe(1);
  });

  it('refuses an admin, per §3', async () => {
    const { courseId } = await seedCourse('unpub-admin', { publicationStatus: 'published' });
    await unpublish(courseId, tokens.admin).expect(403);
  });

  it('refuses to unpublish a draft course', async () => {
    const { courseId } = await seedCourse('unpub-draft');
    const response = await unpublish(courseId).expect(409);
    expect(response.body.errorCode).toBe('INVALID_PUBLICATION_TRANSITION');
  });

  it('re-runs the full checklist on republish rather than restoring silently', async () => {
    const { courseId, lessonIds } = await seedLiveCourse('republish-broken');
    await unpublish(courseId).expect(201);

    // The draft broke while the course was withdrawn.
    await prisma.lessonContent.update({
      where: { lessonId: lessonIds[0]! },
      data: { draftContentMarkdown: '' },
    });

    const response = await api()
      .post(`/api/admin/courses/${courseId}/publish`)
      .set(as(tokens.owner))
      .expect(422);
    expect(response.body.errorCode).toBe('PUBLISH_CHECKLIST_FAILED');

    // Still unpublished: a refused republish must not change the status.
    const stored = await prisma.course.findUnique({
      where: { id: courseId },
      select: { publicationStatus: true },
    });
    expect(stored?.publicationStatus).toBe('unpublished');
  });

  it('accepts a republish when the course still passes', async () => {
    const { courseId } = await seedLiveCourse('republish-ok');
    await unpublish(courseId).expect(201);

    const response = await api()
      .post(`/api/admin/courses/${courseId}/publish`)
      .set(as(tokens.owner))
      .expect(202);
    expect(response.body.jobId).toMatch(/^publish:\d+$/);
  });
});
