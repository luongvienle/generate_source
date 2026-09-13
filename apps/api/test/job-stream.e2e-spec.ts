import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Queue, Worker, type Job } from 'bullmq';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { getPrismaClient } from '@knowledge-explorer/database';
import {
  dryRunResultKey,
  errorCodes,
  importJobNames,
  parseRedisUrl,
} from '@knowledge-explorer/shared';
import { AppModule } from '../src/app.module';
import { ImportQueue, REDIS_URL } from '../src/jobs/import.queue';
import { ImageQueue } from '../src/jobs/image.queue';
import { JobStatusService } from '../src/jobs/job-status.service';
import { createQueuedJob, markJobRunning, markJobSucceeded } from '@knowledge-explorer/database';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * GET /api/admin/jobs/:jobId/stream — NFR-04 progress, and the §3 gate on it.
 *
 * A run-scoped queue name keeps this off the development queue. The consumer
 * here is a plain BullMQ Worker rather than an import of apps/worker: the two
 * apps are separate deployables (§11), and what is under test is the API's view
 * of a job, not the worker's processors.
 */

const url = process.env['REDIS_URL'] ?? 'redis://localhost:6380';
const queueName = `curriculum-stream-test-${randomBytes(4).toString('hex')}`;
const run = randomBytes(4).toString('hex');
const prisma = getPrismaClient();

let app: INestApplication;
let importQueue: ImportQueue;
let imageQueue: ImageQueue;
let worker: Worker;
let imageWorker: Worker;
const imageQueueName = `image-stream-test-${randomBytes(4).toString('hex')}`;
/** Fixtures for the R-02 cases: one lesson assigned, one not. */
const lessons = { assignedToAdmin: '', assignedToSomeoneElse: '' };
let courseId = '';
const jobRowIds: string[] = [];
const tokens = { owner: '', admin: '', learner: '' };
const userIds: string[] = [];
let adminUserId = '';
let categoryId = '';

const as = (token: string) => ({ Cookie: `authjs.session-token=${token}` });

async function seed(local: string, userRole: string): Promise<string> {
  const user = await prisma.user.create({
    data: { email: `${local}-${run}@example.test`, name: local, userRole },
    select: { id: true },
  });
  userIds.push(user.id);
  const sessionToken = `tok-${run}-${randomBytes(6).toString('hex')}`;
  await prisma.session.create({
    data: { sessionToken, userId: user.id, expires: new Date(Date.now() + 3_600_000) },
  });
  return sessionToken;
}

/** Collects the `data:` payloads of a completed SSE response. */
function events(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice('data:'.length).trim()) as Record<string, unknown>);
}

