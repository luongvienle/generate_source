/**
 * Text completion behind an interface (§11's `LlmProvider`).
 *
 * The provider turns a prompt into text and reports what it cost. It knows
 * nothing about blocks, segments, checksums or chunking — those belong to
 * narration-run.ts and to the worker that calls it, which is what lets the fake
 * be a pure function and the real one be swapped without any caller changing.
 */
export interface LlmCompletionRequest {
  /**
   * The FULLY COMPOSED prompt. Composition is narration-prompt.ts's job, so a
   * provider cannot silently apply instructions of its own and NFR-08's recorded
   * template version is genuinely what produced the text.
   */
  readonly promptText: string;
  /** Ceiling on the response. Defaults per adapter; never unbounded. */
  readonly maxOutputTokens?: number;
}

export interface LlmCompletion {
  readonly text: string;
  readonly modelName: string;
  readonly providerName: string;
  /**
   * §8 gives `narration_scripts` an input_token_count and an output_token_count
   * and nothing else can supply them. Summed across a run's chunks.
   */
  readonly inputTokenCount: number;
  readonly outputTokenCount: number;
}

export interface LlmProvider {
  complete(request: LlmCompletionRequest): Promise<LlmCompletion>;
}

/** Injection token. A Symbol cannot collide with another provider's token. */
export const LLM_PROVIDER = Symbol('LlmProvider');

/**
 * Enough room for a 25-block chunk plus adaptive thinking, and small enough to
 * stay well inside the SDK's non-streaming HTTP timeout.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;
