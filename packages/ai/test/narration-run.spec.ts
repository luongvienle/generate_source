import { describe, expect, it, vi } from 'vitest';
import {
  NARRATION_CHUNK_BLOCK_COUNT,
  NARRATION_CHUNK_MAX_TRIES,
  NARRATION_RUN_MAX_CALLS,
} from '@knowledge-explorer/shared';
import { FakeLlmProvider } from '../src/fake-llm.provider';
import type { LlmProvider } from '../src/llm.provider';
import type { NarrationInputBlock } from '../src/narration-prompt';
import { chunkBlocks, runNarration, worstCaseCallCount } from '../src/narration-run';

/**
 * §6.3's ladder, asserted BY COUNTING CALLS. That is the whole reason
 * runNarration takes a provider and returns segments rather than touching a
 * database: "the fourth call never happens" is an assertion here, not an
 * inference from a timeout in an integration test.
 */

const constants = {
  chunkBlockCount: NARRATION_CHUNK_BLOCK_COUNT,
  chunkMaxTries: NARRATION_CHUNK_MAX_TRIES,
  runMaxCalls: NARRATION_RUN_MAX_CALLS,
};

const blocks = (count: number): NarrationInputBlock[] =>
  Array.from({ length: count }, (_, index) => ({
    blockId: `b${String(index + 1)}`,
    blockType: 'paragraph',
    text: `Body of block ${String(index + 1)}.`,
  }));

const run = (input: {
  blocks: readonly NarrationInputBlock[];
  provider: LlmProvider;
  constants?: typeof constants;
  onChunkDone?: (done: number, total: number) => void;
}) =>
  runNarration({
    blocks: input.blocks,
    lessonTitle: 'A lesson',
    learningObjective: null,
    languageCode: 'vi',
    provider: input.provider,
    constants: input.constants ?? constants,
    ...(input.onChunkDone ? { onChunkDone: input.onChunkDone } : {}),
  });

describe('chunkBlocks', () => {
  it('splits at the fixed size with a short final chunk', () => {
    expect(chunkBlocks(blocks(60), 25).map((chunk) => chunk.length)).toEqual([25, 25, 10]);
  });

  it('returns nothing for no blocks, and one chunk for fewer than a full chunk', () => {
    expect(chunkBlocks([], 25)).toEqual([]);
    expect(chunkBlocks(blocks(3), 25)).toHaveLength(1);
  });

  it('refuses a size below one rather than looping forever', () => {
    expect(() => chunkBlocks(blocks(1), 0)).toThrow();
  });
});

