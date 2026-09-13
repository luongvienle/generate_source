import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Queue, type Worker } from 'bullmq';
import { config as loadEnv } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createQueuedJob, getPrismaClient } from '@knowledge-explorer/database';
import {
  audioJobNames,
  parseRedisUrl,
  type GenerateAudioJobData,
} from '@knowledge-explorer/shared';
import { FakeTextToSpeechProvider, fakeDurationMs, fakeFrequency } from '@knowledge-explorer/ai';
import {
  blockListChecksum,
  buildSegment,
  parseLessonMarkdown,
  scriptChecksum,
  type BlockList,
} from '@knowledge-explorer/content';
import { S3ObjectStorage, s3ConfigFromEnv, type ObjectStorage } from '@knowledge-explorer/storage';
import { AUDIO_SAMPLE_RATE, probeDurationMs } from '../src/audio/ffmpeg';
import { createAudioWorker } from '../src/jobs/audio.worker';
import { createAudioProcessor } from '../src/jobs/audio.processor';
import { withJobLifecycle } from '../src/jobs/job-lifecycle';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * THE ASSERTION P5 EXISTS FOR, at processor level.
 *
 * ffmpeg.spec.ts proves `mergeSegments` computes correct boundaries. This proves
 * the numbers that actually reach `audio_segments` still describe the file that
 * actually reached object storage — that nothing is lost between the merge and
 * the database, and that the bytes a learner would fetch are the bytes the
 * offsets were measured against.
 *
 * It reads the merged object back out of MinIO, cuts each STORED window out of
 * it, and recovers which tone is audible there. A boundary that points at the
 * wrong audio fails, however tidy the arithmetic that produced it.
 */

const run = promisify(execFile);
const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6380';
const suffix = randomBytes(4).toString('hex');
const queueName = `audio-merge-test-${suffix}`;
const prisma = getPrismaClient();

let queue: Queue;
let worker: Worker;
let storage: ObjectStorage;
let directory: string;
let lessonId = '';

/** Eight paragraphs, so durations and tones differ and drift would accumulate. */
const SEGMENT_COUNT = 8;

const lessonMarkdown = Array.from(
  { length: SEGMENT_COUNT },
  (_, index) => `Paragraph number ${String(index + 1)} carries its own distinct idea.`,
).join('\n\n') + '\n';

/** The text the script will hold for a block — distinct per segment, so tones differ. */
const narrationFor = (blockId: string): string => `Đoạn đọc cho khối ${blockId}.`;

/** Recovers the dominant frequency inside a window by counting zero crossings. */
async function dominantFrequency(path: string, startMs: number, endMs: number): Promise<number> {
  const seconds = (endMs - startMs) / 1000;

  const { stdout } = await run(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-i',
      path,
      // AFTER -i: accurate output seeking, rather than snapping to a frame.
      '-ss',
      (startMs / 1000).toFixed(3),
      '-t',
      seconds.toFixed(3),
      '-f',
      's16le',
      '-ac',
      '1',
      '-ar',
      String(AUDIO_SAMPLE_RATE),
      'pipe:1',
    ],
    { encoding: 'buffer', maxBuffer: 128 * 1024 * 1024 },
  );

  const threshold = 0.1 * 32_768;
  let crossings = 0;
  let state: 'high' | 'low' | 'unknown' = 'unknown';

  for (let offset = 0; offset + 1 < stdout.byteLength; offset += 2) {
    const sample = stdout.readInt16LE(offset);
    if (sample > threshold) {
      if (state === 'low') crossings += 1;
      state = 'high';
    } else if (sample < -threshold) {
      if (state === 'high') crossings += 1;
      state = 'low';
    }
  }

  return crossings / (2 * seconds);
}

