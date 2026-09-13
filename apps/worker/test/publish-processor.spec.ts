import { randomBytes } from 'node:crypto';
import { Queue, type Worker } from 'bullmq';
import { config as loadEnv } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createQueuedJob, getPrismaClient } from '@knowledge-explorer/database';
import {
  parseRedisUrl,
  publishJobNames,
  structurePayloadSchema,
  type PublishCourseJobData,
} from '@knowledge-explorer/shared';
import {
  blockListChecksum,
  buildSegment,
  parseLessonMarkdown,
  scriptChecksum,
  type Block,
} from '@knowledge-explorer/content';
import { createPublishWorker } from '../src/jobs/publish.worker';
import { createPublishProcessor } from '../src/jobs/publish.processor';
import { withJobLifecycle } from '../src/jobs/job-lifecycle';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * FR-PUB-02 through a real BullMQ job and a real Postgres.
 *
 * The assertions are about what the run WRITES and what it refuses to write: the
 * five effects of a publish, the all-or-nothing guarantee when the checklist has
 * drifted, and the version arithmetic that makes a re-run idempotent in content
 * while still counting the event.
 */

const url = process.env['REDIS_URL'] ?? 'redis://localhost:6380';
const queueName = `publish-processor-test-${randomBytes(4).toString('hex')}`;
const prisma = getPrismaClient();
const run = randomBytes(4).toString('hex');

let queue: Queue;
let worker: Worker;
let ownerId = '';
let categoryId = '';
let levelOrder = 0;

const BODY = '# Writing systems\n\nJapanese uses three scripts.\n\nHiragana is a syllabary.\n';

