import { randomBytes } from 'node:crypto';
import { Queue, type Worker } from 'bullmq';
import { config as loadEnv } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createQueuedJob, getPrismaClient } from '@knowledge-explorer/database';
import {
  JOB_BACKOFF_DELAY_MS,
  JOB_MAX_ATTEMPTS,
  narrationJobNames,
  parseRedisUrl,
  type GenerateNarrationScriptJobData,
} from '@knowledge-explorer/shared';
import { FakeLlmProvider, type LlmProvider } from '@knowledge-explorer/ai';
import {
  blockListChecksum,
  buildSegment,
  parseLessonMarkdown,
  readScriptSegments,
  type BlockList,
} from '@knowledge-explorer/content';
import { createNarrationWorker } from '../src/jobs/narration.worker';
import { createNarrationProcessor } from '../src/jobs/narration.processor';
import { withJobLifecycle } from '../src/jobs/job-lifecycle';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * FR-SCRIPT-01 through a real BullMQ job and a real Postgres.
 *
 * The provider is the fake, which is the point: the assertions are about what the
 * processor does with what a provider returns — chunk arithmetic, reconciliation,
 * the all-or-nothing write, the in-flight lock — not about the provider.
 */

const url = process.env['REDIS_URL'] ?? 'redis://localhost:6380';
const queueName = `narration-processor-test-${randomBytes(4).toString('hex')}`;
const prisma = getPrismaClient();

const createdJobRows: string[] = [];
let queue: Queue;
let worker: Worker;
let lessonId = '';
let authorId = '';

/** A provider whose every call is a transport failure — NFR-03's territory. */
class ExplodingProvider implements LlmProvider {
  async complete(): Promise<never> {
    throw new Error('socket hang up');
  }
}

const lessonOf = (paragraphCount: number): string =>
  Array.from(
    { length: paragraphCount },
    (_, index) =>
      `Paragraph number ${String(index + 1)} explains a distinct idea in enough words to be narrated.`,
  ).join('\n\n') + '\n';

const parse = (markdown: string, previous: BlockList | null = null): BlockList => {
  const result = parseLessonMarkdown(markdown, previous);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.blockList;
};

/** Stores a block list as the content service would, and returns it. */
async function setContent(markdown: string, previous: BlockList | null = null): Promise<BlockList> {
  const blockList = parse(markdown, previous);
  const checksum = blockListChecksum(blockList);
  const data = {
    draftContentMarkdown: markdown,
    draftBlockList: blockList as unknown as object,
    draftContentChecksum: checksum,
    draftUpdatedAt: new Date(),
  };
  await prisma.lessonContent.upsert({
    where: { lessonId },
    create: { lessonId, ...data },
    update: data,
  });
  return blockList;
}

async function resetScript(): Promise<void> {
  await prisma.narrationScript.deleteMany({ where: { lessonId } });
}

async function lockedScript(): Promise<void> {
  await prisma.narrationScript.upsert({
    where: { lessonId },
    create: {
      lessonId,
      scriptSegments: { segments: [], totalEstimatedSeconds: null },
      scriptChecksum: '',
      sourceContentChecksum: '',
      scriptStatus: 'generating',
    },
    update: { scriptStatus: 'generating' },
  });
}

async function queuedRow(): Promise<string> {
  const { id } = await createQueuedJob(prisma.generationJob, {
    jobType: 'generate_narration_script',
    targetEntityId: lessonId,
  });
  createdJobRows.push(id);
  return id;
}

const jobData = (generationJobId: string): GenerateNarrationScriptJobData => ({
  generationJobId,
  lessonId,
  createdByUserId: authorId,
});

async function settle(jobId: string, timeoutMs = 40_000): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await (await queue.getJob(jobId))?.getState();
    if (state === 'completed' || state === 'failed') return state;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`job ${jobId} did not settle`);
}

/** Runs one job end to end and returns how it settled. */
async function run(mode?: string): Promise<{ state: string | undefined; generationJobId: string }> {
  const generationJobId = await queuedRow();
  await lockedScript();
  const job = await queue.add(narrationJobNames.generate, { ...jobData(generationJobId), mode });
  return { state: await settle(job.id as string), generationJobId };
}

const storedScript = () =>
  prisma.narrationScript.findUnique({
    where: { lessonId },
    select: {
      scriptSegments: true,
      scriptChecksum: true,
      sourceContentChecksum: true,
      scriptStatus: true,
      generatorModelName: true,
      generatorPromptVersion: true,
      inputTokenCount: true,
      outputTokenCount: true,
      reviewedByUserId: true,
      reviewedAt: true,
    },
  });

/** Counts calls per run so the ladder can be asserted from the outside. */
let lastProvider: FakeLlmProvider;
const progressEvents: Array<{ done: number; total: number }> = [];

