import { describe, expect, it } from 'vitest';
import { parseLessonMarkdown } from '@knowledge-explorer/content';
import { countWords, readingMinutes } from '../lib/reading-stats';

const blockList = (markdown: string) => {
  const result = parseLessonMarkdown(markdown, null);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.blockList;
};

describe('status bar counts', () => {
  it('counts words across blocks', () => {
    expect(countWords(blockList('# One two\n\nthree four five\n'))).toBe(5);
  });

  it('counts a figure as no words, since its caption is P3’s', () => {
    expect(countWords(blockList('::figure\n'))).toBe(0);
  });

  it('counts list items once each', () => {
    expect(countWords(blockList('- alpha\n- bravo\n'))).toBe(2);
  });

  it('never reports a zero-minute read', () => {
    expect(readingMinutes(0)).toBe(1);
    expect(readingMinutes(1)).toBe(1);
  });

  it('rounds to the nearest minute at 200 words per minute', () => {
    expect(readingMinutes(200)).toBe(1);
    expect(readingMinutes(500)).toBe(3);
  });
});