beforeAll(async () => {
  importQueue = new ImportQueue(url, queueName);
  imageQueue = new ImageQueue(url, imageQueueName);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(REDIS_URL)
    .useValue(url)
    .overrideProvider(ImportQueue)
    .useValue(importQueue)
    .overrideProvider(ImageQueue)
    .useValue(imageQueue)
    .compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api', { exclude: ['health'] });
  await app.init();

  worker = new Worker(
    queueName,
    async (job: Job) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const plan = { counts: { chaptersCreated: 3 }, marker: queueName };
      // No TTL here: BullMQ narrows its client interface, and what is under test
      // is the stream. The real 1-hour expiry is set by the worker's dry-run
      // processor through ioredis proper.
      const client = await importQueue.queue.client;
      await client.set(dryRunResultKey(job.id!), JSON.stringify(plan));
      return plan;
    },
    { connection: parseRedisUrl(url), concurrency: 2 },
  );
  await worker.waitUntilReady();

  // A trivial consumer for the image queue: what is under test is the API's
  // view of the job, not the processor, which has its own suite in apps/worker.
  imageWorker = new Worker(
    imageQueueName,
    async (job: Job) => {
      // Stands in for apps/worker, which drives the row through
      // withJobLifecycle. The API reads generation_jobs as authoritative, so a
      // consumer that never moves the row leaves the stream open forever.
      const rowId = (job.data as { generationJobId: string }).generationJobId;
      await markJobRunning(prisma.generationJob, rowId, 1);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await markJobSucceeded(prisma.generationJob, rowId);
      return { candidatesCreated: 4 };
    },
    { connection: parseRedisUrl(url), concurrency: 2 },
  );
  await imageWorker.waitUntilReady();

  tokens.owner = await seed('owner', 'admin_owner');
  tokens.admin = await seed('admin', 'admin');
  tokens.learner = await seed('learner', 'learner');
  adminUserId = userIds[1] as string;

  const category = await prisma.category.create({
    data: { slug: `stream-${run}`, displayName: 'Stream' },
    select: { id: true },
  });
  const course = await prisma.course.create({
    data: {
      categoryId: category.id,
      slug: `stream-${run}`,
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
  const mine = await prisma.lesson.create({
    data: {
      chapterId: chapter.id,
      lessonOrder: 1,
      title: 'Mine',
      assignedAdminId: adminUserId,
    },
    select: { id: true },
  });
  const theirs = await prisma.lesson.create({
    data: {
      chapterId: chapter.id,
      lessonOrder: 2,
      title: 'Theirs',
      assignedAdminId: userIds[0] as string,
    },
    select: { id: true },
  });
  courseId = course.id;
  lessons.assignedToAdmin = mine.id;
  lessons.assignedToSomeoneElse = theirs.id;
  categoryId = category.id;
});

afterAll(async () => {
  // Order matters: app.close() runs ImportQueue.onModuleDestroy, which closes the
  // queue, so the run-scoped queue must be drained before the app goes down.
  await worker.close();
  await imageWorker.close();
  await importQueue.queue.obliterate({ force: true });
  await imageQueue.queue.obliterate({ force: true });
  await app.close();
  await prisma.generationJob.deleteMany({ where: { id: { in: jobRowIds } } });
  if (categoryId) {
    await prisma.course.deleteMany({ where: { categoryId } });
    await prisma.category.deleteMany({ where: { id: categoryId } });
  }
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe('the job progress stream', () => {
  it('follows a running job to a terminal event carrying its result', async () => {
    const jobId = await importQueue.enqueueDryRun({ marker: queueName });

    const response = await request(app.getHttpServer())
      .get(`/api/admin/jobs/${jobId}/stream`)
      .set(as(tokens.owner))
      .expect(200);

    const received = events(response.text);
    expect(received.length).toBeGreaterThan(0);

    const last = received.at(-1)!;
    expect(last['jobStatus']).toBe('succeeded');
    expect(last['result']).toMatchObject({ counts: { chaptersCreated: 3 } });
  }, 20_000);

  it('returns the terminal event immediately for a job that already finished', async () => {
    const jobId = await importQueue.enqueueDryRun({ marker: queueName });

    // Poll until BullMQ reports it settled, so the subscription starts after the fact.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if ((await (await importQueue.queue.getJob(jobId))?.getState()) === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const started = Date.now();
    const response = await request(app.getHttpServer())
      .get(`/api/admin/jobs/${jobId}/stream`)
      .set(as(tokens.owner))
      .expect(200);

    const received = events(response.text);
    expect(received).toHaveLength(1);
    expect(received[0]!['jobStatus']).toBe('succeeded');
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 25_000);

  it('reports an unknown job id rather than hanging', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/admin/jobs/999999/stream')
      .set(as(tokens.owner))
      .expect(200);

    expect(events(response.text)).toEqual([
      { errorCode: errorCodes.JOB_NOT_FOUND, jobId: '999999' },
    ]);
  }, 15_000);

  it('refuses an admin: import is owner-only under §3', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/admin/jobs/1/stream')
      .set(as(tokens.admin))
      .expect(403);

    expect(response.body.errorCode).toBe(errorCodes.FORBIDDEN_ROLE);
  });

  it('refuses a learner', async () => {
    await request(app.getHttpServer())
      .get('/api/admin/jobs/1/stream')
      .set(as(tokens.learner))
      .expect(403);
  });

  it('answers 401, not 403, when unauthenticated', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/admin/jobs/1/stream')
      .expect(401);

    expect(response.body.errorCode).toBe(errorCodes.UNAUTHENTICATED);
  });
});

/**
 * P1 hardcoded `importCurriculumOutline` on this stream and recorded that P3
 * must widen it. These are the cases that prove the widening both ways: an
 * admin reaches their own image job, and is still refused one they may not write.
 */
describe('the widened job-stream authorization', () => {
  async function enqueueImageJob(lessonId: string): Promise<string> {
    const row = await createQueuedJob(prisma.generationJob, {
      jobType: 'generate_image',
      targetEntityId: lessonId,
    });
    jobRowIds.push(row.id);

    return imageQueue.enqueueGenerate({
      generationJobId: row.id,
      lessonId,
      blockReferenceId: 'fig1',
      composedPrompt: '[image/v1] a diagram',
      candidateCount: 4,
      createdByUserId: adminUserId,
    });
  }

  it('lets an assigned admin watch their own image job to a terminal event', async () => {
    const jobId = await enqueueImageJob(lessons.assignedToAdmin);

    const response = await request(app.getHttpServer())
      .get(`/api/admin/jobs/${jobId}/stream`)
      .set(as(tokens.admin))
      .expect(200);

    const received = events(response.text);
    expect(received.length).toBeGreaterThan(0);
    expect(received.at(-1)!['jobStatus']).toBe('succeeded');
    expect(received.at(-1)!['jobType']).toBe('generate_image');
  }, 25_000);

  it('refuses an admin the image job of a lesson assigned to someone else (R-02)', async () => {
    const jobId = await enqueueImageJob(lessons.assignedToSomeoneElse);

    const response = await request(app.getHttpServer())
      .get(`/api/admin/jobs/${jobId}/stream`)
      .set(as(tokens.admin));

    expect(response.status).toBe(403);
    expect(response.body.errorCode).toBe(errorCodes.FORBIDDEN_NOT_ASSIGNED);
  }, 25_000);

  it('lets the owner watch any image job', async () => {
    const jobId = await enqueueImageJob(lessons.assignedToSomeoneElse);

    await request(app.getHttpServer())
      .get(`/api/admin/jobs/${jobId}/stream`)
      .set(as(tokens.owner))
      .expect(200);
  }, 25_000);

  it('still refuses a learner, who has no image permission at all', async () => {
    const jobId = await enqueueImageJob(lessons.assignedToAdmin);

    const response = await request(app.getHttpServer())
      .get(`/api/admin/jobs/${jobId}/stream`)
      .set(as(tokens.learner));

    expect(response.status).toBe(403);
    expect(response.body.errorCode).toBe(errorCodes.FORBIDDEN_ROLE);
  }, 25_000);
});

/**
 * §9.3 GET /courses/:courseId/stream, which P1 deferred until there was a
 * second producer.
 */
describe('the per-course job stream', () => {
  async function enqueueImageJobFor(lessonId: string): Promise<string> {
    const row = await createQueuedJob(prisma.generationJob, {
      jobType: 'generate_image',
      targetEntityId: lessonId,
    });
    jobRowIds.push(row.id);
    await imageQueue.enqueueGenerate({
      generationJobId: row.id,
      lessonId,
      blockReferenceId: 'fig1',
      composedPrompt: '[image/v1] a diagram',
      candidateCount: 4,
      createdByUserId: adminUserId,
    });
    return row.id;
  }

  it('follows the course to completion and carries both jobs for the owner', async () => {
    const a = await enqueueImageJobFor(lessons.assignedToAdmin);
    const b = await enqueueImageJobFor(lessons.assignedToSomeoneElse);

    const response = await request(app.getHttpServer())
      .get(`/api/admin/courses/${courseId}/stream`)
      .set(as(tokens.owner))
      .expect(200);

    const received = events(response.text);
    const ids = new Set(received.map((event) => event['generationJobId']));
    expect(ids.has(a)).toBe(true);
    expect(ids.has(b)).toBe(true);

    // It completes only once nothing is outstanding, and the last word on each
    // job is terminal.
    const lastFor = (id: string) =>
      received.filter((event) => event['generationJobId'] === id).at(-1);
    expect(lastFor(a)!['jobStatus']).toBe('succeeded');
    expect(lastFor(b)!['jobStatus']).toBe('succeeded');
  }, 30_000);

  it('filters per row: an admin sees their own lesson and not another admins', async () => {
    const mine = await enqueueImageJobFor(lessons.assignedToAdmin);
    const theirs = await enqueueImageJobFor(lessons.assignedToSomeoneElse);

    const response = await request(app.getHttpServer())
      .get(`/api/admin/courses/${courseId}/stream`)
      .set(as(tokens.admin))
      .expect(200);

    const ids = new Set(events(response.text).map((event) => event['generationJobId']));
    expect(ids.has(mine)).toBe(true);
    // R-02 applies per row, not to the endpoint as a whole.
    expect(ids.has(theirs)).toBe(false);
  }, 30_000);

  it('completes immediately when the course has nothing outstanding', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/admin/courses/${courseId}/stream`)
      .set(as(tokens.owner))
      .expect(200);

    expect(events(response.text)).toEqual([]);
  }, 15_000);

  it('refuses a learner', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/admin/courses/${courseId}/stream`)
      .set(as(tokens.learner));

    expect(response.status).toBe(403);
    expect(response.body.errorCode).toBe(errorCodes.FORBIDDEN_ROLE);
  });
});

