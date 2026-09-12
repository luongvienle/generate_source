import { config as loadEnv } from 'dotenv';
import { describe, expect, it } from 'vitest';
import { DEFAULT_OPENAI_IMAGE_MODEL, OpenAiImageProvider } from '../src/openai-image.provider';

loadEnv({ path: ['../../.env', '.env'] });

const apiKey = process.env['OPENAI_API_KEY'];

/**
 * The only test that spends money, and the only one that talks to OpenAI.
 *
 * Skipped unless OPENAI_API_KEY is set, so CI never runs it and a contributor
 * without a key is never blocked. Run it by hand before shipping and whenever
 * the pinned model changes — it is what catches a vendor response-shape change
 * that every mocked test would sail past.
 *
 *   OPENAI_API_KEY=sk-... pnpm --filter @knowledge-explorer/ai test
 *
 * candidateCount is 2, the FR-IMG-01 minimum: enough to prove `n` is honoured,
 * as cheap as the contract allows.
 */
describe.skipIf(!apiKey)('OpenAiImageProvider against the real API', () => {
  it('returns decodable images of the pinned model', { timeout: 180_000 }, async () => {
    const provider = new OpenAiImageProvider({
      apiKey: apiKey as string,
      ...(process.env['OPENAI_IMAGE_MODEL']
        ? { model: process.env['OPENAI_IMAGE_MODEL'] as string }
        : {}),
    });

    const images = await provider.generate({
      promptText:
        '[live-test] A simple flat vector illustration of three stacked books. ' +
        'Render no text, letters or numerals inside the image.',
      candidateCount: 2,
    });

    expect(images).toHaveLength(2);
    for (const image of images) {
      expect(image.bytes.byteLength).toBeGreaterThan(1000);
      expect(image.contentType).toBe('image/png');
      expect(image.modelName).toBe(
        process.env['OPENAI_IMAGE_MODEL'] ?? DEFAULT_OPENAI_IMAGE_MODEL,
      );
    }
  });
});