async function seedPublishableCourse(suffix: string, publicationStatus = 'publishing') {
  levelOrder += 1;
  const course = await prisma.course.create({
    data: {
      categoryId,
      slug: `pubproc-${run}-${suffix}`,
      levelLabel: `L${levelOrder}`,
      levelOrder,
      title: `Course ${suffix}`,
      publicationStatus,
      coverImageUrl: 'https://cdn.example.test/cover.png',
      languageCode: 'vi',
    },
    select: { id: true },
  });

  const lessonIds: string[] = [];
  for (let c = 1; c <= 3; c += 1) {
    const chapter = await prisma.chapter.create({
      data: { courseId: course.id, chapterOrder: c, title: `Chapter ${c}` },
      select: { id: true },
    });
    for (let l = 1; l <= 2; l += 1) {
      const lesson = await prisma.lesson.create({
        data: {
          chapterId: chapter.id,
          lessonOrder: l,
          title: `Lesson ${c}.${l}`,
          estimatedMinutes: 10,
          contentStatus: 'drafting',
        },
        select: { id: true },
      });
      lessonIds.push(lesson.id);
      await seedBody(lesson.id, BODY);
      await seedNarrationAndAudio(lesson.id);
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

async function seedNarrationAndAudio(lessonId: string): Promise<void> {
  const content = await prisma.lessonContent.findUnique({
    where: { lessonId },
    select: { draftBlockList: true, draftContentChecksum: true },
  });
  const blocks = (content?.draftBlockList as unknown as { blocks: Block[] }).blocks;
  const segments = blocks.map((block, index) =>
    buildSegment({ block, segmentOrder: index, narrationText: `Đọc ${block.blockId}.`, isEdited: false }),
  );
  const checksum = scriptChecksum(segments);

  const payload = {
    scriptSegments: { segments, totalEstimatedSeconds: 30 } as unknown as object,
    scriptChecksum: checksum,
    sourceContentChecksum: content?.draftContentChecksum ?? '',
    scriptStatus: 'ready',
    reviewedByUserId: ownerId,
    reviewedAt: new Date(),
  };
  await prisma.narrationScript.upsert({
    where: { lessonId },
    create: { lessonId, ...payload },
    update: payload,
  });

  await prisma.lessonAudio.create({
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
  });
}

async function settle(jobId: string, timeoutMs = 40_000): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await (await queue.getJob(jobId))?.getState();
    if (state === 'completed' || state === 'failed') return state;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`job ${jobId} did not settle`);
}

/** Enqueues a publish exactly as PublishingService does, and waits for it. */
async function publish(courseId: string, previousStatus = 'draft') {
  const row = await createQueuedJob(prisma.generationJob, {
    jobType: 'publish_course',
    targetEntityId: courseId,
  });
  const data: PublishCourseJobData = {
    generationJobId: row.id,
    courseId,
    createdByUserId: ownerId,
    previousStatus,
  };
  const job = await queue.add(publishJobNames.publish, data);
  const state = await settle(job.id as string);
  return { state, generationJobId: row.id };
}

beforeAll(async () => {
  const owner = await prisma.user.create({
    data: { email: `pubproc-${run}@example.test`, name: 'owner', userRole: 'admin_owner' },
    select: { id: true },
  });
  ownerId = owner.id;

  const category = await prisma.category.create({
    data: { slug: `pubproc-${run}`, displayName: 'Publish processor' },
    select: { id: true },
  });
  categoryId = category.id;

  queue = new Queue(queueName, { connection: parseRedisUrl(url) });
  worker = createPublishWorker(
    url,
    {
      [publishJobNames.publish]: withJobLifecycle(
        prisma.generationJob,
        createPublishProcessor(prisma),
      ),
    },
    queueName,
  );
  await worker.waitUntilReady();
});

afterAll(async () => {
  await worker?.close();
  await queue?.obliterate({ force: true }).catch(() => undefined);
  await queue?.close();
});

describe('FR-PUB-02 publish run', () => {
  it('writes all five effects of a publish', async () => {
    const { courseId, lessonIds } = await seedPublishableCourse('happy');

    const started = Date.now();
    const { state, generationJobId } = await publish(courseId);
    const elapsedMs = Date.now() - started;
    expect(state).toBe('completed');
    // Recorded for specs/p6-publishing/tasks.md; the transaction ceiling is 30 s.
    expect(elapsedMs).toBeLessThan(30_000);

    // 1. the draft track is copied into the published track
    const contents = await prisma.lessonContent.findMany({
      where: { lessonId: { in: lessonIds } },
      select: { publishedContentMarkdown: true, publishedBlockList: true, publishedAt: true },
    });
    expect(contents).toHaveLength(6);
    for (const content of contents) {
      expect(content.publishedContentMarkdown).toBe(BODY);
      expect(content.publishedBlockList).not.toBeNull();
      expect(content.publishedAt).not.toBeNull();
    }

    // 2. §4.2's lesson machine reaches `published`
    const lessons = await prisma.lesson.findMany({
      where: { id: { in: lessonIds } },
      select: { contentStatus: true },
    });
    expect(lessons.every((lesson) => lesson.contentStatus === 'published')).toBe(true);

    // 3. the §4.3 snapshot exists and parses against P7's contract
    const structure = await prisma.publishedCourseStructure.findUnique({ where: { courseId } });
    expect(structure).toMatchObject({
      totalLessonCount: 6,
      publishedVersionNumber: 1,
      publishedByUserId: ownerId,
    });
    const payload = structurePayloadSchema.parse(structure!.structurePayload);
    expect(payload.chapters).toHaveLength(3);
    expect(payload.chapters.map((c) => c.order)).toEqual([1, 2, 3]);
    expect(payload.chapters[0]!.lessons[0]!.hasAudio).toBe(true);
    expect(payload.chapters[0]!.lessons[0]!.audioDurationSeconds).toBe(12);

    // 4. the course is published
    const course = await prisma.course.findUnique({
      where: { id: courseId },
      select: { publicationStatus: true, publishedAt: true, hasUnpublishedChanges: true },
    });
    expect(course).toMatchObject({ publicationStatus: 'published', hasUnpublishedChanges: false });
    expect(course?.publishedAt).not.toBeNull();

    // 5. the generation_jobs row reached a terminal success
    const jobRow = await prisma.generationJob.findUnique({
      where: { id: generationJobId },
      select: { jobStatus: true },
    });
    expect(jobRow?.jobStatus).toBe('succeeded');
  }, 60_000);

  it('excludes soft-deleted rows from the snapshot it writes', async () => {
    const { courseId, lessonIds } = await seedPublishableCourse('deleted');
    // A SEVENTH lesson, then deleted. Deleting one of the original six would
    // leave its chapter with one lesson and fail checklist item 5 — which is
    // correct behaviour, and not what this test is about.
    const first = await prisma.lesson.findUnique({
      where: { id: lessonIds[0]! },
      select: { chapterId: true },
    });
    const ghost = await prisma.lesson.create({
      data: {
        chapterId: first!.chapterId,
        lessonOrder: 99,
        title: 'Retired lesson',
        contentStatus: 'drafting',
        deletedAt: new Date(),
      },
      select: { id: true },
    });

    expect((await publish(courseId)).state).toBe('completed');

    const structure = await prisma.publishedCourseStructure.findUnique({ where: { courseId } });
    expect(structure?.totalLessonCount).toBe(6);
    const payload = structurePayloadSchema.parse(structure!.structurePayload);
    expect(payload.chapters.flatMap((c) => c.lessons).map((l) => l.lessonId)).not.toContain(
      ghost.id,
    );
  }, 60_000);

  it('refuses a course that drifted to failing the checklist, and writes nothing', async () => {
    const { courseId, lessonIds } = await seedPublishableCourse('drift');
    // Exactly the race the worker re-check exists for: an edit lands after the
    // API said 202, leaving the approved script stale against the new body.
    await seedBody(lessonIds[0]!, `${BODY}\nA paragraph added after the 202.\n`);

    const { state, generationJobId } = await publish(courseId);
    expect(state).toBe('failed');

    expect(await prisma.publishedCourseStructure.findUnique({ where: { courseId } })).toBeNull();
    const contents = await prisma.lessonContent.findMany({
      where: { lessonId: { in: lessonIds } },
      select: { publishedContentMarkdown: true },
    });
    expect(contents.every((content) => content.publishedContentMarkdown === null)).toBe(true);

    const course = await prisma.course.findUnique({
      where: { id: courseId },
      select: { publicationStatus: true },
    });
    // The lock is released back to where the course came from.
    expect(course?.publicationStatus).toBe('draft');

    const jobRow = await prisma.generationJob.findUnique({
      where: { id: generationJobId },
      select: { jobStatus: true, errorMessage: true },
    });
    expect(jobRow?.jobStatus).toBe('failed');
    expect(jobRow?.errorMessage).toContain('PUBLISH_CHECKLIST_FAILED');
    expect(jobRow?.errorMessage).toContain('artifacts_fresh');
  }, 60_000);

  it('leaves a live course published when a re-publish fails', async () => {
    // The load-bearing restore case: a failed job must never be able to withdraw
    // content learners are reading.
    const { courseId, lessonIds } = await seedPublishableCourse('relive');
    expect((await publish(courseId)).state).toBe('completed');

    await prisma.course.update({
      where: { id: courseId },
      data: { publicationStatus: 'publishing' },
    });
    await seedBody(lessonIds[0]!, `${BODY}\nA later edit that leaves the script stale.\n`);

    expect((await publish(courseId, 'published')).state).toBe('failed');

    const course = await prisma.course.findUnique({
      where: { id: courseId },
      select: { publicationStatus: true },
    });
    expect(course?.publicationStatus).toBe('published');

    // The previous snapshot is untouched: version 1, still six lessons.
    const structure = await prisma.publishedCourseStructure.findUnique({ where: { courseId } });
    expect(structure?.publishedVersionNumber).toBe(1);
  }, 90_000);

  it('fails a course that no longer exists rather than retrying it', async () => {
    const { courseId } = await seedPublishableCourse('vanished');
    await prisma.course.delete({ where: { id: courseId } });

    const row = await createQueuedJob(prisma.generationJob, {
      jobType: 'publish_course',
      targetEntityId: courseId,
    });
    const job = await queue.add(publishJobNames.publish, {
      generationJobId: row.id,
      courseId,
      createdByUserId: ownerId,
      previousStatus: 'draft',
    } satisfies PublishCourseJobData);

    expect(await settle(job.id as string)).toBe('failed');
    const jobRow = await prisma.generationJob.findUnique({
      where: { id: row.id },
      select: { jobStatus: true, attemptCount: true },
    });
    // UnrecoverableError: one attempt, not NFR-03's three.
    expect(jobRow?.jobStatus).toBe('failed');
    expect(jobRow?.attemptCount).toBe(1);
  }, 60_000);
});

describe('FR-PUB-02 idempotency and versioning', () => {
  it('re-runs to byte-identical content while counting the publish event', async () => {
    const { courseId } = await seedPublishableCourse('idempotent');

    expect((await publish(courseId)).state).toBe('completed');
    const first = await prisma.lessonContent.findMany({
      where: { lesson: { chapter: { courseId } } },
      orderBy: { lessonId: 'asc' },
      select: { lessonId: true, publishedContentMarkdown: true, publishedBlockList: true },
    });

    await prisma.course.update({
      where: { id: courseId },
      data: { publicationStatus: 'publishing' },
    });
    expect((await publish(courseId, 'published')).state).toBe('completed');
    const second = await prisma.lessonContent.findMany({
      where: { lesson: { chapter: { courseId } } },
      orderBy: { lessonId: 'asc' },
      select: { lessonId: true, publishedContentMarkdown: true, publishedBlockList: true },
    });

    // Identical CONTENT — that is what FR-PUB-02's "idempotent" means here.
    expect(second).toEqual(first);

    // Exactly one snapshot row, and the version counts the second event.
    const structures = await prisma.publishedCourseStructure.findMany({ where: { courseId } });
    expect(structures).toHaveLength(1);
    expect(structures[0]!.publishedVersionNumber).toBe(2);
  }, 90_000);
});
