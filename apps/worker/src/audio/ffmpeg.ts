import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The only place in apps/worker that spawns a process.
 *
 * §11 names "ffmpeg in the worker image" as infrastructure and assigns it to no
 * package, and apps/worker is its only consumer, so it lives here rather than in
 * packages/*. §14 decision #4 — whether a marks-based provider would remove this
 * dependency — is closed in favour of §6.4's per-segment approach by
 * specs/p5-audio/spec.md.
 *
 * WHY THE MERGE RE-ENCODES INSTEAD OF STREAM-COPYING.
 *
 * Every MP3 file carries encoder delay at its head and padding at its tail. A
 * properly headed file declares that in its Xing/LAME tag, so its container
 * duration and its decoded length both read as the true audio length — but
 * `ffmpeg -c copy` over a concat list keeps every file's padding frames as real
 * audio while that gapless information survives only for the first file. The
 * error is therefore cumulative.
 *
 * MEASURED during P5 on ffmpeg 8.0.1, eight fake segments totalling 5300 ms:
 *   - decode → concat PCM → encode once: stored 5300 ms, file probes 5.300 s;
 *   - `-c copy` concat with cumulative container durations: stored 5300 ms,
 *     file probes 5.704 s — 404 ms adrift, about 50 ms per boundary.
 * By the fifth segment the stored offset points at the wrong audio, which is
 * exactly the defect P7's highlight sync would inherit and could not detect.
 *
 * Decoding each segment to PCM, concatenating the PCM and encoding ONCE makes
 * the boundaries exact by construction: sample counts are integers and
 * concatenating raw samples adds nothing. test/ffmpeg.spec.ts asserts it by
 * cutting each stored window out of the finished file and recovering which tone
 * is audible there, and holds a `-c copy` control that must fail the same check.
 *
 * A NOTE FOR ANYONE CHANGING THE FAKE: this all depends on segments arriving as
 * properly headed MP3 files. ffmpeg writes the Xing header only when its output
 * is seekable, so a fake that piped to stdout would produce headerless audio
 * that behaves differently from anything a real provider returns — and would
 * make the control above pass, silently retiring the assertion. See
 * packages/ai/src/fake-tts.provider.ts.
 */

/** One channel, one rate, for the whole pipeline, so sample counts are comparable. */
export const AUDIO_SAMPLE_RATE = 24_000;
export const AUDIO_CHANNELS = 1;
/** s16le: two bytes per sample, so a byte count converts to a sample count exactly. */
const BYTES_PER_SAMPLE = 2;
const AUDIO_BITRATE = '48k';

/** Where a segment sits inside the merged file. Milliseconds, 0-based, contiguous. */
export interface SegmentBoundary {
  readonly startMillisecond: number;
  readonly endMillisecond: number;
}

export interface MergeResult {
  readonly bytes: Uint8Array;
  readonly boundaries: readonly SegmentBoundary[];
  /** Derived from the last boundary, not from probing the output. */
  readonly totalDurationMs: number;
}

const samplesToMs = (samples: number): number =>
  Math.round((samples / AUDIO_SAMPLE_RATE) * 1000);

/**
 * Refuses to start without both binaries, naming the one that is missing.
 *
 * Called from apps/worker/src/main.ts before the workers come up. A missing
 * binary then fails loudly at boot rather than as an opaque ENOENT inside
 * attempt 3 of a job that has already paid a provider for every segment before
 * the merge. The cost is accepted deliberately: a worker without ffmpeg will not
 * process image, import or narration jobs either, but a deployment missing a
 * dependency §11 names is broken, and saying so at boot is the honest report.
 */
