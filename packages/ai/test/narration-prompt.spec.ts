import { describe, expect, it } from 'vitest';
import {
  MAX_TABLE_ROWS_IN_PROMPT,
  NARRATION_PROMPT_VERSION,
  composeNarrationPrompt,
  decodeNarrationResponse,
  describeViolation,
  readPromptManifest,
  type NarrationInputBlock,
} from '../src/narration-prompt';

const base = {
  lessonTitle: 'Hiragana and katakana',
  learningObjective: 'Tell the two syllabaries apart',
  languageCode: 'vi',
};

const paragraph: NarrationInputBlock = {
  blockId: 'b1',
  blockType: 'paragraph',
  text: 'Japanese uses three scripts.',
};

const figure: NarrationInputBlock = {
  blockId: 'fig2',
  blockType: 'figure',
  text: '',
  figureNumber: 1,
  captionText: 'The two syllabaries side by side',
  alternativeText: 'A chart with hiragana on the left and katakana on the right',
};

const bigTable: NarrationInputBlock = {
  blockId: 'tbl3',
  blockType: 'table',
  text: '',
  tableNumber: 1,
  captionText: 'Every syllable',
  headers: ['Romaji', 'Hiragana'],
  rows: Array.from({ length: 40 }, (_, index) => [`row${String(index)}`, `char${String(index)}`]),
};

describe('composeNarrationPrompt', () => {
  const composed = composeNarrationPrompt({ ...base, blocks: [paragraph, figure, bigTable] });

  it('carries the lesson title, objective, language code and every blockId', () => {
    expect(composed).toContain(base.lessonTitle);
    expect(composed).toContain(base.learningObjective);
    expect(composed).toContain('vi');
    for (const id of ['b1', 'fig2', 'tbl3']) expect(composed).toContain(id);
  });

  it('gives a figure its number, caption and alt text — FR-SCRIPT-03 has nothing else', () => {
    const entry = readPromptManifest(composed).find((item) => item.blockId === 'fig2');
    expect(entry?.figureNumber).toBe(1);
    expect(entry?.caption).toBe(figure.captionText);
    expect(entry?.alt).toBe(figure.alternativeText);
  });

  it('sends at most five table rows even when the block has forty', () => {
    const entry = readPromptManifest(composed).find((item) => item.blockId === 'tbl3');
    expect(entry?.rows).toHaveLength(MAX_TABLE_ROWS_IN_PROMPT);
    expect(entry?.rowsOmitted).toBe(35);
    // Enforced by NOT SENDING the rest: row 6 cannot be read aloud if it never left.
    expect(composed).not.toContain('row39');
  });

  it('omits the objective line entirely when there is none', () => {
    const withoutObjective = composeNarrationPrompt({
      ...base,
      learningObjective: null,
      blocks: [paragraph],
    });
    // A labelled blank invites the model to fill it in, which is the added
    // knowledge FR-SCRIPT-02 forbids.
    expect(withoutObjective).not.toContain('Learning objective');
  });

  it('never sends a block’s raw markdown', () => {
    const withMarkdown = composeNarrationPrompt({
      ...base,
      blocks: [{ ...paragraph, text: 'Plain text only.' }],
    });
    expect(withMarkdown).not.toContain('**');
    expect(withMarkdown).not.toContain('::figure');
  });

  it('exports a non-empty version identifier for generator_prompt_version', () => {
    expect(NARRATION_PROMPT_VERSION).toMatch(/\S/u);
  });
});

describe('decodeNarrationResponse', () => {
  const ids = ['b1', 'b2'];
  const good = JSON.stringify({
    segments: [
      { blockId: 'b1', narrationText: 'One.' },
      { blockId: 'b2', narrationText: 'Two.' },
    ],
    totalEstimatedSeconds: 12,
  });

  it('accepts a well-formed response', () => {
    const decoded = decodeNarrationResponse(good, ids);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.segments.get('b2')).toBe('Two.');
      expect(decoded.estimatedSeconds).toBe(12);
    }
  });

  it('forgives a code fence, which is formatting, not content', () => {
    expect(decodeNarrationResponse('```json\n' + good + '\n```', ids).ok).toBe(true);
  });

  it('rejects prose', () => {
    const decoded = decodeNarrationResponse('Certainly! Here you go.', ids);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.violation.kind).toBe('unparseable');
  });

  it('rejects a short count and reports both numbers', () => {
    const decoded = decodeNarrationResponse(
      JSON.stringify({ segments: [{ blockId: 'b1', narrationText: 'One.' }] }),
      ids,
    );
    expect(decoded.ok).toBe(false);
    if (!decoded.ok && decoded.violation.kind === 'count') {
      expect(decoded.violation.expected).toBe(2);
      expect(decoded.violation.received).toBe(1);
    }
  });

  it('rejects an unknown blockId', () => {
    const decoded = decodeNarrationResponse(
      JSON.stringify({
        segments: [
          { blockId: 'b1', narrationText: 'One.' },
          { blockId: 'b99', narrationText: 'Two.' },
        ],
      }),
      ids,
    );
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.violation.kind).toBe('unknown-block-id');
  });

  it('rejects a transposed order even though both ids are known', () => {
    const decoded = decodeNarrationResponse(
      JSON.stringify({
        segments: [
          { blockId: 'b2', narrationText: 'Two.' },
          { blockId: 'b1', narrationText: 'One.' },
        ],
      }),
      ids,
    );
    expect(decoded.ok).toBe(false);
    if (!decoded.ok && decoded.violation.kind === 'order') {
      expect(decoded.violation.position).toBe(0);
      expect(decoded.violation.expected).toBe('b1');
      expect(decoded.violation.received).toBe('b2');
    }
  });

  it('treats a missing estimate as null rather than zero', () => {
    const decoded = decodeNarrationResponse(
      JSON.stringify({ segments: [{ blockId: 'b1', narrationText: 'One.' }] }),
      ['b1'],
    );
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.estimatedSeconds).toBeNull();
  });

  it('describes every violation in words a model can act on', () => {
    const messages = [
      describeViolation({ kind: 'unparseable', detail: 'x' }),
      describeViolation({ kind: 'count', expected: 3, received: 2 }),
      describeViolation({ kind: 'unknown-block-id', blockId: 'b9' }),
      describeViolation({ kind: 'order', position: 1, expected: 'b2', received: 'b3' }),
    ];
    for (const message of messages) expect(message.length).toBeGreaterThan(20);
    expect(messages[1]).toContain('3');
    expect(messages[2]).toContain('b9');
  });
});
