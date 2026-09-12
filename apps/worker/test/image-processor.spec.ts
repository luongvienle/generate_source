import { randomBytes, randomUUID } from 'node:crypto';
import { Queue, type Worker } from 'bullmq';
import { config as loadEnv } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createQueuedJob, getPrismaClient } from '@knowledge-explorer/database';
import {
  JOB_BACKOFF_DELAY_MS,
  JOB_MAX_ATTEMPTS,
  imageJobNames,
  parseRedisUrl,
  type GenerateImageJobData,
} from '@knowledge-explorer/shared';
import {
  FakeImageProvider,
  type GeneratedImage,
  type ImageGenerationProvider,
} from '@knowledge-explorer/ai';
import { S3ObjectStorage, s3ConfigFromEnv } from '@knowledge-explorer/storage';
import { createImageWorker } from '../src/jobs/image.worker';
import { createImageProcessor } from '../src/jobs/image.processor';
import { withJobLifecycle } from '../src/jobs/job-lifecycle';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * FR-IMG-01 through a real BullMQ job, a real MinIO and a real Postgres.
 *
 * The provider is the fake, which is the point: the assertions are about what
 * the processor does with what a provider returns, not about the provider.
 */

const url = process.env['REDIS_URL'] ?? 'redis://localhost:6380';
const queueName = `image-processor-test-${randomBytes(4).toString('hex')}`;
const prisma = getPrismaClient();
const storage = new S3ObjectStorage(s3ConfigFromEnv());

const createdJobRows: string[] = [];
let queue: Queue;
let worker: Worker;
let lessonId = '';
let authorId = '';

/** A provider that always fails, for the failure path. */
class ExplodingProvider implements ImageGenerationProvider {
  async generate(): Promise<readonly GeneratedImage[]> {
    throw new Error('provider exploded');
  }
}

/** A provider returning a type that cannot be stored. */
class BadTypeProvider implements ImageGenerationProvider {
  async generate(): Promise<readonly GeneratedImage[]> {
    return [
      {
        bytes: Uint8Array.from([1, 2, 3]),
        contentType: 'image/gif',
        modelName: 'm',
        providerName: 'p',
      },
    ];
  }
}

async function queuedRow(): Promise<string> {
  const { id } = await createQueuedJob(prisma.generationJob, {
    jobType: 'generate_image',
    targetEntityId: lessonId,
  });
  createdJobRows.push(id);
  return id;
}

const jobData = (
  generationJobId: string,
  blockReferenceId: string,
  candidateCount = 4,
): GenerateImageJobData => ({
  generationJobId,
  lessonId,
  blockReferenceId,
  composedPrompt: `[image/v1] test prompt ${blockReferenceId}`,
  candidateCount,
  createdByUserId: authorId,
});

async function settle(jobId: string, timeoutMs = 30_000): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await (await queue.getJob(jobId))?.getState();
    if (state === 'completed' || state === 'failed') return state;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`job ${jobId} did not settle`);
}

beforeAll(async () => {
  await storage.ensureBucket();

  // A real lesson, because lesson_images.lesson_id is a foreign key.
  const run = randomBytes(4).toString('hex');
  const author = await prisma.user.create({
    data: { email: `img-proc-${run}@example.test`, name: 'author', userRole: 'admin' },
    select: { id: true },
  });
  authorId = author.id;

  const category = await prisma.category.create({
    data: { slug: `img-proc-${run}`, displayName: 'Image processor' },
    select: { id: true },
  });
  const course = await prisma.course.create({
    data: {
      categoryId: category.id,
      slug: `img-proc-${run}`,
      levelLabel: 'L1',
      levelOrder: 1,
      title: 'Course',
    },
    select: { id: true },
  });
  const chapter = await prisma.chapter.create({
    data: { courseId: course.id, chapterOrder: 1, title: 'Chapter' },
    select: { id: true },
  });
  const lesson = await prisma.lesson.create({
    data: { chapterId: chapter.id, lessonOrder: 1, title: 'Lesson' },
    select: { id: true },
  });
  lessonId = lesson.id;

  queue = new Queue(queueName, {
    connection: parseRedisUrl(url),
    defaultJobOptions: {
      attempts: JOB_MAX_ATTEMPTS,
      backoff: { type: 'exponential', delay: JOB_BACKOFF_DELAY_MS },
    },
  });

  worker = createImageWorker(
    url,
    {
      [imageJobNames.generate]: withJobLifecycle(prisma.generationJob, async (job) => {
        const mode = (job.data as { mode?: string }).mode;
        const provider =
          mode === 'explode'
            ? new ExplodingProvider()
            : mode === 'badtype'
              ? new BadTypeProvider()
              : new FakeImageProvider();
        return createImageProcessor(prisma, provider, storage)(job);
      }),
    },
    queueName,
  );
  await worker.waitUntilReady();
}, 60_000);

