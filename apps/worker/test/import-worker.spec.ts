import { randomBytes } from 'node:crypto';
import { Queue, type Worker } from 'bullmq';
import { config as loadEnv } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  JOB_BACKOFF_DELAY_MS,
  JOB_MAX_ATTEMPTS,
  importJobNames,
  parseRedisUrl,
} from '@knowledge-explorer/shared';
import { createImportWorker } from '../src/jobs/import.worker';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * The consumer side, against a real Redis.
 *
 * The producer is a plain BullMQ Queue configured from the same
 * @knowledge-explorer/shared constants the API uses, rather than an import of
 * apps/api — the two apps are separate deployables (§11) and the only thing
 * binding them is that shared contract. apps/api/test/import-queue.spec.ts
 * covers the producer.
 *
 * A run-scoped queue name keeps this off the development queue.
 */

const url = process.env['REDIS_URL'] ?? 'redis://localhost:6380';
const queueName = `curriculum-import-test-${randomBytes(4).toString('hex')}`;

let queue: Queue;
let worker: Worker;
const handled: Array<{ name: string; data: unknown }> = [];

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
      [importJobNames.dryRun]: async (job) => {
        handled.push({ name: job.name, data: job.data });
        return { ok: true };
      },
    },
    queueName,
  );
  await worker.waitUntilReady();
});

afterAll(async () => {
  await worker.close();
  await queue.obliterate({ force: true });
  await queue.close();
});

async function settle(jobId: string, timeoutMs = 20_000): Promise<'completed' | 'failed'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await (await queue.getJob(jobId))?.getState();
    if (state === 'completed' || state === 'failed') return state;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`job ${jobId} did not settle within ${timeoutMs}ms`);
}

describe('the import queue consumer', () => {
  it('picks up a queued job and runs the handler registered for its name', async () => {
    const job = await queue.add(importJobNames.dryRun, { marker: queueName });

    expect(await settle(job.id!)).toBe('completed');
    expect(handled).toEqual([{ name: importJobNames.dryRun, data: { marker: queueName } }]);
  });

  it('fails a job whose name has no handler, rather than silently dropping it', async () => {
    const job = await queue.add(importJobNames.commit, { marker: queueName });

    expect(await settle(job.id!)).toBe('failed');
    expect((await queue.getJob(job.id!))?.failedReason).toContain('No handler registered');
  });

  it('stops after JOB_MAX_ATTEMPTS rather than retrying forever (NFR-03)', async () => {
    const job = await queue.add(importJobNames.commit, { marker: queueName });
    await settle(job.id!);

    expect((await queue.getJob(job.id!))?.attemptsMade).toBe(JOB_MAX_ATTEMPTS);
  });
});
