import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_PROVIDER_NAME,
  DEFAULT_ANTHROPIC_MODEL,
  decodeMessagesResponse,
} from '../src/anthropic-llm.provider';
import { FAKE_LLM_MODEL_NAME, FAKE_LLM_PROVIDER_NAME, FakeLlmProvider } from '../src/fake-llm.provider';
import { composeNarrationPrompt, decodeNarrationResponse } from '../src/narration-prompt';
import { createLlmProvider } from '../src/provider-factory';

const prompt = (blockIds: readonly string[]): string =>
  composeNarrationPrompt({
    blocks: blockIds.map((blockId) => ({ blockId, blockType: 'paragraph', text: `Body ${blockId}.` })),
    lessonTitle: 'A lesson',
    learningObjective: null,
    languageCode: 'vi',
  });

const ids = ['b1', 'b2', 'b3'];

describe('FakeLlmProvider', () => {
  it('emits one well-formed segment per manifest block', async () => {
    const completion = await new FakeLlmProvider().complete({ promptText: prompt(ids) });
    const decoded = decodeNarrationResponse(completion.text, ids);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect([...decoded.segments.keys()]).toEqual(ids);
  });

  it('is byte-stable for the same prompt', async () => {
    const first = await new FakeLlmProvider().complete({ promptText: prompt(ids) });
    const second = await new FakeLlmProvider().complete({ promptText: prompt(ids) });
    expect(first.text).toBe(second.text);
  });

  it('names itself, so a fake row is never mistaken for a real one', async () => {
    const completion = await new FakeLlmProvider().complete({ promptText: prompt(ids) });
    expect(completion.providerName).toBe(FAKE_LLM_PROVIDER_NAME);
    expect(completion.modelName).toBe(FAKE_LLM_MODEL_NAME);
    expect(completion.inputTokenCount).toBeGreaterThan(0);
    expect(completion.outputTokenCount).toBeGreaterThan(0);
  });

  it.each([
    ['short-count', 'count'],
    ['unknown-block-id', 'unknown-block-id'],
    ['transposed', 'order'],
    ['unparseable', 'unparseable'],
  ] as const)('forces exactly the %s violation', async (fault, expectedKind) => {
    const completion = await new FakeLlmProvider({ fault }).complete({ promptText: prompt(ids) });
    const decoded = decodeNarrationResponse(completion.text, ids);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.violation.kind).toBe(expectedKind);
  });

  it('applies a fault only to the first N calls', async () => {
    const provider = new FakeLlmProvider({ fault: 'short-count', faultCallCount: 2 });
    const outcomes: boolean[] = [];
    for (let call = 0; call < 3; call += 1) {
      const completion = await provider.complete({ promptText: prompt(ids) });
      outcomes.push(decodeNarrationResponse(completion.text, ids).ok);
    }
    expect(outcomes).toEqual([false, false, true]);
    expect(provider.callCount).toBe(3);
  });
});

describe('decodeMessagesResponse', () => {
  const recorded = {
    id: 'msg_01XyZ',
    type: 'message',
    role: 'assistant',
    model: DEFAULT_ANTHROPIC_MODEL,
    content: [
      { type: 'thinking', thinking: 'Reasoning that is not the answer.' },
      { type: 'text', text: '{"segments":[],"totalEstimatedSeconds":0}' },
    ],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1234, output_tokens: 567 },
  };

  it('extracts text and both token counts from a recorded body', () => {
    const completion = decodeMessagesResponse(recorded, DEFAULT_ANTHROPIC_MODEL);
    expect(completion.text).toBe('{"segments":[],"totalEstimatedSeconds":0}');
    expect(completion.inputTokenCount).toBe(1234);
    expect(completion.outputTokenCount).toBe(567);
    expect(completion.providerName).toBe(ANTHROPIC_PROVIDER_NAME);
    expect(completion.modelName).toBe(DEFAULT_ANTHROPIC_MODEL);
  });

  it('ignores thinking blocks rather than concatenating them into the JSON', () => {
    expect(decodeMessagesResponse(recorded, 'm').text).not.toContain('Reasoning');
  });

  it('joins multiple text blocks in order', () => {
    const split = {
      content: [
        { type: 'text', text: '{"segments":' },
        { type: 'text', text: '[]}' },
      ],
      usage: { input_tokens: 1, output_tokens: 2 },
    };
    expect(decodeMessagesResponse(split, 'm').text).toBe('{"segments":[]}');
  });

  it('throws on a refusal rather than returning empty text', () => {
    expect(() =>
      decodeMessagesResponse({ stop_reason: 'refusal', content: [] }, 'm'),
    ).toThrow(/refusal/u);
  });

  it('throws when there is no text content at all', () => {
    expect(() => decodeMessagesResponse({ content: [], usage: {} }, 'm')).toThrow(/no text/u);
  });

  it('defaults missing token counts to zero rather than NaN', () => {
    const completion = decodeMessagesResponse({ content: [{ type: 'text', text: 'x' }] }, 'm');
    expect(completion.inputTokenCount).toBe(0);
    expect(completion.outputTokenCount).toBe(0);
  });
});

describe('createLlmProvider', () => {
  it('returns the fake when LLM_PROVIDER is unset', () => {
    expect(createLlmProvider({})).toBeInstanceOf(FakeLlmProvider);
  });

  it('returns the fake for any value other than anthropic', () => {
    expect(createLlmProvider({ LLM_PROVIDER: 'openai' })).toBeInstanceOf(FakeLlmProvider);
  });

  it('throws at construction when anthropic is asked for without a key', () => {
    // A silent downgrade would mean a deployment quietly serving fake narration,
    // which reads as plausible prose and is noticed by nobody until a learner
    // hears a lesson that says nothing.
    expect(() => createLlmProvider({ LLM_PROVIDER: 'anthropic' })).toThrow(/ANTHROPIC_API_KEY/u);
  });

  it('builds the real adapter when a key is present', () => {
    expect(createLlmProvider({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-test' })).not.toBeInstanceOf(
      FakeLlmProvider,
    );
  });
});