beforeAll(async () => {
  storage = new S3ObjectStorage(s3ConfigFromEnv());
  directory = await mkdtemp(join(tmpdir(), 'ke-audio-merge-'));
  queue = new Queue(queueName, { connection: parseRedisUrl(redisUrl) });

  worker = createAudioWorker(
    redisUrl,
    {
      [audioJobNames.generate]: withJobLifecycle(
        prisma.generationJob,
        createAudioProcessor(prisma, new FakeTextToSpeechProvider(), storage),
      ),
    },
    queueName,
  );
  await worker.waitUntilReady();

  const category = await prisma.category.create({
    data: { slug: `audio-merge-${suffix}`, displayName: 'Audio merge' },
    select: { id: true },
  });
  const course = await prisma.course.create({
    data: {
      categoryId: category.id,
      slug: `audio-merge-${suffix}`,
      levelLabel: 'L1',
      levelOrder: 1,
      title: 'Audio merge',
      languageCode: 'vi',
    },
    select: { id: true },
  });
  const chapter = await prisma.chapter.create({
    data: { courseId: course.id, chapterOrder: 1, title: 'Chapter one' },
    select: { id: true },
  });
  const lesson = await prisma.lesson.create({
    data: { chapterId: chapter.id, lessonOrder: 1, title: 'Lesson one' },
    select: { id: true },
  });
  lessonId = lesson.id;

  const parsed = parseLessonMarkdown(lessonMarkdown, null);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const blockList: BlockList = parsed.blockList;

  await prisma.lessonContent.create({
    data: {
      lessonId,
      draftContentMarkdown: lessonMarkdown,
      draftBlockList: blockList as unknown as object,
      draftContentChecksum: blockListChecksum(blockList),
      draftUpdatedAt: new Date(),
    },
  });

  const segments = blockList.blocks.map((block, index) =>
    buildSegment({
      block,
      segmentOrder: index,
      narrationText: narrationFor(block.blockId),
      isEdited: false,
    }),
  );

  await prisma.narrationScript.create({
    data: {
      lessonId,
      scriptSegments: { segments, totalEstimatedSeconds: 40 } as unknown as object,
      scriptChecksum: scriptChecksum(segments),
      sourceContentChecksum: blockListChecksum(blockList),
      scriptStatus: 'ready',
      reviewedAt: new Date(),
    },
  });

  await prisma.lessonAudio.create({
    data: {
      lessonId,
      voiceIdentifier: 'alloy',
      voiceProviderName: 'fake',
      mergedAudioFileUrl: '',
      sourceScriptChecksum: '',
      audioStatus: 'generating',
    },
  });

  const { id: generationJobId } = await createQueuedJob(prisma.generationJob, {
    jobType: 'generate_audio',
    targetEntityId: lessonId,
  });

  const data: GenerateAudioJobData = {
    generationJobId,
    lessonId,
    voiceIdentifier: 'alloy',
    voiceProviderName: 'fake',
    createdByUserId: '',
  };
  const job = await queue.add(audioJobNames.generate, data);

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const state = await (await queue.getJob(job.id as string))?.getState();
    if (state === 'completed') break;
    if (state === 'failed') {
      const failed = await queue.getJob(job.id as string);
      throw new Error(`audio job failed: ${failed?.failedReason ?? 'unknown'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}, 300_000);

afterAll(async () => {
  await worker?.close();
  await queue?.obliterate({ force: true }).catch(() => undefined);
  await queue?.close();
  await rm(directory, { recursive: true, force: true });
  await prisma.$disconnect();
});

describe('the offsets that reach the database', () => {
  it('writes one segment row per narration segment, in order', async () => {
    const audio = await prisma.lessonAudio.findFirst({
      where: { lessonId },
      include: { segments: { orderBy: { segmentOrder: 'asc' } } },
    });

    expect(audio?.audioStatus).toBe('ready');
    expect(audio?.segments).toHaveLength(SEGMENT_COUNT);
    expect(audio?.segments.map((segment) => segment.segmentOrder)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
  });

  it('starts at zero and is contiguous, with no gaps or overlaps', async () => {
    const audio = await prisma.lessonAudio.findFirst({
      where: { lessonId },
      include: { segments: { orderBy: { segmentOrder: 'asc' } } },
    });
    const segments = audio!.segments;

    expect(segments[0]!.startMillisecond).toBe(0);
    for (let index = 0; index + 1 < segments.length; index += 1) {
      // Exact, not a tolerance: cumulative sums over integer sample counts.
      expect(segments[index]!.endMillisecond).toBe(segments[index + 1]!.startMillisecond);
      expect(segments[index]!.endMillisecond).toBeGreaterThan(segments[index]!.startMillisecond);
    }
  });

  it('gives each segment the length its narration text predicts', async () => {
    const audio = await prisma.lessonAudio.findFirst({
      where: { lessonId },
      include: { segments: { orderBy: { segmentOrder: 'asc' } } },
    });

    for (const segment of audio!.segments) {
      const nominal = fakeDurationMs(narrationFor(segment.blockReferenceId));
      const measured = segment.endMillisecond - segment.startMillisecond;
      // The expectation comes from the TEXT, not from the merge.
      expect(Math.abs(measured - nominal)).toBeLessThanOrEqual(90);
    }
  });

  it('matches total_duration_seconds to the last boundary', async () => {
    const audio = await prisma.lessonAudio.findFirst({
      where: { lessonId },
      include: { segments: { orderBy: { segmentOrder: 'asc' } } },
    });
    const lastEnd = audio!.segments.at(-1)!.endMillisecond;

    expect(audio?.totalDurationSeconds).toBe(Math.round(lastEnd / 1000));
  });
});

describe('the file that reaches object storage', () => {
  let mergedPath: string;
  let lastEnd: number;

  beforeAll(async () => {
    const audio = await prisma.lessonAudio.findFirst({
      where: { lessonId },
      include: { segments: { orderBy: { segmentOrder: 'asc' } } },
    });

    // Read back what a learner would actually be served.
    const bytes = await storage.get(audio!.mergedAudioFileUrl);
    mergedPath = join(directory, 'merged.mp3');
    await writeFile(mergedPath, bytes);
    lastEnd = audio!.segments.at(-1)!.endMillisecond;
  }, 60_000);

  it('is a real, measurable audio file, not an empty object', async () => {
    const probed = await probeDurationMs(mergedPath);
    expect(probed).toBeGreaterThan(0);
  });

  it('runs within one encoder padding of the last stored boundary, not eight', async () => {
    const probed = await probeDurationMs(mergedPath);
    expect(probed - lastEnd).toBeGreaterThanOrEqual(0);
    // Eight accumulated paddings would be ~400 ms; one is under 90.
    expect(probed - lastEnd).toBeLessThanOrEqual(90);
  });

  /**
   * THE DECISIVE CHECK. Everything above could pass on arithmetic the processor
   * agreed with itself about; this one reads the audio a learner would hear,
   * through the offsets a learner's player would use.
   */
  it('puts each segment’s own tone inside its own STORED window', async () => {
    const audio = await prisma.lessonAudio.findFirst({
      where: { lessonId },
      include: { segments: { orderBy: { segmentOrder: 'asc' } } },
    });

    for (const segment of audio!.segments) {
      const expected = fakeFrequency(narrationFor(segment.blockReferenceId));
      const measured = await dominantFrequency(
        mergedPath,
        segment.startMillisecond + 20,
        segment.endMillisecond - 20,
      );

      expect(
        Math.abs(measured - expected),
        `segment ${String(segment.segmentOrder)} (${segment.blockReferenceId}) should carry ${String(expected)} Hz but carried ${measured.toFixed(0)} Hz`,
      ).toBeLessThanOrEqual(expected * 0.1);
    }
  }, 180_000);
});
