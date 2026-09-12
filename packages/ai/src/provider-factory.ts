import { FakeImageProvider } from './fake-image.provider';
import type { ImageGenerationProvider } from './image-generation.provider';
import { OpenAiImageProvider } from './openai-image.provider';

/**
 * Provider selection, by environment.
 *
 * Anything but `openai` — including unset — is the deterministic fake, so CI and
 * a fresh clone both work with no key and no network.
 *
 * `openai` with no key THROWS rather than falling back. A silent downgrade would
 * mean a production deployment quietly serving fake illustrations, which is the
 * kind of failure nobody notices until a learner does.
 */
export function createImageGenerationProvider(
  env: NodeJS.ProcessEnv = process.env,
): ImageGenerationProvider {
  if (env['IMAGE_PROVIDER'] !== 'openai') return new FakeImageProvider();

  const apiKey = env['OPENAI_API_KEY'];
  if (!apiKey) {
    throw new Error('IMAGE_PROVIDER=openai but OPENAI_API_KEY is not set');
  }

  const model = env['OPENAI_IMAGE_MODEL'];
  return new OpenAiImageProvider({ apiKey, ...(model ? { model } : {}) });
}
