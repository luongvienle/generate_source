import { randomBytes, randomUUID } from 'node:crypto';
import { Queue, type Worker } from 'bullmq';
import { config as loadEnv } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createQueuedJob, getPrismaClient } from '@knowledge-explorer/database';
import {
  JOB_BACKOFF_DELAY_MS,
  JOB_MAX_ATTEMPTS,
  importJobNames,
  parseRedisUrl,
} from '@knowledge-explorer/shared';
import { createImportWorker } from '../src/jobs/import.worker';
import { withJobLifecycle } from '../src/jobs/job-lifecycle';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * The state machine driven by a real BullMQ job rather than by direct calls:
 * a handler that always throws must exhaust NFR-03's three attempts and leave
 * the row `failed`, and a handler that succeeds must leave it `succeeded`.
 */

const url = process.env['REDIS_URL'] ?? 'redis://localhost:6380';
const queueName = `curriculum-lifecycle-test-${randomBytes(4).toString('hex')}`;
const prisma = getPrismaClient();
const createdRows: string[] = [];

let queue: Queue;
let worker: Worker;

async function queuedRow(): Promise<string> {
  const { id } = await createQueuedJob(prisma.generationJob, {
    jobType: 'import_course_outline',
    targetEntityId: randomUUID(),
  });
  createdRows.push(id);
  return id;
}

beforeAll(async () => {
  queue = new Queue(queueName, {
    connection: parseRedisUrl(url),
    defaultJobOptions: {
      attempts: JOB_MAX_ATTEMPTS,
      backoff: { type: 'exponential', delay: JOB_BACKOFF_DELAY_MS },
    },
  });
  worker = createImportWorker(
    url,
    {
      [importJobNames.commit]: withJobLifecycle(prisma.generationJob, async (job) => {
        if ((job.data as { explode?: boolean }).explode) throw new Error('deliberate failure');
        return { ok: true };
      }),
      [importJobNames.dryRun]: withJobLifecycle(prisma.generationJob, async () => ({ ok: true })),
    },
    queueName,
  );
  await worker.waitUntilReady();
});

afterAll(async () => {
  await worker.close();
  await queue.obliterate({ force: true });
  await queue.close();
  await prisma.generationJob.deleteMany({ where: { id: { in: createdRows } } });
  await prisma.$disconnect();
});

async function settle(jobId: string, timeoutMs = 20_000): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await (await queue.getJob(jobId))?.getState();
    if (state === 'completed' || state === 'failed') return state;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`job ${jobId} did not settle`);
}

describe('withJobLifecycle', () => {
  it('drives a succeeding job through queued → running → succeeded', async () => {
    const generationJobId = await queuedRow();
    const job = await queue.add(importJobNames.commit, { generationJobId });

    expect(await settle(job.id!)).toBe('completed');
    const row = await prisma.generationJob.findUniqueOrThrow({ where: { id: generationJobId } });
    expect(row.jobStatus).toBe('succeeded');
    expect(row.startedAt).not.toBeNull();
    expect(row.finishedAt).not.toBeNull();
  });

  it('drives an always-throwing job to failed with attempt_count = 3', async () => {
    const generationJobId = await queuedRow();
    const job = await queue.add(importJobNames.commit, { generationJobId, explode: true });

    expect(await settle(job.id!)).toBe('failed');
    const row = await prisma.generationJob.findUniqueOrThrow({ where: { id: generationJobId } });
    expect(row.jobStatus).toBe('failed');
    expect(row.attemptCount).toBe(JOB_MAX_ATTEMPTS);
    expect(row.errorMessage).toBe('deliberate failure');
    expect(row.finishedAt).not.toBeNull();
  });

  it('writes no generation_jobs row for a dry run (FR-IMP-02)', async () => {
    // Scoped to a marker rather than a global count: other workspaces' suites run
    // concurrently under turbo and write generation_jobs rows of their own.
    const marker = randomUUID();
    const job = await queue.add(importJobNames.dryRun, { targetEntityId: marker });

    expect(await settle(job.id!)).toBe('completed');
    expect(await prisma.generationJob.count({ where: { targetEntityId: marker } })).toBe(0);
  });
});
