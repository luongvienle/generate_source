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
let worker: Worker;
const tokens = { owner: '', admin: '', learner: '' };
const userIds: string[] = [];

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

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(REDIS_URL)
    .useValue(url)
    .overrideProvider(ImportQueue)
    .useValue(importQueue)
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

  tokens.owner = await seed('owner', 'admin_owner');
  tokens.admin = await seed('admin', 'admin');
  tokens.learner = await seed('learner', 'learner');
});

afterAll(async () => {
  // Order matters: app.close() runs ImportQueue.onModuleDestroy, which closes the
  // queue, so the run-scoped queue must be drained before the app goes down.
  await worker.close();
  await importQueue.queue.obliterate({ force: true });
  await app.close();
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