describe('a clean run', () => {
  it('produces one segment per block from three chunks in three calls', async () => {
    const provider = new FakeLlmProvider();
    const result = await run({ blocks: blocks(60), provider });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.segments.size).toBe(60);
    expect(result.chunkCount).toBe(3);
    expect(result.callCount).toBe(3);
    expect(provider.callCount).toBe(3);
  });

  it('sums token counts across chunks', async () => {
    const result = await run({ blocks: blocks(60), provider: new FakeLlmProvider() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 20 output tokens per block in the fake, across all 60 blocks.
    expect(result.outputTokenCount).toBe(60 * 20);
    expect(result.inputTokenCount).toBeGreaterThan(0);
    expect(result.totalEstimatedSeconds).toBe(60 * 6);
  });

  it('reports progress once per validated chunk', async () => {
    const seen: Array<[number, number]> = [];
    await run({
      blocks: blocks(60),
      provider: new FakeLlmProvider(),
      onChunkDone: (done, total) => void seen.push([done, total]),
    });
    expect(seen).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });
});

describe('the retry ladder', () => {
  it('retries a rejected chunk in process and succeeds on the third try', async () => {
    const provider = new FakeLlmProvider({ fault: 'short-count', faultCallCount: 2 });
    const result = await run({ blocks: blocks(25), provider });

    expect(result.ok).toBe(true);
    // 1 chunk: rejected, rejected, accepted.
    expect(provider.callCount).toBe(3);
  });

  it('fails the chunk after exactly three tries and makes no fourth call', async () => {
    const provider = new FakeLlmProvider({ fault: 'short-count' });
    const result = await run({ blocks: blocks(25), provider });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe('chunk-rejected');
    if (result.failure.reason === 'chunk-rejected') {
      expect(result.failure.chunkIndex).toBe(0);
      expect(result.failure.tries).toBe(NARRATION_CHUNK_MAX_TRIES);
      expect(result.failure.violation.kind).toBe('count');
    }
    // The assertion this whole design exists for.
    expect(provider.callCount).toBe(3);
  });

  it('stops the run at the first unrecoverable chunk rather than paying for the rest', async () => {
    const provider = new FakeLlmProvider({ fault: 'unparseable' });
    const result = await run({ blocks: blocks(60), provider });

    expect(result.ok).toBe(false);
    // Three tries on chunk 1, then stop — chunks 2 and 3 are never attempted.
    expect(provider.callCount).toBe(3);
  });

  it('feeds the violation back into the retry prompt', async () => {
    const provider = new FakeLlmProvider({ fault: 'short-count', faultCallCount: 1 });
    const spy = vi.spyOn(provider, 'complete');
    await run({ blocks: blocks(5), provider });

    const retryPrompt = spy.mock.calls[1]?.[0].promptText ?? '';
    expect(retryPrompt).toContain('rejected');
    expect(retryPrompt).toContain('exactly one segment per block');
  });

  it('lets a transport error escape, so NFR-03 owns it rather than this ladder', async () => {
    const boom = new Error('socket hang up');
    const provider = new FakeLlmProvider({ throwEveryCall: boom });

    await expect(run({ blocks: blocks(25), provider })).rejects.toThrow('socket hang up');
    // Not retried in process: one call, then out to BullMQ.
    expect(provider.callCount).toBe(1);
  });
});

describe('the run ceiling', () => {
  /**
   * A chunk that ALWAYS fails exits via chunk-rejected on its third try, so it
   * can never reach the ceiling. The ceiling binds on the other shape: many
   * chunks that each succeed, but only after retrying. This provider fails the
   * first call of every pair and succeeds on the second.
   */
  const flaky = () => {
    const inner = new FakeLlmProvider();
    const provider = {
      callCount: 0,
      async complete(request: { promptText: string }) {
        provider.callCount += 1;
        const completion = await inner.complete(request);
        if (provider.callCount % 2 === 0) return completion;

        const body = JSON.parse(completion.text) as { segments: unknown[] };
        body.segments = body.segments.slice(0, -1);
        return { ...completion, text: JSON.stringify(body) };
      },
    };
    return provider;
  };

  it('stops a pathological run instead of fanning out', async () => {
    const provider = flaky();
    // 100 blocks is 4 chunks; at two calls each that is 8, over a ceiling of 7.
    const result = await run({
      blocks: blocks(100),
      provider,
      constants: { ...constants, runMaxCalls: 7 },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.reason).toBe('call-ceiling');
      if (result.failure.reason === 'call-ceiling') expect(result.failure.calls).toBe(7);
    }
    expect(provider.callCount).toBe(7);
  });

  it('lets the same run finish when the ceiling is high enough', async () => {
    const provider = flaky();
    const result = await run({
      blocks: blocks(100),
      provider,
      constants: { ...constants, runMaxCalls: 8 },
    });

    expect(result.ok).toBe(true);
    expect(provider.callCount).toBe(8);
  });

  it('predicts the worst case before any call is spent', () => {
    expect(worstCaseCallCount(60, constants)).toBe(9);
    expect(worstCaseCallCount(325, constants)).toBe(39);
    expect(worstCaseCallCount(326, constants)).toBeGreaterThan(NARRATION_RUN_MAX_CALLS);
  });
});

describe('the stitch assertion', () => {
  /**
   * Per-chunk validation already guarantees each chunk returns exactly its own
   * ids in order, and chunks do not overlap — so for a well-formed block list the
   * stitch check is unreachable defence in depth, and no test can force it
   * through the provider. It earns its place on the one input that DOES reach
   * it: a block list carrying a duplicate blockId, which would otherwise collapse
   * two blocks into one segment and silently shorten the script.
   */
  it('fails the run on a duplicate blockId rather than silently dropping a block', async () => {
    const duplicated: NarrationInputBlock[] = [
      { blockId: 'b1', blockType: 'paragraph', text: 'First.' },
      { blockId: 'b1', blockType: 'paragraph', text: 'Second, same id.' },
    ];

    const result = await run({ blocks: duplicated, provider: new FakeLlmProvider() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.reason).toBe('stitch-mismatch');
      if (result.failure.reason === 'stitch-mismatch') {
        expect(result.failure.detail).toContain('1 segments for 2 blocks');
      }
    }
  });
});
