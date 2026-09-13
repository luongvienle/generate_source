import { randomBytes } from 'node:crypto';
import { Queue, type Worker } from 'bullmq';
import { config as loadEnv } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createQueuedJob, getPrismaClient } from '@knowledge-explorer/database';
import {
  audioJobNames,
  parseRedisUrl,
  type GenerateAudioJobData,
} from '@knowledge-explorer/shared';
import {
  FakeTextToSpeechProvider,
  type SynthesisRequest,
  type SynthesisResult,
  type TextToSpeechProvider,
} from '@knowledge-explorer/ai';
import {
  blockListChecksum,
  buildSegment,
  parseLessonMarkdown,
  scriptChecksum,
  segmentChecksum,
  type BlockList,
  type NarrationSegment,
} from '@knowledge-explorer/content';
import { S3ObjectStorage, s3ConfigFromEnv, type ObjectStorage } from '@knowledge-explorer/storage';
import { createAudioWorker } from '../src/jobs/audio.worker';
import { createAudioProcessor } from '../src/jobs/audio.processor';
import { withJobLifecycle } from '../src/jobs/job-lifecycle';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * FR-AUDIO-01 through a real BullMQ job, a real Postgres and real MinIO.
 *
 * The provider is the fake, which is the point: these assertions are about what
 * the processor does — the reuse pass, the all-or-nothing write, the in-flight
 * lock, character counting — not about the provider. The timing work itself is
 * apps/worker/test/ffmpeg.spec.ts and audio-merge.spec.ts.
 */

const url = process.env['REDIS_URL'] ?? 'redis://localhost:6380';
const queueName = `audio-processor-test-${randomBytes(4).toString('hex')}`;
const run = randomBytes(4).toString('hex');
const prisma = getPrismaClient();

let queue: Queue;
let worker: Worker;
let storage: ObjectStorage;
let lessonId = '';
let courseId = '';

/** Counts calls so reuse is asserted on spend, not on a log line. */
class CountingProvider implements TextToSpeechProvider {
  readonly maxInputCharacters: number;
  readonly requests: SynthesisRequest[] = [];
  private readonly inner = new FakeTextToSpeechProvider();

  constructor() {
    this.maxInputCharacters = this.inner.maxInputCharacters;
  }

  async synthesize(request: SynthesisRequest): Promise<SynthesisResult> {
    this.requests.push(request);
    return this.inner.synthesize(request);
  }

  get callCount(): number {
    return this.requests.length;
  }

  reset(): void {
    this.requests.length = 0;
  }
}

/** Fails on the Nth call — NFR-03's territory, and the all-or-nothing proof. */
class FailsOnNthProvider implements TextToSpeechProvider {
  readonly maxInputCharacters = 4_096;
  private calls = 0;
  private readonly inner = new FakeTextToSpeechProvider();

  constructor(private readonly failAt: number) {}

  async synthesize(request: SynthesisRequest): Promise<SynthesisResult> {
    this.calls += 1;
    if (this.calls === this.failAt) throw new Error('socket hang up');
    return this.inner.synthesize(request);
  }
}

const provider = new CountingProvider();
/** Swapped per test, so one worker serves every scenario. */
let active: TextToSpeechProvider = provider;

const lessonOf = (paragraphCount: number): string =>
  Array.from(
    { length: paragraphCount },
    (_, index) =>
      `Paragraph number ${String(index + 1)} explains a distinct idea in enough words to narrate.`,
  ).join('\n\n') + '\n';

const parse = (markdown: string): BlockList => {
  const result = parseLessonMarkdown(markdown, null);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.blockList;
};

async function setContent(markdown: string): Promise<BlockList> {
  const blockList = parse(markdown);
  const data = {
    draftContentMarkdown: markdown,
    draftBlockList: blockList as unknown as object,
    draftContentChecksum: blockListChecksum(blockList),
    draftUpdatedAt: new Date(),
  };
  await prisma.lessonContent.upsert({
    where: { lessonId },
    create: { lessonId, ...data },
    update: data,
  });
  return blockList;
}

/** Writes an approved script, as a successful narration run plus an approval would. */
async function setScript(blockList: BlockList, text = (id: string) => `Spoken ${id}.`): Promise<NarrationSegment[]> {
  const segments = blockList.blocks.map((block, index) =>
    buildSegment({ block, segmentOrder: index, narrationText: text(block.blockId), isEdited: false }),
  );
  const content = await prisma.lessonContent.findUnique({
    where: { lessonId },
    select: { draftContentChecksum: true },
  });
  const payload = {
    scriptSegments: { segments, totalEstimatedSeconds: 30 } as unknown as object,
    scriptChecksum: scriptChecksum(segments),
    sourceContentChecksum: content?.draftContentChecksum ?? '',
    scriptStatus: 'ready',
    reviewedAt: new Date(),
  };
  await prisma.narrationScript.upsert({
    where: { lessonId },
    create: { lessonId, ...payload },
    update: payload,
  });
  return segments;
}

