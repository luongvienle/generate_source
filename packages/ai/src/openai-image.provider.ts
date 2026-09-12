import type {
  GeneratedImage,
  ImageGenerationProvider,
  ImageGenerationRequest,
} from './image-generation.provider';

/**
 * OpenAI image generation.
 *
 * Over `fetch` rather than the `openai` SDK: the only thing needed is one POST
 * and a base64 decode, and NFR-03 already owns retry and backoff at the job
 * level, which is where a retry must be recorded anyway. Keeping the dependency
 * out matches how apps/api avoided pulling in `express` and `multer`.
 *
 * THE MODEL IDENTIFIER IS PINNED, not defaulted at the call site, and must be
 * re-verified against current OpenAI documentation — the same discipline §6.3
 * applies to the narration model. `OPENAI_IMAGE_MODEL` overrides it without a
 * code change when that verification says something else.
 */
export const OPENAI_PROVIDER_NAME = 'openai';
export const DEFAULT_OPENAI_IMAGE_MODEL = 'gpt-image-1';
const IMAGES_ENDPOINT = 'https://api.openai.com/v1/images/generations';

export interface OpenAiImageConfig {
  readonly apiKey: string;
  readonly model?: string;
  /** Overridable so the parsing can be exercised against a local fixture server. */
  readonly endpoint?: string;
}

/** Only the fields this adapter reads. */
interface ImagesResponse {
  readonly data?: ReadonlyArray<{ readonly b64_json?: string }>;
}

/**
 * Response body to candidates. Pure, so the shape OpenAI returns is under test
 * without a network call or an API key — the recorded-response case.
 */
export function decodeImagesResponse(body: unknown, modelName: string): readonly GeneratedImage[] {
  const images = (body as ImagesResponse | null)?.data;
  if (!Array.isArray(images) || images.length === 0) {
    throw new Error('OpenAI returned no images');
  }

  return images.map((image, index) => {
    if (!image?.b64_json) {
      throw new Error(`OpenAI image ${index} carried no b64_json payload`);
    }
    return {
      bytes: Uint8Array.from(Buffer.from(image.b64_json, 'base64')),
      // The images endpoint returns PNG.
      contentType: 'image/png',
      modelName,
      providerName: OPENAI_PROVIDER_NAME,
    };
  });
}

export class OpenAiImageProvider implements ImageGenerationProvider {
  private readonly model: string;
  private readonly endpoint: string;

  constructor(private readonly config: OpenAiImageConfig) {
    this.model = config.model ?? DEFAULT_OPENAI_IMAGE_MODEL;
    this.endpoint = config.endpoint ?? IMAGES_ENDPOINT;
  }

  async generate(request: ImageGenerationRequest): Promise<readonly GeneratedImage[]> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        prompt: request.promptText,
        // FR-IMG-01's 2–4 maps onto the endpoint's own n, so one call produces
        // the whole candidate set and the admin is billed once for it.
        n: request.candidateCount,
      }),
    });

    if (!response.ok) {
      // The body carries the provider's reason; it lands in generation_jobs
      // .error_message and is what the drawer shows the admin.
      throw new Error(`OpenAI image generation failed (${response.status}): ${await response.text()}`);
    }

    return decodeImagesResponse(await response.json(), this.model);
  }
}
