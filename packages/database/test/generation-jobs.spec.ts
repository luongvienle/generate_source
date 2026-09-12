import { randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import { getPrismaClient } from '../src/client';
import {
  createQueuedJob,
  markJobAttemptFailed,
  markJobRunning,
  markJobSucceeded,
  type JobLogger,
} from '../src/generation-jobs';

loadEnv({ path: '../../.env' });

/**
 * The generation_jobs state machine against a real database.
 *
 * specs/p1-curriculum/spec.md fixes the members of job_status — §8.1 catalogues
 * none — and the transitions queued → running → succeeded | failed.
 */

const prisma = getPrismaClient();
const created: string[] = [];

function recorder(): { logger: JobLogger; lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  const push = (message: string) => lines.push(JSON.parse(message) as Record<string, unknown>);
  return { logger: { log: push, error: push }, lines };
}

async function newJob(logger?: JobLogger): Promise<string> {
  const { id } = await createQueuedJob(
    prisma.generationJob,
    { jobType: 'import_course_outline', targetEntityId: randomUUID() },
    logger,
  );
  created.push(id);
  return id;
}

const read = (id: string) => prisma.generationJob.findUniqueOrThrow({ where: { id } });

afterAll(async () => {
  await prisma.generationJob.deleteMany({ where: { id: { in: created } } });
  await prisma.$disconnect();
});

describe('generation_jobs lifecycle', () => {
  it('creates a job at queued, with §8 defaults untouched', async () => {
    const row = await read(await newJob());

    expect(row.jobStatus).toBe('queued');
    expect(row.attemptCount).toBe(0);
    expect(row.startedAt).toBeNull();
    expect(row.finishedAt).toBeNull();
    expect(row.errorMessage).toBeNull();
  });

  it('running stamps started_at and records the attempt', async () => {
    const id = await newJob();
    await markJobRunning(prisma.generationJob, id, 1);
    const row = await read(id);

    expect(row.jobStatus).toBe('running');
    expect(row.attemptCount).toBe(1);
    expect(row.startedAt).not.toBeNull();
    expect(row.finishedAt).toBeNull();
  });

  it('succeeded stamps finished_at and clears any earlier error', async () => {
    const id = await newJob();
    await markJobRunning(prisma.generationJob, id, 1);
    await markJobAttemptFailed(prisma.generationJob, id, {
      attemptCount: 1,
      errorMessage: 'transient',
      isFinalAttempt: false,
    });
    await markJobSucceeded(prisma.generationJob, id);
    const row = await read(id);

    expect(row.jobStatus).toBe('succeeded');
    expect(row.finishedAt).not.toBeNull();
    expect(row.errorMessage).toBeNull();
  });

  it('a non-final failed attempt stays running — a retry never re-enters the machine', async () => {
    const id = await newJob();
    await markJobRunning(prisma.generationJob, id, 1);
    await markJobAttemptFailed(prisma.generationJob, id, {
      attemptCount: 1,
      errorMessage: 'boom',
      isFinalAttempt: false,
    });
    const row = await read(id);

    expect(row.jobStatus).toBe('running');
    expect(row.attemptCount).toBe(1);
    expect(row.errorMessage).toBe('boom');
    expect(row.finishedAt).toBeNull();
  });

  it('the final failed attempt lands on failed with NFR-03 attempt_count = 3', async () => {
    const id = await newJob();
    for (const attempt of [1, 2, 3]) {
      await markJobRunning(prisma.generationJob, id, attempt);
      await markJobAttemptFailed(prisma.generationJob, id, {
        attemptCount: attempt,
        errorMessage: `boom ${attempt}`,
        isFinalAttempt: attempt === 3,
      });
    }
    const row = await read(id);

    expect(row.jobStatus).toBe('failed');
    expect(row.attemptCount).toBe(3);
    expect(row.errorMessage).toBe('boom 3');
    expect(row.finishedAt).not.toBeNull();
  });

  it('emits NFR-07 fields on every transition', async () => {
    const { logger, lines } = recorder();
    const id = await newJob(logger);
    await markJobRunning(prisma.generationJob, id, 1, logger);
    await markJobSucceeded(prisma.generationJob, id, logger);
    await markJobAttemptFailed(
      prisma.generationJob,
      id,
      { attemptCount: 1, errorMessage: 'x', isFinalAttempt: true },
      logger,
    );

    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect(line['jobType']).toBe('import_course_outline');
      expect(line['targetEntityId']).toEqual(expect.any(String));
      expect(line['attemptCount']).toEqual(expect.any(Number));
    }
  });
});