/** Takes the in-flight lock, as AudioService.requestGeneration does. */
async function lockAudio(voiceIdentifier: string): Promise<void> {
  const existing = await prisma.lessonAudio.findFirst({ where: { lessonId }, select: { id: true } });
  if (existing) {
    await prisma.lessonAudio.update({
      where: { id: existing.id },
      data: { audioStatus: 'generating' },
    });
    return;
  }
  await prisma.lessonAudio.create({
    data: {
      lessonId,
      voiceIdentifier,
      voiceProviderName: 'fake',
      mergedAudioFileUrl: '',
      sourceScriptChecksum: '',
      audioStatus: 'generating',
    },
  });
}

async function settle(jobId: string, timeoutMs = 120_000): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await (await queue.getJob(jobId))?.getState();
    if (state === 'completed' || state === 'failed') return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`job ${jobId} did not settle`);
}

/** Runs one job end to end and returns how it settled. */
async function runJob(voiceIdentifier = 'alloy'): Promise<string | undefined> {
  const { id: generationJobId } = await createQueuedJob(prisma.generationJob, {
    jobType: 'generate_audio',
    targetEntityId: lessonId,
  });
  await lockAudio(voiceIdentifier);

  const data: GenerateAudioJobData = {
    generationJobId,
    lessonId,
    voiceIdentifier,
    voiceProviderName: 'fake',
    createdByUserId: '',
  };
  const job = await queue.add(audioJobNames.generate, data);
  return settle(job.id as string);
}

const storedAudio = () =>
  prisma.lessonAudio.findFirst({
    where: { lessonId },
    include: { segments: { orderBy: { segmentOrder: 'asc' } } },
  });

beforeAll(async () => {
  storage = new S3ObjectStorage(s3ConfigFromEnv());
  queue = new Queue(queueName, { connection: parseRedisUrl(url) });

  worker = createAudioWorker(
    url,
    {
      [audioJobNames.generate]: withJobLifecycle(
        prisma.generationJob,
        // `active` is read per call, so a test can swap the provider without
        // rebuilding the worker.
        createAudioProcessor(
          prisma,
          {
            get maxInputCharacters() {
              return active.maxInputCharacters;
            },
            synthesize: (request) => active.synthesize(request),
          },
          storage,
        ),
      ),
    },
    queueName,
  );
  await worker.waitUntilReady();

  const category = await prisma.category.create({
    data: { slug: `audio-proc-${run}`, displayName: 'Audio processor' },
    select: { id: true },
  });
  const course = await prisma.course.create({
    data: {
      categoryId: category.id,
      slug: `audio-proc-${run}`,
      levelLabel: 'L1',
      levelOrder: 1,
      title: 'Audio processor',
      languageCode: 'vi',
    },
    select: { id: true },
  });
  courseId = course.id;
  const chapter = await prisma.chapter.create({
    data: { courseId: course.id, chapterOrder: 1, title: 'Chapter one' },
    select: { id: true },
  });
  const lesson = await prisma.lesson.create({
    data: { chapterId: chapter.id, lessonOrder: 1, title: 'Lesson one' },
    select: { id: true },
  });
  lessonId = lesson.id;
}, 120_000);

afterAll(async () => {
  await worker?.close();
  await queue?.obliterate({ force: true }).catch(() => undefined);
  await queue?.close();
  await prisma.$disconnect();
});

describe('a first run', () => {
  it('synthesizes every segment, merges, and writes one ready row', async () => {
    const blockList = await setContent(lessonOf(4));
    await setScript(blockList);
    provider.reset();
    active = provider;

    expect(await runJob()).toBe('completed');

    expect(provider.callCount).toBe(4);

    const audio = await storedAudio();
    expect(audio?.audioStatus).toBe('ready');
    expect(audio?.mergedAudioFileUrl).not.toBe('');
    expect(audio?.segments).toHaveLength(4);
    expect(audio?.totalDurationSeconds).toBeGreaterThan(0);
  }, 180_000);

  it('stores contiguous offsets starting at zero', async () => {
    const audio = await storedAudio();
    const segments = audio!.segments;

    expect(segments[0]!.startMillisecond).toBe(0);
    for (let index = 0; index + 1 < segments.length; index += 1) {
      expect(segments[index]!.endMillisecond).toBe(segments[index + 1]!.startMillisecond);
    }
  });

  it('passes the course language to the provider rather than an empty string', () => {
    expect(provider.requests.every((request) => request.languageCode === 'vi')).toBe(true);
  });

  it('stores a per-segment checksum, without which reuse is unimplementable', async () => {
    const audio = await storedAudio();
    for (const segment of audio!.segments) {
      expect(segment.sourceSegmentChecksum).toMatch(/^[0-9a-f]{64}$/);
      expect(segment.segmentAudioFileUrl).toBeTruthy();
    }
  });

  /** §6.4 and NFR-05: the whole script, not just what this run paid for. */
  it('counts characters over the whole script', async () => {
    const script = await prisma.narrationScript.findUnique({
      where: { lessonId },
      select: { scriptSegments: true },
    });
    const segments = (script!.scriptSegments as unknown as { segments: NarrationSegment[] }).segments;
    const expected = segments.reduce((total, segment) => total + segment.narrationText.length, 0);

    const audio = await storedAudio();
    expect(audio?.totalCharacterCount).toBe(expected);
  });
});

