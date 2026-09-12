import { describe, expect, it } from 'vitest';
import {
  FAKE_MODEL_NAME,
  FAKE_PROVIDER_NAME,
  FakeImageProvider,
} from '../src/fake-image.provider';
import {
  DEFAULT_OPENAI_IMAGE_MODEL,
  OPENAI_PROVIDER_NAME,
  OpenAiImageProvider,
  decodeImagesResponse,
} from '../src/openai-image.provider';
import { createImageGenerationProvider } from '../src/provider-factory';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const isPng = (bytes: Uint8Array) => PNG_SIGNATURE.every((byte, i) => bytes[i] === byte);

describe('FakeImageProvider', () => {
  const provider = new FakeImageProvider();
  const request = { promptText: '[image/v1] a diagram', candidateCount: 4 };

  it('returns exactly the requested number of candidates', async () => {
    for (const candidateCount of [2, 3, 4]) {
      const images = await provider.generate({ ...request, candidateCount });
      expect(images).toHaveLength(candidateCount);
    }
  });

  it('emits real, decodable PNGs', async () => {
    // The browser suite displays these; placeholder bytes would render broken.
    const [first] = await provider.generate(request);
    expect(isPng(first!.bytes)).toBe(true);
    expect(first!.contentType).toBe('image/png');
    expect(first!.bytes.byteLength).toBeGreaterThan(100);
  });

  it('is byte-identical for the same prompt and index', async () => {
    const a = await provider.generate(request);
    const b = await provider.generate(request);

    for (let index = 0; index < a.length; index += 1) {
      expect(Buffer.from(a[index]!.bytes).equals(Buffer.from(b[index]!.bytes))).toBe(true);
    }
  });

  it('produces a different image for each index of one request', async () => {
    const images = await provider.generate(request);
    const distinct = new Set(images.map((image) => Buffer.from(image.bytes).toString('base64')));
    expect(distinct.size).toBe(images.length);
  });

  it('produces different images for different prompts', async () => {
    const [a] = await provider.generate({ promptText: 'one', candidateCount: 2 });
    const [b] = await provider.generate({ promptText: 'two', candidateCount: 2 });
    expect(Buffer.from(a!.bytes).equals(Buffer.from(b!.bytes))).toBe(false);
  });

  it('names itself, so its rows are never mistaken for real ones', async () => {
    const [image] = await provider.generate(request);
    expect(image!.providerName).toBe(FAKE_PROVIDER_NAME);
    expect(image!.modelName).toBe(FAKE_MODEL_NAME);
  });
});

describe('decodeImagesResponse', () => {
  const b64 = Buffer.from(Uint8Array.from([...PNG_SIGNATURE, 1, 2, 3])).toString('base64');

  it('decodes a recorded response into candidates', () => {
    // The adapter's parsing under test with no network and no key.
    const images = decodeImagesResponse(
      { data: [{ b64_json: b64 }, { b64_json: b64 }] },
      DEFAULT_OPENAI_IMAGE_MODEL,
    );

    expect(images).toHaveLength(2);
    expect(isPng(images[0]!.bytes)).toBe(true);
    expect(images[0]!.modelName).toBe(DEFAULT_OPENAI_IMAGE_MODEL);
    expect(images[0]!.providerName).toBe(OPENAI_PROVIDER_NAME);
  });

  it('refuses an empty or malformed response rather than returning nothing', () => {
    expect(() => decodeImagesResponse({ data: [] }, 'm')).toThrow(/no images/u);
    expect(() => decodeImagesResponse({}, 'm')).toThrow(/no images/u);
    expect(() => decodeImagesResponse({ data: [{}] }, 'm')).toThrow(/b64_json/u);
  });
});

describe('createImageGenerationProvider', () => {
  it('defaults to the fake when IMAGE_PROVIDER is unset or not openai', () => {
    expect(createImageGenerationProvider({})).toBeInstanceOf(FakeImageProvider);
    expect(createImageGenerationProvider({ IMAGE_PROVIDER: 'fake' })).toBeInstanceOf(
      FakeImageProvider,
    );
  });

  it('builds the OpenAI adapter when asked and given a key', () => {
    const provider = createImageGenerationProvider({
      IMAGE_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-test',
    });
    expect(provider).toBeInstanceOf(OpenAiImageProvider);
  });

  it('throws rather than silently downgrading when the key is missing', () => {
    // A silent fallback means production quietly serving fake illustrations.
    expect(() => createImageGenerationProvider({ IMAGE_PROVIDER: 'openai' })).toThrow(
      /OPENAI_API_KEY/u,
    );
  });
});
