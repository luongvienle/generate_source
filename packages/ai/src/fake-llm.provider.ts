import { createHash } from 'node:crypto';
import {
  type LlmCompletion,
  type LlmCompletionRequest,
  type LlmProvider,
} from './llm.provider';
import { readPromptManifest } from './narration-prompt';

/**
 * The default provider: well-formed narration, no network, no cost, byte-stable.
 *
 * CI runs against this, which is what makes the narration suites deterministic
 * and lets a contributor with no API key run everything. It reads the block
 * manifest back out of the composed prompt and emits one segment per block, so
 * it exercises the REAL decoder and the real retry ladder rather than
 * short-circuiting them.
 *
 * Determinism is the contract: the same prompt always produces the same text.
 */
export const FAKE_LLM_PROVIDER_NAME = 'fake';
export const FAKE_LLM_MODEL_NAME = 'fake-narrator-v1';

/**
 * The four ways §6.3 says a response can be rejected. A test picks one to force,
 * so the ladder is exercised without waiting for a real model to misbehave.
 */
export type FakeLlmFault = 'short-count' | 'unknown-block-id' | 'transposed' | 'unparseable';

export interface FakeLlmOptions {
  readonly fault?: FakeLlmFault;
  /**
   * Apply the fault to only the first N calls, then succeed. This is what makes
   * "fails twice, then succeeds in 5 calls" an assertion rather than a guess.
   */
  readonly faultCallCount?: number;
  /** Throws instead of answering — a transport failure, which must escape to BullMQ. */
  readonly throwEveryCall?: Error;
}

const sentence = (seed: string): string => {
  const digest = createHash('sha256').update(seed).digest('hex');
  return `Narration for ${seed}, generated deterministically as ${digest.slice(0, 8)}.`;
};

export class FakeLlmProvider implements LlmProvider {
  /** Readable by tests: the ladder is asserted by counting calls. */
  callCount = 0;

  constructor(private readonly options: FakeLlmOptions = {}) {}

  async complete(request: LlmCompletionRequest): Promise<LlmCompletion> {
    this.callCount += 1;

    if (this.options.throwEveryCall) throw this.options.throwEveryCall;

    const manifest = readPromptManifest(request.promptText);
    const blockIds = manifest.map((entry) => entry.blockId);

    const faultBudget = this.options.faultCallCount ?? Number.POSITIVE_INFINITY;
    const fault = this.callCount <= faultBudget ? this.options.fault : undefined;

    return {
      text: this.render(blockIds, fault),
      modelName: FAKE_LLM_MODEL_NAME,
      providerName: FAKE_LLM_PROVIDER_NAME,
      // Deterministic and roughly proportional, so token-sum assertions are real.
      inputTokenCount: request.promptText.length,
      outputTokenCount: blockIds.length * 20,
    };
  }

  private render(blockIds: readonly string[], fault: FakeLlmFault | undefined): string {
    if (fault === 'unparseable') return 'Certainly! Here is the narration you asked for.';

    let ids = [...blockIds];
    if (fault === 'short-count') ids = ids.slice(0, Math.max(0, ids.length - 1));
    if (fault === 'unknown-block-id' && ids.length > 0) ids[ids.length - 1] = 'not-a-real-block';
    if (fault === 'transposed' && ids.length >= 2) {
      [ids[0], ids[1]] = [ids[1] as string, ids[0] as string];
    }

    return JSON.stringify({
      segments: ids.map((blockId) => ({ blockId, narrationText: sentence(blockId) })),
      totalEstimatedSeconds: ids.length * 6,
    });
  }
}