describe('FR-AUDIO-01 reuse across runs', () => {
  it('makes ZERO provider calls when nothing changed', async () => {
    provider.reset();
    active = provider;

    expect(await runJob()).toBe('completed');

    expect(provider.callCount).toBe(0);

    const audio = await storedAudio();
    expect(audio?.audioStatus).toBe('ready');
    expect(audio?.segments).toHaveLength(4);
    // Still a real merged file, produced from the reused segment objects.
    expect(audio?.mergedAudioFileUrl).not.toBe('');
  }, 180_000);

  it('re-synthesizes exactly one segment after one narration edit, keeping the rest byte for byte', async () => {
    const before = await storedAudio();
    const urlsBefore = new Map(
      before!.segments.map((segment) => [segment.blockReferenceId, segment.segmentAudioFileUrl]),
    );

    const script = await prisma.narrationScript.findUnique({
      where: { lessonId },
      select: { scriptSegments: true },
    });
    const envelope = script!.scriptSegments as unknown as {
      segments: NarrationSegment[];
      totalEstimatedSeconds: number;
    };
    const editedBlockId = envelope.segments[1]!.blockId;
    const edited = envelope.segments.map((segment, index) =>
      index === 1
        ? {
            ...segment,
            narrationText: 'Một câu hoàn toàn mới.',
            segmentChecksum: segmentChecksum('Một câu hoàn toàn mới.'),
            isEdited: true,
          }
        : segment,
    );
    await prisma.narrationScript.update({
      where: { lessonId },
      data: {
        scriptSegments: { ...envelope, segments: edited } as unknown as object,
        scriptChecksum: scriptChecksum(edited),
      },
    });

    provider.reset();
    active = provider;
    expect(await runJob()).toBe('completed');

    // The whole saving FR-AUDIO-01 exists for.
    expect(provider.callCount).toBe(1);
    expect(provider.requests[0]!.text).toBe('Một câu hoàn toàn mới.');

    const after = await storedAudio();
    for (const segment of after!.segments) {
      if (segment.blockReferenceId === editedBlockId) {
        expect(segment.segmentAudioFileUrl).not.toBe(urlsBefore.get(segment.blockReferenceId));
      } else {
        expect(segment.segmentAudioFileUrl).toBe(urlsBefore.get(segment.blockReferenceId));
      }
    }
  }, 180_000);

  /**
   * FR-AUDIO-03 stores the voice on the row so a change is detectable. The
   * consequence is here: the text is unchanged but the audio is not the audio
   * anyone asked for, so nothing is reusable.
   */
  it('re-synthesizes EVERY segment when the voice changes', async () => {
    provider.reset();
    active = provider;

    expect(await runJob('nova')).toBe('completed');

    expect(provider.callCount).toBe(4);
    expect(provider.requests.every((request) => request.voiceIdentifier === 'nova')).toBe(true);

    const audio = await storedAudio();
    expect(audio?.voiceIdentifier).toBe('nova');
    // One row per lesson: the voice is replaced in place, never accumulated.
    const rows = await prisma.lessonAudio.count({ where: { lessonId } });
    expect(rows).toBe(1);
  }, 180_000);
});

describe('failure is all or nothing', () => {
  it('leaves the previous row, its segments and its merged URL untouched', async () => {
    const before = await storedAudio();
    expect(before?.audioStatus).toBe('ready');

    // Force a fresh synthesis of all four, then fail on the third of them.
    const blockList = await setContent(lessonOf(4));
    await setScript(blockList, (id) => `Bản đọc mới cho ${id}.`);

    active = new FailsOnNthProvider(3);
    expect(await runJob('nova')).toBe('failed');

    const after = await storedAudio();

    // The status describes the last RUN; everything else describes the last
    // SUCCESSFUL run. That is P4's rule, deliberately repeated here.
    expect(after?.audioStatus).toBe('failed');
    expect(after?.mergedAudioFileUrl).toBe(before?.mergedAudioFileUrl);
    expect(after?.sourceScriptChecksum).toBe(before?.sourceScriptChecksum);
    expect(after?.totalDurationSeconds).toBe(before?.totalDurationSeconds);
    expect(after?.totalCharacterCount).toBe(before?.totalCharacterCount);
    expect(after?.segments.map((segment) => segment.segmentAudioFileUrl)).toEqual(
      before?.segments.map((segment) => segment.segmentAudioFileUrl),
    );
  }, 180_000);

  it('clears the in-flight lock so the lesson is not wedged', async () => {
    const audio = await storedAudio();
    expect(audio?.audioStatus).not.toBe('generating');
  });

  it('refuses a script whose approval was withdrawn while the job waited', async () => {
    await prisma.narrationScript.update({
      where: { lessonId },
      data: { reviewedAt: null, reviewedByUserId: null },
    });

    active = provider;
    provider.reset();
    expect(await runJob('nova')).toBe('failed');

    // Nothing was spent: the precondition is re-checked in the worker, not only
    // at enqueue, because a run can sit in the queue while approval changes.
    expect(provider.callCount).toBe(0);
  }, 120_000);
});
