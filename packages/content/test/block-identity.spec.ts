import { describe, expect, it } from 'vitest';
import { parseLessonMarkdown } from '../src/blocks';
import { SIMILARITY_THRESHOLD, diceCoefficient } from '../src/block-identity';
import type { BlockList } from '../src/types';

/**
 * FR-EDIT-02's stability rules, asserted through the parser because that is how
 * every caller reaches them: save markdown, save different markdown, compare ids.
 *
 * A blockId that moves silently orphans P4's approved narration and P3's chosen
 * image, and nothing else in the system would notice.
 */

const first = (markdown: string): BlockList => {
  const result = parseLessonMarkdown(markdown, null);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.blockList;
};

const next = (markdown: string, previous: BlockList): BlockList => {
  const result = parseLessonMarkdown(markdown, previous);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.blockList;
};

const ids = (list: BlockList): string[] => list.blocks.map((block) => block.blockId);

describe('exact matching', () => {
  it('leaves every id alone when nothing changed', () => {
    const before = first('# Title\n\nOne.\n\nTwo.\n');
    const after = next('# Title\n\nOne.\n\nTwo.\n', before);

    expect(ids(after)).toEqual(ids(before));
    expect(after.nextBlockSeq).toBe(before.nextBlockSeq);
  });

  it('mints exactly one id when a paragraph is inserted in the middle', () => {
    const before = first('One.\n\nTwo.\n');
    const after = next('One.\n\nInserted.\n\nTwo.\n', before);

    expect(ids(after)).toEqual(['b1', 'b3', 'b2']);
    expect(after.nextBlockSeq).toBe(4);
  });

  it('carries ids with their blocks when two paragraphs are reordered', () => {
    const before = first('Alpha.\n\nBravo.\n');
    const after = next('Bravo.\n\nAlpha.\n', before);

    expect(ids(after)).toEqual(['b2', 'b1']);
  });

  it('never reissues the id of a deleted block', () => {
    const before = first('One.\n\nTwo.\n');
    const afterDelete = next('One.\n', before);
    const afterAdd = next('One.\n\nBrand new and quite unrelated.\n', afterDelete);

    expect(ids(afterDelete)).toEqual(['b1']);
    expect(ids(afterAdd)).toEqual(['b1', 'b3']);
    expect(afterAdd.blocks.map((block) => block.blockId)).not.toContain('b2');
  });

  it('ignores reformatting — reflowing a paragraph keeps its id', () => {
    const before = first('One two three four.\n');
    const after = next('One two\nthree   four.\n', before);

    expect(ids(after)).toEqual(['b1']);
  });
});

describe('similarity matching', () => {
  it('keeps the id when a paragraph is edited but recognisable', () => {
    const before = first('Hiragana is a syllabary, not an alphabet.\n');
    const after = next('Hiragana is a syllabary, and not an alphabet at all.\n', before);

    expect(ids(after)).toEqual(['b1']);
  });

  it('mints a new id when a paragraph is replaced wholesale', () => {
    const before = first('Hiragana is a syllabary, not an alphabet.\n');
    const after = next('Completely different subject matter appears here now.\n', before);

    expect(ids(after)).toEqual(['b2']);
  });

  it('never matches across block types', () => {
    const before = first('Some shared wording here.\n');
    const after = next('> Some shared wording here.\n', before);

    expect(ids(after)).toEqual(['b2']);
  });

  it('pins both sides of the threshold', () => {
    expect(diceCoefficient('abcdef', 'abcdef')).toBe(1);
    expect(diceCoefficient('abcdef', 'zzzzzz')).toBeLessThan(SIMILARITY_THRESHOLD);
    expect(SIMILARITY_THRESHOLD).toBe(0.6);
  });

  it('scores Japanese text by characters, not words', () => {
    expect(diceCoefficient('ひらがなは音節文字です', 'ひらがなは音節文字でした')).toBeGreaterThan(
      SIMILARITY_THRESHOLD,
    );
  });
});

describe('the numeral in a blockId is a mint sequence, not a number', () => {
  /**
   * The case specs/p2-authoring/spec.md calls out by name. Insert a figure ABOVE
   * an existing one: the original keeps the id it has always had, and its
   * figureNumber moves to 2. An implementation that derived the number from the
   * id, or the id from the number, fails here.
   */
  it('renumbers a figure without touching its blockId', () => {
    const before = first('::figure\n\nProse.\n');
    const original = before.blocks[0]!;
    expect(original).toMatchObject({ blockId: 'fig1', figureNumber: 1 });

    const after = next('::figure\n\n::figure\n\nProse.\n', before);

    const figures = after.blocks.filter((block) => block.blockType === 'figure');
    expect(figures).toHaveLength(2);

    const survivor = figures.find((block) => block.blockId === original.blockId);
    expect(survivor?.figureNumber).toBe(2);

    const inserted = figures.find((block) => block.blockId !== original.blockId);
    expect(inserted?.figureNumber).toBe(1);
    expect(inserted?.blockId).toBe('fig3');
  });

  it('numbers tables separately from figures', () => {
    const list = first('::figure\n\n| a |\n|---|\n| 1 |\n\n::figure\n');

    expect(list.blocks.map((block) => [block.blockId, block.figureNumber ?? block.tableNumber])).toEqual([
      ['fig1', 1],
      ['tbl2', 1],
      ['fig3', 2],
    ]);
  });
});
