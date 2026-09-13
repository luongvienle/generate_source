import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  AUDIO_CONTENT_TYPE,
  type SynthesisRequest,
  type SynthesisResult,
  type TextToSpeechProvider,
} from './text-to-speech.provider';

const run = promisify(execFile);

export const FAKE_TTS_PROVIDER_NAME = 'fake';
export const FAKE_TTS_MODEL_NAME = 'fake-tone-v1';

/**
 * The deterministic fake — and the reason P5's timing assertions can exist.
 *
 * IT EMITS REAL MP3 BYTES, not a stub buffer. `ffprobe` measures them, `ffmpeg`
 * merges them, and the suite knows in advance exactly how long each segment
 * should be and which frequency should be audible inside its stored window. An
 * assertion built on that can tell "the offset points at the right audio" from
 * "the processor agreed with its own arithmetic", which is the only failure mode
 * that matters here and the one a stub buffer cannot detect.
 *
 * IT SHELLS OUT TO FFMPEG. That is a real dependency and it is accepted:
 * ffmpeg is already required by this phase and probed at worker startup, and
 * `packages/ai` is server-only — apps/admin-web depends on `shared`, `content`
 * and `database`, never on `ai` — so `node:child_process` is available and no
 * isomorphism constraint applies. Note that `test/isomorphic.spec.ts` guards
 * `packages/content`, NOT this package; if `packages/ai` ever becomes reachable
 * from a browser bundle, this file is what breaks.
 *
 * REJECTED: hand-assembling constant-bitrate MPEG frames to avoid the
 * dependency. It yields silence, and silence cannot tell you whether a boundary
 * points at the right segment.
 *
 * DETERMINISM, stated precisely: the same text always yields the same duration
 * and the same frequency. The bytes are byte-identical only for a given ffmpeg
 * build, which is why CI installs ffmpeg explicitly rather than inheriting
 * whatever a runner image ships, and why every assertion is on duration and
 * frequency rather than on bytes.
 */
export class FakeTextToSpeechProvider implements TextToSpeechProvider {
  /** Matches OpenAI's, so a lesson that passes preconditions here passes there. */
  readonly maxInputCharacters = 4_096;

  private readonly calls: SynthesisRequest[] = [];

  /** How many times this instance was asked to synthesize. Reuse tests read it. */
  get callCount(): number {
    return this.calls.length;
  }

  get callsMade(): readonly SynthesisRequest[] {
    return this.calls;
  }

  async synthesize(request: SynthesisRequest): Promise<SynthesisResult> {
    if (request.text.length > this.maxInputCharacters) {
      throw new Error(
        `text of ${String(request.text.length)} characters exceeds maxInputCharacters ${String(this.maxInputCharacters)}`,
      );
    }

    this.calls.push(request);

    const durationMs = fakeDurationMs(request.text);
    const frequency = fakeFrequency(request.text);

    /**
     * WRITTEN TO A FILE, NEVER TO A PIPE, and this matters more than it looks.
     *
     * ffmpeg can only write an MP3's Xing/LAME header — the one carrying gapless
     * encoder-delay information — when its output is SEEKABLE, because the
     * header is patched after the last frame is known. Piping to stdout produces
     * a headerless stream whose container duration reads ~40 ms long and whose
     * padding no decoder can strip.
     *
     * No real provider returns such a stream: OpenAI's speech endpoint returns a
     * complete, properly headed file. A fake that piped would therefore have the
     * merge and its tests reasoning about an artifact that cannot occur in
     * production — and would hide the very drift the re-encode exists to avoid.
     */
    const directory = await mkdtemp(join(tmpdir(), 'ke-fake-tts-'));
    const path = join(directory, 'tone.mp3');

    try {
      await run(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          // Never read stdin: a spawn that inherits a pipe would block forever.
          '-nostdin',
          '-y',
          '-f',
          'lavfi',
          '-i',
          `sine=frequency=${String(frequency)}:duration=${(durationMs / 1000).toFixed(3)}:sample_rate=24000`,
          '-ac',
          '1',
          '-b:a',
          '48k',
          path,
        ],
        { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
      );

      return {
        bytes: new Uint8Array(await readFile(path)),
        contentType: AUDIO_CONTENT_TYPE,
        voiceIdentifier: request.voiceIdentifier,
        providerName: FAKE_TTS_PROVIDER_NAME,
        // Identifies the fake's version, so a row it generated is never mistaken
        // for a real one.
        modelName: FAKE_TTS_MODEL_NAME,
        characterCount: request.text.length,
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

/**
 * The duration the fake will produce for this text, in milliseconds.
 *
 * Exported because the tests assert against it: they must know the expected
 * value WITHOUT asking the provider, or they would be comparing the fake to
 * itself. A stable hash of the text keeps runs reproducible while giving
 * different segments visibly different lengths.
 *
 * The range — 300 to 1100 ms in 100 ms steps — is chosen so a merge of eight
 * segments stays fast, and so accumulated MP3 padding in the `-c copy` control
 * exceeds one segment and makes the control fail loudly.
 *
 * Because the fake writes a properly headed file, this is BOTH the nominal tone
 * length and — within a millisecond of rounding — the file's container and
 * decoded length. Measured during P5 on ffmpeg 8.0.1: a file-written 300 ms sine
 * reports 0.300000 s and decodes to exactly 300.0 ms, where the same tone piped
 * to stdout reports 0.339500 s. Tests may therefore predict a boundary's length
 * from the text alone, which is the whole point of exporting this.
 */
export function fakeDurationMs(text: string): number {
  return 300 + (stableHash(text) % 9) * 100;
}

/**
 * The tone frequency for this text, in Hz.
 *
 * Spread widely and kept off harmonics of each other, so a window carrying the
 * wrong segment's tone is unmistakable to the zero-crossing probe rather than
 * plausibly confusable with its neighbour.
 */
export function fakeFrequency(text: string): number {
  const choices = [220, 330, 440, 550, 660, 770, 880, 990, 1100, 1210, 1320, 1430];
  return choices[stableHash(text) % choices.length]!;
}

/** FNV-1a. Small, dependency-free, and stable across processes and platforms. */
function stableHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}