/**
 * P5 extracted the four queues into `queueDefinitions` and re-pointed
 * JobStatusService at it. These cases pin the property that extraction could
 * silently break: the import queue's prefix is the EMPTY STRING, and
 * `'anything'.startsWith('')` is always true, so a resolver that checked the
 * definitions in registry order would route every id to import.
 *
 * Asserted against the service directly rather than through the SSE endpoint,
 * because what is under test is `locate`, not the stream the other blocks cover.
 */
describe('job id resolution across four queues', () => {
  it('resolves an UNPREFIXED id to the import queue, the format P1 shipped', async () => {
    const jobId = await importQueue.enqueueCommit({ marker: queueName });

    expect(jobId).not.toContain(':');
    expect(jobId).toMatch(/^\d+$/);

    const snapshot = await app.get(JobStatusService).snapshot(jobId);
    expect(snapshot?.jobType).toBe('import_course_outline');
  });

  it('resolves an `image:` id to the image queue and not to import', async () => {
    const jobId = await imageQueue.enqueueGenerate({
      generationJobId: '',
      lessonId: '',
      blockReferenceId: 'b1',
      composedPrompt: 'x',
      candidateCount: 1,
      createdByUserId: '',
    });

    expect(jobId).toMatch(/^image:\d+$/);

    const snapshot = await app.get(JobStatusService).snapshot(jobId);
    expect(snapshot?.jobType).toBe('generate_image');
  });

  it('does not fall through to import when a prefixed id has no job', async () => {
    // The regression the empty prefix invites: without prefix-first ordering,
    // this would be looked up in the import queue under the literal key
    // "image:999999" — and on a queue that happened to hold it, answered.
    expect(await app.get(JobStatusService).snapshot('image:999999')).toBeUndefined();
    expect(await app.get(JobStatusService).snapshot('script:999999')).toBeUndefined();
    expect(await app.get(JobStatusService).snapshot('audio:999999')).toBeUndefined();
  });

  it('reports an unknown unprefixed id as absent rather than throwing', async () => {
    expect(await app.get(JobStatusService).snapshot('999999')).toBeUndefined();
  });
});
