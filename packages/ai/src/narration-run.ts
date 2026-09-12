import type { LlmProvider } from './llm.provider';
import {
  composeNarrationPrompt,
  decodeNarrationResponse,
  describeViolation,
  type NarrationInputBlock,
  type NarrationViolation,
} from './narration-prompt';

/**
 * §6.3's generation contract: chunk, call, validate, retry, stitch.
 *
 * PURE BY DESIGN. It takes a provider and returns segments; it touches no
 * Prisma, no job, no logger and no clock. That is what makes the retry ladder
 * assertable by counting calls in a unit test, where "the fourth call never
 * happens" is an assertion rather than an inference from a timeout.
 *
 * A transport error from the provider PROPAGATES rather than being retried here:
 * NFR-03's three BullMQ attempts with exponential backoff are the right response
 * to a timeout, and the wrong response to a model that returned 24 segments
 * where 25 were asked for. Waiting a second does not change the second answer.
 */
export interface NarrationRunConstants {
  readonly chunkBlockCount: number;
  readonly chunkMaxTries: number;
  readonly runMaxCalls: number;
}

export interface NarrationRunInput {
  readonly blocks: readonly NarrationInputBlock[];
  readonly lessonTitle: string;
  readonly learningObjective: string | null;
  readonly languageCode: string;
  readonly provider: LlmProvider;
  readonly constants: NarrationRunConstants;
  /** Called once per VALIDATED chunk, so retries never move a progress bar. */
  readonly onChunkDone?: (done: number, total: number) => void | Promise<void>;
}

export type NarrationRunFailure =
  | {
      readonly reason: 'chunk-rejected';
      readonly chunkIndex: number;
      readonly tries: number;
      readonly violation: NarrationViolation;
    }
  | { readonly reason: 'call-ceiling'; readonly calls: number }
  | { readonly reason: 'stitch-mismatch'; readonly detail: string };

export type NarrationRunResult =
  | {
      readonly ok: true;
      readonly segments: ReadonlyMap<string, string>;
      readonly totalEstimatedSeconds: number | null;
      readonly inputTokenCount: number;
      readonly outputTokenCount: number;
      readonly modelName: string;
      readonly providerName: string;
      readonly chunkCount: number;
      readonly callCount: number;
    }
  | { readonly ok: false; readonly failure: NarrationRunFailure };

/** Fixed-size chunks, no overlap — see specs/p4-narration/spec.md for the tradeoff. */
export function chunkBlocks<T>(blocks: readonly T[], size: number): readonly (readonly T[])[] {
  if (size < 1) throw new Error('chunk size must be at least 1');
  const chunks: T[][] = [];
  for (let index = 0; index < blocks.length; index += size) {
    chunks.push(blocks.slice(index, index + size));
  }
  return chunks;
}

/** How many calls a run could make at worst, before any are spent. */
export const worstCaseCallCount = (blockCount: number, constants: NarrationRunConstants): number =>
  Math.ceil(blockCount / constants.chunkBlockCount) * constants.chunkMaxTries;

export async function runNarration(input: NarrationRunInput): Promise<NarrationRunResult> {
  const chunks = chunkBlocks(input.blocks, input.constants.chunkBlockCount);

  const segments = new Map<string, string>();
  let estimatedSeconds: number | null = null;
  let inputTokenCount = 0;
  let outputTokenCount = 0;
  let modelName = '';
  let providerName = '';
  let callCount = 0;

  for (const [chunkIndex, chunk] of chunks.entries()) {
    const blockIds = chunk.map((block) => block.blockId);
    const basePrompt = composeNarrationPrompt({
      blocks: chunk,
      lessonTitle: input.lessonTitle,
      learningObjective: input.learningObjective,
      languageCode: input.languageCode,
    });

    let violation: NarrationViolation | undefined;
    let accepted = false;

    for (let attempt = 0; attempt < input.constants.chunkMaxTries; attempt += 1) {
      if (callCount >= input.constants.runMaxCalls) {
        return { ok: false, failure: { reason: 'call-ceiling', calls: callCount } };
      }

      // The retry restates the violated constraint. Sending the same prompt again
      // is not a retry, it is the same request.
      const promptText = violation
        ? `${basePrompt}\n\nYour previous reply was rejected. ${describeViolation(violation)}`
        : basePrompt;

      const completion = await input.provider.complete({ promptText });
      callCount += 1;
      inputTokenCount += completion.inputTokenCount;
      outputTokenCount += completion.outputTokenCount;
      modelName = completion.modelName;
      providerName = completion.providerName;

      const decoded = decodeNarrationResponse(completion.text, blockIds);
      if (!decoded.ok) {
        violation = decoded.violation;
        continue;
      }

      for (const [blockId, narrationText] of decoded.segments) segments.set(blockId, narrationText);
      if (decoded.estimatedSeconds !== null) {
        estimatedSeconds = (estimatedSeconds ?? 0) + decoded.estimatedSeconds;
      }
      accepted = true;
      break;
    }

    if (!accepted) {
      return {
        ok: false,
        failure: {
          reason: 'chunk-rejected',
          chunkIndex,
          tries: input.constants.chunkMaxTries,
          // A chunk cannot be rejected without a violation having been recorded.
          violation: violation as NarrationViolation,
        },
      };
    }

    await input.onChunkDone?.(chunkIndex + 1, chunks.length);
  }

  // The stitched result must line up with the block list exactly. A stitching
  // bug therefore fails the run rather than producing a script that is subtly
  // misaligned with the lesson — which nobody would notice until it was read aloud.
  if (segments.size !== input.blocks.length) {
    return {
      ok: false,
      failure: {
        reason: 'stitch-mismatch',
        detail: `stitched ${String(segments.size)} segments for ${String(input.blocks.length)} blocks`,
      },
    };
  }
  for (const block of input.blocks) {
    if (!segments.has(block.blockId)) {
      return {
        ok: false,
        failure: { reason: 'stitch-mismatch', detail: `no segment for block ${block.blockId}` },
      };
    }
  }

  return {
    ok: true,
    segments,
    totalEstimatedSeconds: estimatedSeconds,
    inputTokenCount,
    outputTokenCount,
    modelName,
    providerName,
    chunkCount: chunks.length,
    callCount,
  };
}
