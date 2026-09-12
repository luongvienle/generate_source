import { config as loadEnv } from 'dotenv';
import { describe, expect, it } from 'vitest';
import { AnthropicLlmProvider, DEFAULT_ANTHROPIC_MODEL } from '../src/anthropic-llm.provider';
import {
  NARRATION_PROMPT_VERSION,
  composeNarrationPrompt,
  decodeNarrationResponse,
  type NarrationInputBlock,
} from '../src/narration-prompt';

loadEnv({ path: ['../../.env', '.env'] });

const apiKey = process.env['ANTHROPIC_API_KEY'];

/**
 * The second test that spends money, and the only one that talks to Anthropic.
 *
 * Skipped unless ANTHROPIC_API_KEY is set, so CI never runs it and a contributor
 * without a key is never blocked. Run it by hand before shipping and whenever the
 * pinned model changes — it is the ONLY evidence that a real model satisfies
 * §6.3's hardest constraint, one segment per block in order, which the fake
 * cannot tell you anything about.
 *
 *   ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @knowledge-explorer/ai test
 *
 * EVERY ASSERTION IS LANGUAGE-NEUTRAL. courses.language_code defaults to `vi`,
 * so the figure check looks for the NUMERAL and never for the word "Figure".
 */

const blocks: readonly NarrationInputBlock[] = [
  { blockId: 'b1', blockType: 'heading', text: 'Hệ thống chữ viết tiếng Nhật' },
  {
    blockId: 'b2',
    blockType: 'paragraph',
    text: 'Tiếng Nhật dùng ba hệ chữ viết kết hợp với nhau.',
  },
  { blockId: 'b3', blockType: 'paragraph', text: 'Hiragana là một bảng âm tiết.' },
  {
    blockId: 'fig4',
    blockType: 'figure',
    text: '',
    figureNumber: 1,
    captionText: 'Bảng hiragana và katakana đặt cạnh nhau',
    alternativeText: 'Một bảng đối chiếu hai hệ chữ, hiragana bên trái và katakana bên phải',
  },
  {
    blockId: 'tbl5',
    blockType: 'table',
    text: '',
    tableNumber: 1,
    captionText: 'Vài âm tiết tiêu biểu',
    headers: ['Romaji', 'Hiragana'],
    rows: [
      ['a', 'あ'],
      ['ka', 'か'],
      ['sa', 'さ'],
    ],
  },
  { blockId: 'b6', blockType: 'paragraph', text: 'Katakana dùng cho từ mượn.' },
];

const blockIds = blocks.map((block) => block.blockId);

const run = async (languageCode: string): Promise<ReadonlyMap<string, string>> => {
  const provider = new AnthropicLlmProvider({
    apiKey: apiKey as string,
    ...(process.env['ANTHROPIC_MODEL'] ? { model: process.env['ANTHROPIC_MODEL'] } : {}),
  });

  const completion = await provider.complete({
    promptText: composeNarrationPrompt({
      blocks,
      lessonTitle: 'Hệ thống chữ viết',
      learningObjective: 'Phân biệt hai bảng âm tiết',
      languageCode,
    }),
  });

  expect(completion.modelName).toBe(process.env['ANTHROPIC_MODEL'] ?? DEFAULT_ANTHROPIC_MODEL);
  expect(completion.inputTokenCount).toBeGreaterThan(0);
  expect(completion.outputTokenCount).toBeGreaterThan(0);

  const decoded = decodeNarrationResponse(completion.text, blockIds);
  // UNMODIFIED: no repair, no retry. If this fails, §6.3's ladder is carrying
  // more weight in production than the chunk size assumes.
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) throw new Error(`violation: ${decoded.violation.kind}`);
  return decoded.segments;
};

describe.skipIf(!apiKey)('AnthropicLlmProvider against the real API', () => {
  it('satisfies §6.3 on a six-block lesson, first try', { timeout: 180_000 }, async () => {
    const segments = await run('vi');

    expect([...segments.keys()]).toEqual(blockIds);
    for (const text of segments.values()) expect(text.trim().length).toBeGreaterThan(0);
  });

  it('opens the figure segment with its number, and reads no markdown', { timeout: 180_000 }, async () => {
    const segments = await run('vi');

    // FR-SCRIPT-03: refer to the figure by its number. The NUMERAL, never the
    // English word — the fixture runs at the `vi` default.
    const figure = segments.get('fig4') ?? '';
    expect(figure.slice(0, 60)).toMatch(/1/u);

    for (const text of segments.values()) {
      // §6.3's spoken style: no markdown, no bullet glyphs, no heading hashes.
      expect(text).not.toMatch(/[*_`#]|^\s*[-•]/mu);
    }
  });

  it('honours languageCode rather than defaulting to one language', { timeout: 300_000 }, async () => {
    const vietnamese = await run('vi');
    const english = await run('en');

    // The cheapest check that the language instruction is read at all.
    expect(english.get('b2')).not.toBe(vietnamese.get('b2'));
  });

  it('pins a version identifier that lands in generator_prompt_version', () => {
    expect(NARRATION_PROMPT_VERSION).toBe('narration/v1');
  });
});
