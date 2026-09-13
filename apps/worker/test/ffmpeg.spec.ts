import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FakeTextToSpeechProvider,
  fakeDurationMs,
  fakeFrequency,
} from '@knowledge-explorer/ai';
import {
  AUDIO_SAMPLE_RATE,
  assertFfmpegAvailable,
  mergeSegments,
  mergeSegmentsByStreamCopyForTesting,
  probeDurationMs,
  type MergeResult,
} from '../src/audio/ffmpeg';

const run = promisify(execFile);

/**
 * The assertion P5 exists for.
 *
 * `audio_segments.start_millisecond` is the one output nothing downstream can
 * check — P7's highlight sync consumes it and has no way to tell a correct
 * offset from a plausible one. So this suite does not ask the merge whether it
 * agrees with itself. It cuts each stored window out of the finished file,
 * decodes it, and recovers which TONE is audible there. A boundary that points
 * at the wrong audio fails, however tidy its arithmetic.
 *
 * The `-c copy` control at the end must FAIL those same assertions. If it ever
 * passes, the assertions are wrong, not the merge.
 */

/** Eight distinct texts, so durations and tones differ segment to segment. */
const TEXTS = [
  'Đoạn một.',
  'Đoạn hai nói về sơ đồ.',
  'Hình 1 cho thấy ba phần.',
  'Đoạn bốn.',
  'Bảng 2 liệt kê các giá trị.',
  'Đoạn sáu ngắn.',
  'Đoạn bảy dài hơn một chút.',
  'Đoạn tám kết thúc bài học.',
];

/** How far the finished file may run past the last stored boundary. */
const ONE_ENCODER_PADDING_MS = 90;

let segments: Uint8Array[];
let directory: string;

/**
 * The dominant frequency inside a window of a file, by counting zero crossings.
 *
 * No dependency and no FFT: for a pure sine, crossings = 2 · f · seconds. MP3
 * compression puts noise around zero, so crossings are counted with hysteresis —
 * the signal must pass a threshold either side before a crossing counts — which
 * keeps ringing near silence from inflating the count.
 *
 * `-ss`/`-t` are placed AFTER `-i` deliberately: that is accurate output seeking
 * (decode and discard), where input seeking would snap to a frame boundary and
 * blur exactly the edges this is meant to resolve.
 */
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

/** Writes a merged result to disk so ffmpeg can seek inside it. */
async function writeMerged(name: string, result: MergeResult): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, result.bytes);
  return path;
}

beforeAll(async () => {
  await assertFfmpegAvailable();
  directory = await mkdtemp(join(tmpdir(), 'ke-ffmpeg-spec-'));

  const provider = new FakeTextToSpeechProvider();
  segments = [];
  for (const text of TEXTS) {
    const result = await provider.synthesize({ text, voiceIdentifier: 'alloy', languageCode: 'vi' });
    segments.push(result.bytes);
  }
}, 120_000);

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('assertFfmpegAvailable', () => {
  it('passes when both binaries are present', async () => {
    await expect(assertFfmpegAvailable()).resolves.toBeUndefined();
  });
});

