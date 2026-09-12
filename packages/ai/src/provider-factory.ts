import { AnthropicLlmProvider } from './anthropic-llm.provider';
import { FakeImageProvider } from './fake-image.provider';
import { FakeLlmProvider } from './fake-llm.provider';
import type { ImageGenerationProvider } from './image-generation.provider';
import type { LlmProvider } from './llm.provider';
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

/**
 * §11's LlmProvider, selected the same way and for the same reason.
 *
 * `anthropic` with no key THROWS rather than falling back. P4's failure mode is
 * quieter than P3's — a deployment serving fake narration reads as plausible
 * prose, and nobody notices until a learner hears a lesson that says nothing.
 */
export function createLlmProvider(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  if (env['LLM_PROVIDER'] !== 'anthropic') return new FakeLlmProvider();

  const apiKey = env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    throw new Error('LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set');
  }

  const model = env['ANTHROPIC_MODEL'];
  return new AnthropicLlmProvider({ apiKey, ...(model ? { model } : {}) });
}