export async function assertFfmpegAvailable(): Promise<void> {
  for (const binary of ['ffmpeg', 'ffprobe'] as const) {
    try {
      await run(binary, ['-version'], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${binary} is required by apps/worker (§11) and could not be run: ${reason}. ` +
          `Install ffmpeg — it provides both ffmpeg and ffprobe — and ensure it is on PATH.`,
      );
    }
  }
}

/** The container's reported duration, in milliseconds. Includes encoder padding. */
export async function probeDurationMs(path: string): Promise<number> {
  const { stdout } = await run(
    'ffprobe',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      path,
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );

  const seconds = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(seconds)) {
    throw new Error(`ffprobe reported no usable duration for ${path}: ${stdout.trim()}`);
  }
  return Math.round(seconds * 1000);
}

/** Decodes one encoded file to raw mono s16le at AUDIO_SAMPLE_RATE. */
async function decodeToPcm(path: string): Promise<Buffer> {
  const { stdout } = await run(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      // Never read stdin: an inherited pipe would block the worker forever.
      '-nostdin',
      '-i',
      path,
      '-f',
      's16le',
      '-ac',
      String(AUDIO_CHANNELS),
      '-ar',
      String(AUDIO_SAMPLE_RATE),
      'pipe:1',
    ],
    { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 },
  );
  return stdout;
}

/**
 * Merges segment audio into one file and reports where each segment landed.
 *
 * `segments` are the encoded bytes in playback order. The result's boundaries
 * are contiguous by construction: the first starts at 0 and each end is the next
 * start, because they are cumulative sums over exact decoded sample counts.
 *
 * Everything is held in memory, bounded by AUDIO_RUN_MAX_SEGMENTS — 200 segments
 * of ten seconds decodes to under 100 MB of PCM, which is the point of capping
 * the run rather than streaming.
 */
export async function mergeSegments(segments: readonly Uint8Array[]): Promise<MergeResult> {
  if (segments.length === 0) {
    throw new Error('mergeSegments was given no segments; a run with no audio should not reach it');
  }

  const directory = await mkdtemp(join(tmpdir(), 'ke-audio-'));

  try {
    const pcmChunks: Buffer[] = [];
    const boundaries: SegmentBoundary[] = [];
    let cumulativeSamples = 0;

    for (const [index, segment] of segments.entries()) {
      const encodedPath = join(directory, `segment-${String(index)}.mp3`);
      await writeFile(encodedPath, segment);

      const pcm = await decodeToPcm(encodedPath);
      if (pcm.byteLength === 0) {
        throw new Error(`segment ${String(index)} decoded to no audio`);
      }

      const startSamples = cumulativeSamples;
      cumulativeSamples += pcm.byteLength / BYTES_PER_SAMPLE;

      pcmChunks.push(pcm);
      boundaries.push({
        startMillisecond: samplesToMs(startSamples),
        endMillisecond: samplesToMs(cumulativeSamples),
      });
    }

    // One encode over the concatenated PCM. The resulting file carries a single
    // encoder delay for the whole stream rather than one per segment.
    const rawPath = join(directory, 'merged.raw');
    const mergedPath = join(directory, 'merged.mp3');
    await writeFile(rawPath, Buffer.concat(pcmChunks));

    await run(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-y',
        '-f',
        's16le',
        '-ac',
        String(AUDIO_CHANNELS),
        '-ar',
        String(AUDIO_SAMPLE_RATE),
        '-i',
        rawPath,
        '-b:a',
        AUDIO_BITRATE,
        '-f',
        'mp3',
        mergedPath,
      ],
      { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 },
    );

    return {
      bytes: new Uint8Array(await readFile(mergedPath)),
      boundaries,
      totalDurationMs: boundaries.at(-1)!.endMillisecond,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * The drift the merge exists to prevent, built on purpose so a test can prove
 * the assertions have teeth.
 *
 * TEST SUPPORT ONLY — nothing in the production path calls this. It concatenates
 * with `-c copy`, preserving each file's encoder delay and padding as real
 * audio, and reports the boundaries a naive implementation would store: the
 * cumulative sum of each file's own container duration.
 */
export async function mergeSegmentsByStreamCopyForTesting(
  segments: readonly Uint8Array[],
): Promise<MergeResult> {
  const directory = await mkdtemp(join(tmpdir(), 'ke-audio-drift-'));

  try {
    const paths: string[] = [];
    const boundaries: SegmentBoundary[] = [];
    let cumulativeMs = 0;

    for (const [index, segment] of segments.entries()) {
      const path = join(directory, `segment-${String(index)}.mp3`);
      await writeFile(path, segment);
      paths.push(path);

      const start = cumulativeMs;
      cumulativeMs += await probeDurationMs(path);
      boundaries.push({ startMillisecond: start, endMillisecond: cumulativeMs });
    }

    const listPath = join(directory, 'list.txt');
    await writeFile(listPath, paths.map((path) => `file '${path}'`).join('\n'));

    const mergedPath = join(directory, 'merged.mp3');
    await run(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listPath,
        '-c',
        'copy',
        mergedPath,
      ],
      { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 },
    );

    return {
      bytes: new Uint8Array(await readFile(mergedPath)),
      boundaries,
      totalDurationMs: cumulativeMs,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
