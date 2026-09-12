import { randomBytes } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JOB_MAX_ATTEMPTS, importJobNames } from '@knowledge-explorer/shared';
import { ImportQueue } from '../src/jobs/import.queue';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * The producer side. NFR-03's retry policy is a queue default rather than a
 * per-call-site option, so this asserts it lands on jobs nobody configured.
 */

const url = process.env['REDIS_URL'] ?? 'redis://localhost:6380';
let queue: ImportQueue;

beforeAll(() => {
  queue = new ImportQueue(url, `curriculum-import-test-${randomBytes(4).toString('hex')}`);
});

afterAll(async () => {
  await queue.queue.obliterate({ force: true });
  await queue.onModuleDestroy();
});

describe('ImportQueue', () => {
  it('enqueues a dry run under the shared job name', async () => {
    const jobId = await queue.enqueueDryRun({ hello: 'world' });
    const job = await queue.queue.getJob(jobId);

    expect(job?.name).toBe(importJobNames.dryRun);
    expect(job?.data).toEqual({ hello: 'world' });
  });

  it('enqueues a commit under the shared job name', async () => {
    const jobId = await queue.enqueueCommit({ hello: 'world' });
    expect((await queue.queue.getJob(jobId))?.name).toBe(importJobNames.commit);
  });

  it('applies the NFR-03 retry policy without the caller asking for it', async () => {
    const jobId = await queue.enqueueDryRun({});
    const job = await queue.queue.getJob(jobId);

    expect(job?.opts.attempts).toBe(JOB_MAX_ATTEMPTS);
    expect(job?.opts.backoff).toMatchObject({ type: 'exponential' });
  });
});