afterAll(async () => {
  await worker?.close();
  await queue?.obliterate({ force: true });
  await queue?.close();
  await prisma.generationJob.deleteMany({ where: { id: { in: createdJobRows } } });
  await prisma.$disconnect();
});

describe('createImageProcessor', () => {
  it('writes one row per candidate, all unselected and captionless', async () => {
    const generationJobId = await queuedRow();
    const job = await queue.add(imageJobNames.generate, jobData(generationJobId, 'fig1'));

    expect(await settle(job.id!)).toBe('completed');

    const rows = await prisma.lessonImage.findMany({
      where: { lessonId, blockReferenceId: 'fig1' },
    });
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.isSelected).toBe(false);
      expect(row.captionText).toBe('');
      expect(row.alternativeText).toBe('');
      expect(row.imageSource).toBe('ai_generated');
      // NFR-08: the composed prompt, version marker and all.
      expect(row.imagePromptText).toContain('[image/v1]');
      expect(row.imageModelName).toBe('fake-deterministic-v1');
      expect(row.imageProviderName).toBe('fake');
      expect(row.createdByUserId).toBe(authorId);
      // §6.1 numbers figures during extraction and nowhere else.
      expect(row.figureNumber).toBeNull();
    }

    const row = await prisma.generationJob.findUniqueOrThrow({ where: { id: generationJobId } });
    expect(row.jobStatus).toBe('succeeded');
  });

  it('stores bytes that the object store actually serves back', async () => {
    const generationJobId = await queuedRow();
    const job = await queue.add(imageJobNames.generate, jobData(generationJobId, 'fig2', 2));
    expect(await settle(job.id!)).toBe('completed');

    const rows = await prisma.lessonImage.findMany({
      where: { lessonId, blockReferenceId: 'fig2' },
    });
    expect(rows).toHaveLength(2);

    for (const row of rows) {
      const bytes = await storage.get(row.imageFileUrl);
      // A real PNG: the browser suite displays these.
      expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    }
  });

  it('appends on a second job rather than replacing', async () => {
    const first = await queuedRow();
    const a = await queue.add(imageJobNames.generate, jobData(first, 'fig3', 2));
    expect(await settle(a.id!)).toBe('completed');

    const second = await queuedRow();
    const b = await queue.add(imageJobNames.generate, jobData(second, 'fig3', 3));
    expect(await settle(b.id!)).toBe('completed');

    const rows = await prisma.lessonImage.count({
      where: { lessonId, blockReferenceId: 'fig3' },
    });
    expect(rows).toBe(5);
  });

  it('writes nothing when the provider throws, and records the failure', async () => {
    const generationJobId = await queuedRow();
    const job = await queue.add(imageJobNames.generate, {
      ...jobData(generationJobId, 'fig4'),
      mode: 'explode',
    });

    expect(await settle(job.id!)).toBe('failed');
    expect(
      await prisma.lessonImage.count({ where: { lessonId, blockReferenceId: 'fig4' } }),
    ).toBe(0);

    const row = await prisma.generationJob.findUniqueOrThrow({ where: { id: generationJobId } });
    expect(row.jobStatus).toBe('failed');
    // NFR-03: three attempts and no more.
    expect(row.attemptCount).toBe(JOB_MAX_ATTEMPTS);
    expect(row.errorMessage).toBe('provider exploded');
  });

  it('refuses a content type it cannot store rather than minting a bad key', async () => {
    const generationJobId = await queuedRow();
    const job = await queue.add(imageJobNames.generate, {
      ...jobData(generationJobId, 'fig5'),
      mode: 'badtype',
    });

    expect(await settle(job.id!)).toBe('failed');
    expect(
      await prisma.lessonImage.count({ where: { lessonId, blockReferenceId: 'fig5' } }),
    ).toBe(0);
    const row = await prisma.generationJob.findUniqueOrThrow({ where: { id: generationJobId } });
    expect(row.errorMessage).toContain('unsupported content type');
  });
});
