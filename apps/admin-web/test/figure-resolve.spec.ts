import { describe, expect, it } from 'vitest';
import { parseLessonMarkdown } from '@knowledge-explorer/content';
import type { BlockList } from '@knowledge-explorer/content';
import { resolveFigureBlockId } from '../lib/figure-resolve';

/**
 * The drawer's hardest mechanic, tested away from the DOM.
 *
 * The preview's blockIds are display-only; the images API is keyed by the
 * server's. Getting this wrong attaches an image to the wrong figure, which is
 * exactly the kind of bug that looks fine until a figure is inserted above.
 */
const parse = (markdown: string): BlockList => {
  const result = parseLessonMarkdown(markdown, null);
  if (!result.ok) throw new Error('fixture did not parse');
  return result.blockList;
};

const clean = { isDirty: false, parseOk: true };

describe('resolveFigureBlockId', () => {
  const saved = parse('# Lesson\n\n::figure\n\nProse.\n\n::figure\n');

  it('maps a figure number onto the saved blockId', () => {
    const figures = saved.blocks.filter((block) => block.blockType === 'figure');

    expect(resolveFigureBlockId({ savedBlockList: saved, figureNumber: 1, ...clean })).toBe(
      figures[0]!.blockId,
    );
    expect(resolveFigureBlockId({ savedBlockList: saved, figureNumber: 2, ...clean })).toBe(
      figures[1]!.blockId,
    );
  });

  it('resolves to nothing while the buffer is dirty', () => {
    // The numbers would be the LOCAL parse's, which may already disagree.
    expect(
      resolveFigureBlockId({ savedBlockList: saved, figureNumber: 1, isDirty: true, parseOk: true }),
    ).toBeNull();
  });

  it('resolves to nothing while the buffer does not parse', () => {
    expect(
      resolveFigureBlockId({ savedBlockList: saved, figureNumber: 1, isDirty: false, parseOk: false }),
    ).toBeNull();
  });

  it('resolves to nothing for a figure the server has never seen', () => {
    expect(resolveFigureBlockId({ savedBlockList: saved, figureNumber: 3, ...clean })).toBeNull();
  });

  it('resolves to nothing before the first save', () => {
    expect(resolveFigureBlockId({ savedBlockList: null, figureNumber: 1, ...clean })).toBeNull();
  });

  /**
   * The case the whole design exists for: inserting a figure above an existing
   * one renumbers it, and the id must follow the block rather than the number.
   */
  it('follows the renumbering after a figure is inserted above', () => {
    const before = parse('::figure\n');
    const original = before.blocks[0]!.blockId;

    const after = parseLessonMarkdown('::figure\n\n::figure\n', before);
    if (!after.ok) throw new Error('reparse failed');

    // The original is now Figure 2, and still carries its own id.
    expect(
      resolveFigureBlockId({ savedBlockList: after.blockList, figureNumber: 2, ...clean }),
    ).toBe(original);
    expect(
      resolveFigureBlockId({ savedBlockList: after.blockList, figureNumber: 1, ...clean }),
    ).not.toBe(original);
  });

  it('ignores non-figure blocks that share an ordinal', () => {
    // Tables number independently; a table 1 must never resolve as figure 1.
    const withTable = parse('::caption[T]\n\n| A |\n|---|\n| 1 |\n\n::figure\n');
    const figure = withTable.blocks.find((block) => block.blockType === 'figure');

    expect(resolveFigureBlockId({ savedBlockList: withTable, figureNumber: 1, ...clean })).toBe(
      figure!.blockId,
    );
  });
});