beforeAll(async () => {
  const runId = randomBytes(4).toString('hex');
  const author = await prisma.user.create({
    data: { email: `narr-proc-${runId}@example.test`, name: 'author', userRole: 'admin' },
    select: { id: true },
  });
  authorId = author.id;

  const category = await prisma.category.create({
    data: { slug: `narr-proc-${runId}`, displayName: 'Narration processor' },
    select: { id: true },
  });
  const course = await prisma.course.create({
    data: {
      categoryId: category.id,
      slug: `narr-proc-${runId}`,
      levelLabel: 'L1',
      levelOrder: 1,
      title: 'Course',
      languageCode: 'vi',
    },
    select: { id: true },
  });
  const chapter = await prisma.chapter.create({
    data: { courseId: course.id, chapterOrder: 1, title: 'Chapter' },
    select: { id: true },
  });
  const lesson = await prisma.lesson.create({
    data: { chapterId: chapter.id, lessonOrder: 1, title: 'Lesson', learningObjective: 'Learn it' },
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

  worker = createNarrationWorker(
    url,
    {
      [narrationJobNames.generate]: withJobLifecycle(prisma.generationJob, async (job) => {
        const mode = (job.data as { mode?: string }).mode;
        const provider =
          mode === 'explode'
            ? new ExplodingProvider()
            : mode === 'flaky'
              ? new FakeLlmProvider({ fault: 'short-count', faultCallCount: 2 })
              : mode === 'always-bad'
                ? new FakeLlmProvider({ fault: 'unparseable' })
                : new FakeLlmProvider();
        if (provider instanceof FakeLlmProvider) lastProvider = provider;

        const tracking = {
          ...job,
          updateProgress: async (value: unknown) => {
            progressEvents.push(value as { done: number; total: number });
            await job.updateProgress(value as object);
          },
        } as typeof job;

        return createNarrationProcessor(prisma, provider)(tracking);
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

describe('createNarrationProcessor', () => {
  it('produces one segment per block from three chunks of 25, 25 and 10', async () => {
    await setContent(lessonOf(60));
    await resetScript();
    progressEvents.length = 0;

    const { state } = await run();
    expect(state).toBe('completed');

    const script = await storedScript();
    const envelope = readScriptSegments(script?.scriptSegments);
    expect(envelope.segments).toHaveLength(60);
    expect(script?.scriptStatus).toBe('ready');
    expect(envelope.segments.map((segment) => segment.segmentOrder)).toEqual(
      Array.from({ length: 60 }, (_, index) => index),
    );
    // Three chunks, one call each.
    expect(lastProvider.callCount).toBe(3);
  });

  it('emits one progress event per validated chunk', async () => {
    expect(progressEvents).toEqual([
      { done: 1, total: 3 },
      { done: 2, total: 3 },
      { done: 3, total: 3 },
    ]);
  });

  it('records the source checksum, model, prompt version and summed token counts', async () => {
    const script = await storedScript();
    const content = await prisma.lessonContent.findUnique({
      where: { lessonId },
      select: { draftContentChecksum: true },
    });

    expect(script?.sourceContentChecksum).toBe(content?.draftContentChecksum);
    expect(script?.generatorModelName).toBeTruthy();
    expect(script?.generatorPromptVersion).toBe('narration/v1');
    expect(script?.outputTokenCount).toBe(60 * 20);
    expect(script?.inputTokenCount).toBeGreaterThan(0);
  });

  it('retries a rejected chunk in process without consuming a BullMQ attempt', async () => {
    await setContent(lessonOf(25));
    await resetScript();

    const { state, generationJobId } = await run('flaky');
    expect(state).toBe('completed');
    // Rejected, rejected, accepted — all inside one BullMQ attempt.
    expect(lastProvider.callCount).toBe(3);

    const row = await prisma.generationJob.findUnique({ where: { id: generationJobId } });
    expect(row?.attemptCount).toBe(1);
    expect(row?.jobStatus).toBe('succeeded');
  });

  it('clears approval even when every segment was preserved', async () => {
    // Re-running over an unchanged lesson preserves every segment, and still
    // clears approval: a run writes machine text no human has read.
    await prisma.narrationScript.update({
      where: { lessonId },
      data: { reviewedByUserId: authorId, reviewedAt: new Date() },
    });

    const before = readScriptSegments((await storedScript())?.scriptSegments).segments;
    const { state } = await run();
    expect(state).toBe('completed');

    const after = await storedScript();
    expect(after?.reviewedByUserId).toBeNull();
    expect(after?.reviewedAt).toBeNull();
    expect(readScriptSegments(after?.scriptSegments).segments.map((s) => s.narrationText)).toEqual(
      before.map((s) => s.narrationText),
    );
  });

  it('preserves a hand-edited segment whose block did not change', async () => {
    const script = await storedScript();
    const envelope = readScriptSegments(script?.scriptSegments);
    const edited = envelope.segments.map((segment, index) =>
      index === 0 ? { ...segment, narrationText: 'MY OWN WORDS.', isEdited: true } : segment,
    );
    await prisma.narrationScript.update({
      where: { lessonId },
      data: {
        scriptSegments: { segments: edited, totalEstimatedSeconds: null } as unknown as object,
      },
    });

    const { state } = await run();
    expect(state).toBe('completed');

    const after = readScriptSegments((await storedScript())?.scriptSegments).segments;
    expect(after[0]?.narrationText).toBe('MY OWN WORDS.');
    expect(after[0]?.isEdited).toBe(true);
  });

  it('leaves a previously written script byte-identical when the run fails', async () => {
    const before = await storedScript();
    const beforeSegments = JSON.stringify(before?.scriptSegments);

    const { state, generationJobId } = await run('always-bad');
    expect(state).toBe('failed');

    const after = await storedScript();
    // Only the status moved. The segments describe the last SUCCESSFUL run.
    expect(JSON.stringify(after?.scriptSegments)).toBe(beforeSegments);
    expect(after?.scriptChecksum).toBe(before?.scriptChecksum);
    expect(after?.sourceContentChecksum).toBe(before?.sourceContentChecksum);
    expect(after?.scriptStatus).toBe('failed');

    // A §6.3 violation is unrecoverable: one attempt, not three.
    const row = await prisma.generationJob.findUnique({ where: { id: generationJobId } });
    expect(row?.attemptCount).toBe(1);
    expect(row?.jobStatus).toBe('failed');
    expect(row?.errorMessage).toContain('chunk 1 rejected');
  });

  it('lets a transport error reach NFR-03’s three attempts, then clears the lock', async () => {
    const { state, generationJobId } = await run('explode');
    expect(state).toBe('failed');

    const row = await prisma.generationJob.findUnique({ where: { id: generationJobId } });
    expect(row?.attemptCount).toBe(JOB_MAX_ATTEMPTS);
    expect(row?.jobStatus).toBe('failed');

    // Without clearing this, three timeouts would wedge the lesson forever.
    expect((await storedScript())?.scriptStatus).toBe('failed');
  }, 40_000);

  it('refuses a lesson with no blocks without calling the provider', async () => {
    await prisma.lessonContent.deleteMany({ where: { lessonId } });
    await resetScript();

    const { state, generationJobId } = await run();
    expect(state).toBe('failed');

    const row = await prisma.generationJob.findUnique({ where: { id: generationJobId } });
    expect(row?.errorMessage).toContain('SCRIPT_LESSON_EMPTY');
    expect(row?.attemptCount).toBe(1);
  });

  it('refuses a figure emptied between enqueue and execution, before any call', async () => {
    await setContent('::figure\n\nA paragraph that follows the figure and is narratable.\n');
    await resetScript();
    // No lesson_images row at all: the figure has no selected image, which is
    // the same gap as an uncaptioned one.
    const { state, generationJobId } = await run();
    expect(state).toBe('failed');

    const row = await prisma.generationJob.findUnique({ where: { id: generationJobId } });
    expect(row?.errorMessage).toContain('SCRIPT_FIGURES_INCOMPLETE');
    expect(row?.attemptCount).toBe(1);
  });

  it('drops the segment of a deleted block and generates one for a new block', async () => {
    const first = await setContent(lessonOf(3));
    await resetScript();
    expect((await run()).state).toBe('completed');

    const before = readScriptSegments((await storedScript())?.scriptSegments).segments;
    expect(before).toHaveLength(3);

    // Drop the last paragraph, append a different one.
    const second = await setContent(
      lessonOf(2) + '\nZebra mussels colonise freshwater intake pipes rapidly.\n',
      first,
    );
    expect((await run()).state).toBe('completed');

    const after = readScriptSegments((await storedScript())?.scriptSegments).segments;
    expect(after.map((segment) => segment.blockId)).toEqual(
      second.blocks.map((block) => block.blockId),
    );
    expect(after).toHaveLength(3);
  });
});

describe('buildSegment contract', () => {
  it('is what the processor stores, so the tab and P5 read the same shape', async () => {
    const blockList = parse(lessonOf(1));
    const sample = buildSegment({
      block: blockList.blocks[0]!,
      segmentOrder: 0,
      narrationText: 'x',
      isEdited: false,
    });
    expect(Object.keys(sample).sort()).toEqual(
      ['blockId', 'isEdited', 'narrationText', 'segmentChecksum', 'segmentOrder', 'sourceBlockChecksum'].sort(),
    );
  });
});
