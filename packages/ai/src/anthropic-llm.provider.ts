import Anthropic from '@anthropic-ai/sdk';
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  type LlmCompletion,
  type LlmCompletionRequest,
  type LlmProvider,
} from './llm.provider';

/**
 * Anthropic Messages API, through the official SDK.
 *
 * DELIBERATELY NOT over `fetch`, which is how openai-image.provider.ts talks to
 * OpenAI. The two adapters therefore differ in style, and that is the considered
 * choice: Anthropic's own API guidance is that TypeScript callers use the SDK
 * because hand-written request shapes drift as the API changes, and this adapter
 * reads model-specific response fields where the image adapter reads one base64
 * string. Recorded in specs/p4-narration/plan.md.
 *
 * THE MODEL IDENTIFIER IS PINNED, not defaulted at the call site. §6.3 chooses a
 * mid-tier model — this is a text transformation, not knowledge generation — and
 * names claude-sonnet-5. Re-verify the identifier and its pricing against
 * current documentation before changing it; ANTHROPIC_MODEL overrides it without
 * a code change when that verification says something else.
 */
export const ANTHROPIC_PROVIDER_NAME = 'anthropic';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5';

export interface AnthropicLlmConfig {
  readonly apiKey: string;
  readonly model?: string;
  /** Overridable so the adapter can be pointed at a local fixture server. */
  readonly baseURL?: string;
}

/** Only the fields this adapter reads. */
interface MessagesResponseShape {
  readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
  readonly stop_reason?: string | null;
}

/**
 * Response body to completion. Pure, so the shape Anthropic returns is under
 * test without a network call or an API key — the recorded-response case.
 *
 * A response may carry several blocks (thinking blocks precede text when
 * adaptive thinking runs, which is Sonnet 5's default). Only `text` blocks are
 * joined; a thinking block is reasoning, not output, and concatenating it would
 * put prose where §6.3 expects JSON.
 */
export function decodeMessagesResponse(body: unknown, modelName: string): LlmCompletion {
  const response = body as MessagesResponseShape | null;

  if (response?.stop_reason === 'refusal') {
    throw new Error('Anthropic declined the request (stop_reason: refusal)');
  }

  const text = (response?.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text ?? '')
    .join('');

  if (text.trim().length === 0) {
    throw new Error('Anthropic returned no text content');
  }

  return {
    text,
    modelName,
    providerName: ANTHROPIC_PROVIDER_NAME,
    inputTokenCount: response?.usage?.input_tokens ?? 0,
    outputTokenCount: response?.usage?.output_tokens ?? 0,
  };
}

export class AnthropicLlmProvider implements LlmProvider {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(config: AnthropicLlmConfig) {
    this.model = config.model ?? DEFAULT_ANTHROPIC_MODEL;
    this.client = new Anthropic({
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      // ZERO IS LOAD-BEARING. The SDK retries twice by default, NFR-03 gives the
      // job three attempts, and §6.3 gives each chunk three tries — leaving the
      // default on would multiply those into as many as 18 paid calls for one
      // chunk, none of them recorded in generation_jobs.attempt_count.
      maxRetries: 0,
    });
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletion> {
    // `thinking` is deliberately not set: it is adaptive by default on this
    // model, and §6.3's hardest constraint is returning exactly one segment per
    // block in order, which is precisely what reasoning before answering helps.
    // If this ever needs tuning, output_config.effort is the knob.
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      messages: [{ role: 'user', content: request.promptText }],
    });

    return decodeMessagesResponse(response, this.model);
  }
}