describe('mergeSegments', () => {
  let merged: MergeResult;
  let mergedPath: string;

  beforeAll(async () => {
    merged = await mergeSegments(segments);
    mergedPath = await writeMerged('merged.mp3', merged);
  }, 120_000);

  it('returns one boundary per segment', () => {
    expect(merged.boundaries).toHaveLength(TEXTS.length);
  });

  it('starts at zero and is contiguous with no gaps or overlaps', () => {
    expect(merged.boundaries[0]!.startMillisecond).toBe(0);

    for (let index = 0; index + 1 < merged.boundaries.length; index += 1) {
      // Exact equality, not a tolerance: these are cumulative sums over integer
      // sample counts, so anything else is a bug rather than a rounding artifact.
      expect(merged.boundaries[index]!.endMillisecond).toBe(
        merged.boundaries[index + 1]!.startMillisecond,
      );
    }

    for (const boundary of merged.boundaries) {
      expect(boundary.endMillisecond).toBeGreaterThan(boundary.startMillisecond);
    }
  });

  it('gives each segment the length the fake was asked to produce, plus its padding', () => {
    for (const [index, text] of TEXTS.entries()) {
      const boundary = merged.boundaries[index]!;
      const measured = boundary.endMillisecond - boundary.startMillisecond;
      const nominal = fakeDurationMs(text);

      // The expectation comes from the text, not from the merge.
      expect(measured).toBeGreaterThanOrEqual(nominal);
      expect(measured - nominal).toBeLessThanOrEqual(ONE_ENCODER_PADDING_MS);
    }
  });

  it('reports a total that matches its own last boundary', () => {
    expect(merged.totalDurationMs).toBe(merged.boundaries.at(-1)!.endMillisecond);
  });

  it('ends within ONE encoder padding of the finished file, not eight', async () => {
    const probed = await probeDurationMs(mergedPath);
    expect(probed - merged.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(probed - merged.totalDurationMs).toBeLessThanOrEqual(ONE_ENCODER_PADDING_MS);
  });

  /**
   * The invariant that actually separates re-encoding from stream-copying: the
   * error is a CONSTANT, not a per-segment sum. A two-segment merge and an
   * eight-segment merge must overshoot by about the same amount.
   */
  it('does not accumulate error as segments are added', async () => {
    const small = await mergeSegments(segments.slice(0, 2));
    const smallPath = await writeMerged('merged-small.mp3', small);

    const smallDrift = (await probeDurationMs(smallPath)) - small.totalDurationMs;
    const largeDrift = (await probeDurationMs(mergedPath)) - merged.totalDurationMs;

    expect(Math.abs(largeDrift - smallDrift)).toBeLessThanOrEqual(20);
  }, 60_000);

  /**
   * THE DECISIVE CHECK. Everything above could pass on arithmetic the merge
   * agreed with itself about; this one reads the audio.
   */
  it('puts each segment’s own tone inside its own stored window', async () => {
    for (const [index, text] of TEXTS.entries()) {
      const boundary = merged.boundaries[index]!;
      const expected = fakeFrequency(text);

      // Inset so the measurement never straddles a boundary.
      const measured = await dominantFrequency(
        mergedPath,
        boundary.startMillisecond + 20,
        boundary.endMillisecond - 20,
      );

      expect(
        Math.abs(measured - expected),
        `segment ${String(index)} window should carry ${String(expected)} Hz but carried ${measured.toFixed(0)} Hz`,
      ).toBeLessThanOrEqual(expected * 0.1);
    }
  }, 120_000);
});

/**
 * The control. `-c copy` keeps every file's encoder delay and padding as real
 * audio, and stores the boundaries a naive implementation would: cumulative
 * container durations. It must fail — if it passes, the suite above proves
 * nothing.
 */
describe('the stream-copy control', () => {
  let drifted: MergeResult;
  let driftedPath: string;

  beforeAll(async () => {
    drifted = await mergeSegmentsByStreamCopyForTesting(segments);
    driftedPath = await writeMerged('drifted.mp3', drifted);
  }, 120_000);

  it('drifts far past one encoder padding, unlike the real merge', async () => {
    const probed = await probeDurationMs(driftedPath);
    const drift = Math.abs(probed - drifted.totalDurationMs);

    // Eight segments of accumulated padding, not one.
    expect(drift).toBeGreaterThan(ONE_ENCODER_PADDING_MS);
  });

  it('puts the WRONG tone in at least one late window', async () => {
    const wrong: number[] = [];

    for (const [index, text] of TEXTS.entries()) {
      const boundary = drifted.boundaries[index]!;
      const expected = fakeFrequency(text);
      const measured = await dominantFrequency(
        driftedPath,
        boundary.startMillisecond + 20,
        boundary.endMillisecond - 20,
      );
      if (Math.abs(measured - expected) > expected * 0.1) wrong.push(index);
    }

    // If this ever comes back empty, the frequency check has no teeth and the
    // passing assertions above are worthless.
    expect(
      wrong.length,
      'stream-copy concat should misplace at least one segment; if it does not, the frequency assertion is not actually testing anything',
    ).toBeGreaterThan(0);
  }, 120_000);
});
