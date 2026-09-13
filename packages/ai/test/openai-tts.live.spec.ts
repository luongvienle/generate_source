import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { config as loadEnv } from 'dotenv';
import {
  AUDIO_CONTENT_TYPE,
  DEFAULT_OPENAI_TTS_MODEL,
  DEFAULT_OPENAI_VOICE,
  OPENAI_TTS_PROVIDER_NAME,
  OpenAiTextToSpeechProvider,
} from '../src/index';

loadEnv({ path: ['../../.env', '.env'] });

const run = promisify(execFile);
const apiKey = process.env['OPENAI_API_KEY'];

/**
 * THIS TEST COSTS MONEY. It is skipped unless OPENAI_API_KEY is set, and is the
 * third such test in the repository — `openai-image.live.spec.ts` (P3) and
 * `anthropic-narration.live.spec.ts` (P4) are the others.
 *
 * Run it BY HAND when the pinned model or the default voice changes.
 *
 * It is the only evidence that the identifier pinned in openai-tts.provider.ts
 * still exists, that the voice is accepted, and that the endpoint speaks the
 * `vi` a default install narrates in. The fake cannot tell you any of that: it
 * emits a sine tone, which is exactly what a silent downgrade would also sound
 * like — hence `TTS_PROVIDER=openai` with no key throwing rather than falling
 * back.
 *
 * Deliberately ONE short sentence. The endpoint bills per character, and what is
 * under test is that the call is well-formed and the pinned identifiers are
 * live, not the quality of the speech — which no assertion can judge anyway.
 */
describe.skipIf(!apiKey)('OpenAI speech, live', () => {
  it('synthesizes a Vietnamese sentence with the pinned model and voice', async () => {
    const provider = new OpenAiTextToSpeechProvider({ apiKey: apiKey! });
    const text = 'Xin chào, đây là một câu ngắn.';

    const result = await provider.synthesize({
      text,
      voiceIdentifier: DEFAULT_OPENAI_VOICE,
      languageCode: 'vi',
    });

    expect(result.providerName).toBe(OPENAI_TTS_PROVIDER_NAME);
    expect(result.modelName).toBe(DEFAULT_OPENAI_TTS_MODEL);
    expect(result.voiceIdentifier).toBe(DEFAULT_OPENAI_VOICE);
    expect(result.contentType).toBe(AUDIO_CONTENT_TYPE);
    expect(result.characterCount).toBe(text.length);
    expect(result.bytes.byteLength).toBeGreaterThan(0);

    // The bytes must be audio the merge could actually decode, not an error
    // page with a 200. ffprobe is the same tool apps/worker measures with.
    const directory = await mkdtemp(join(tmpdir(), 'ke-tts-live-'));
    try {
      const file = join(directory, 'live.mp3');
      await writeFile(file, result.bytes);

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
          file,
        ],
        { encoding: 'utf8' },
      );

      const seconds = Number.parseFloat(stdout.trim());
      expect(Number.isFinite(seconds)).toBe(true);
      expect(seconds).toBeGreaterThan(0.3);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('refuses a voice the documentation does not list, rather than billing for it', async () => {
    const provider = new OpenAiTextToSpeechProvider({ apiKey: apiKey! });

    await expect(
      provider.synthesize({
        text: 'Một câu.',
        voiceIdentifier: 'not-a-real-voice',
        languageCode: 'vi',
      }),
    ).rejects.toThrow(/OpenAI speech synthesis failed/u);
  }, 60_000);
});
