import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLessonMarkdown } from '../src/blocks';
import type { ParseResult } from '../src/types';

/**
 * The golden corpus for §6.1 block extraction.
 *
 * Each fixture is `<name>.md` plus `<name>.json` holding the exact ParseResult
 * it must produce — success or the full error list. A parser change that alters
 * output fails here loudly rather than silently changing what P3, P4 and P6
 * receive.
 *
 * Node builtins are used by the harness, never by the parser: src/blocks.ts must
 * stay isomorphic, which isomorphic.spec.ts asserts.
 */

const fixturesDir = join(__dirname, 'fixtures');

const fixtureNames = readdirSync(fixturesDir)
  .filter((name) => name.endsWith('.md'))
  .map((name) => name.slice(0, -'.md'.length))
  .sort();

const readFixture = (name: string, extension: 'md' | 'json'): string =>
  readFileSync(join(fixturesDir, `${name}.${extension}`), 'utf8');

describe('parseLessonMarkdown — golden corpus', () => {
  it('has at least one fixture', () => {
    expect(fixtureNames.length).toBeGreaterThan(0);
  });

  for (const name of fixtureNames) {
    it(`matches ${name}.json`, () => {
      const markdown = readFixture(name, 'md');
      const expected = JSON.parse(readFixture(name, 'json')) as ParseResult;

      expect(parseLessonMarkdown(markdown, null)).toEqual(expected);
    });
  }

  it('is deterministic — the same input parsed twice is identical', () => {
    for (const name of fixtureNames) {
      const markdown = readFixture(name, 'md');
      const first = parseLessonMarkdown(markdown, null);
      const second = parseLessonMarkdown(markdown, null);

      expect(first).toEqual(second);
    }
  });

  /**
   * The NFR-10 invariant: `draft_content_markdown` is the source and
   * `draft_block_list` a derived cache of it. Reparsing the stored markdown
   * against the stored block list must reproduce that block list exactly — ids
   * and counter included — or the two columns have drifted apart.
   */
  it('is a fixed point — reparsing stored markdown against its own block list changes nothing', () => {
    for (const name of fixtureNames) {
      const markdown = readFixture(name, 'md');
      const stored = parseLessonMarkdown(markdown, null);
      if (!stored.ok) continue;

      const reparsed = parseLessonMarkdown(markdown, stored.blockList);

      expect(reparsed, `${name} is not a fixed point`).toEqual(stored);
    }
  });
});

const ok = (markdown: string) => {
  const result = parseLessonMarkdown(markdown, null);
  if (!result.ok) throw new Error(`expected a parse: ${JSON.stringify(result.errors)}`);
  return result.blockList;
};

const failed = (markdown: string) => {
  const result = parseLessonMarkdown(markdown, null);
  if (result.ok) throw new Error('expected validation to fail');
  return result.errors;
};

describe('one block per top-level node', () => {
  it('emits one block for a whole list, not one per item', () => {
    const { blocks } = ok('- one\n- two\n- three\n');

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ blockType: 'list', ordered: false });
  });

  it('emits one block for a whole fenced code block', () => {
    const { blocks } = ok('```js\nconst a = 1;\nconst b = 2;\n```\n');

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ blockType: 'code', lang: 'js' });
  });

  it('separates list items in `text` so narration does not run them together', () => {
    expect(ok('- one\n- two\n')['blocks'][0]?.text).toBe('one\ntwo');
  });
});

describe('figure and table numbering (§6.1)', () => {
  it('numbers figures and tables independently, each from 1', () => {
    const { blocks } = ok(
      '::figure\n\n::caption[First]\n\n| a |\n|---|\n| 1 |\n\n::figure\n',
    );

    expect(blocks.map((block) => block.blockType)).toEqual(['figure', 'table', 'figure']);
    expect(blocks[0]?.figureNumber).toBe(1);
    expect(blocks[1]?.tableNumber).toBe(1);
    expect(blocks[2]?.figureNumber).toBe(2);
  });

  it('attaches ::caption to the table below it and emits no block for it', () => {
    const { blocks } = ok('::caption[Pronunciation]\n\n| a |\n|---|\n| 1 |\n');

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      blockType: 'table',
      captionText: 'Pronunciation',
      headers: ['a'],
      rows: [['1']],
    });
  });
});

describe('validation (FR-EDIT-01)', () => {
  it('reports every error, not the first', () => {
    const errors = failed('<b>one</b>\n\n---\n\n<i>two</i>\n');

    expect(errors.length).toBeGreaterThan(2);
    expect(errors.map((error) => error.line)).toEqual([1, 1, 3, 5, 5]);
  });

  it('rejects raw HTML inline as well as at block level', () => {
    expect(failed('Text with <span>markup</span> inside.\n')).not.toHaveLength(0);
  });

  it('rejects an unknown directive rather than dropping it', () => {
    const errors = failed('::video\n');

    expect(errors[0]?.message).toContain('::video');
  });
});
