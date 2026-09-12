import { describe, expect, it } from 'vitest';
import { parseLessonMarkdown } from '../src/blocks';
import {
  buildSegment,
  emptyScriptSegments,
  figuresMissingNarrationInput,
  isFigureInputComplete,
  narrationStaleness,
  readScriptSegments,
  reconcileSegments,
  scriptChecksum,
  segmentChecksum,
  type NarrationSegment,
} from '../src/narration';
import type { Block, BlockList } from '../src/types';

const parse = (markdown: string, previous: BlockList | null = null): BlockList => {
  const result = parseLessonMarkdown(markdown, previous);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.blockList;
};

const segmentsOf = (list: BlockList, texts: readonly string[]): NarrationSegment[] =>
  list.blocks.map((block, index) =>
    buildSegment({
      block,
      segmentOrder: index,
      narrationText: texts[index] ?? `Narration for ${block.blockId}.`,
      isEdited: false,
    }),
  );

describe('segmentChecksum', () => {
  it('is a 64-character hex sha256', () => {
    expect(segmentChecksum('Anything.')).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('ignores re-wrapping, as the block checksum does', () => {
    expect(segmentChecksum('One two\nthree four.')).toBe(segmentChecksum('One two three four.'));
  });

  it('ignores leading and trailing whitespace', () => {
    expect(segmentChecksum('  Spoken.  ')).toBe(segmentChecksum('Spoken.'));
  });

  it('notices a changed word', () => {
    expect(segmentChecksum('It is a syllabary.')).not.toBe(segmentChecksum('It is an alphabet.'));
  });
});

describe('scriptChecksum', () => {
  const list = parse('One.\n\nTwo.\n\nThree.\n');

  it('is stable across repeated computation', () => {
    const segments = segmentsOf(list, ['a', 'b', 'c']);
    expect(scriptChecksum(segments)).toBe(scriptChecksum(segments));
  });

  it('moves when any segment changes', () => {
    expect(scriptChecksum(segmentsOf(list, ['a', 'b', 'c']))).not.toBe(
      scriptChecksum(segmentsOf(list, ['a', 'CHANGED', 'c'])),
    );
  });

  it('moves when two segments are transposed', () => {
    const segments = segmentsOf(list, ['a', 'b', 'c']);
    const swapped = [segments[1]!, segments[0]!, segments[2]!];
    expect(scriptChecksum(swapped)).not.toBe(scriptChecksum(segments));
  });

  it('does not move when only isEdited or segmentOrder change', () => {
    // The checksum is the §6.5 staleness signal for AUDIO. Bookkeeping that no
    // listener can hear must not cost a resynthesis.
    const segments = segmentsOf(list, ['a', 'b', 'c']);
    const rebadged = segments.map((segment) => ({ ...segment, isEdited: true, segmentOrder: 9 }));
    expect(scriptChecksum(rebadged)).toBe(scriptChecksum(segments));
  });
});

describe('readScriptSegments', () => {
  it('reads a well-formed envelope back', () => {
    const envelope = {
      segments: segmentsOf(parse('One.\n'), ['a']),
      totalEstimatedSeconds: 12,
    };
    expect(readScriptSegments(JSON.parse(JSON.stringify(envelope)))).toEqual(envelope);
  });

  it.each([[null], [undefined], [{}], [[]], ['nonsense'], [{ segments: [{ blockId: 'b1' }] }]])(
    'reads %j as empty rather than throwing',
    (value) => {
      expect(readScriptSegments(value)).toEqual(emptyScriptSegments);
    },
  );
});

describe('buildSegment', () => {
  it('computes both checksums, so no caller assembles one by hand', () => {
    const block = parse('One.\n').blocks[0] as Block;
    const segment = buildSegment({
      block,
      segmentOrder: 0,
      narrationText: 'Spoken.',
      isEdited: false,
    });
    expect(segment.segmentChecksum).toBe(segmentChecksum('Spoken.'));
    expect(segment.sourceBlockChecksum).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe('figure input completeness (FR-IMG-03)', () => {
  const complete = { hasSelected: true, captionText: 'A cap', alternativeText: 'Alt' };

  it('is complete only when a candidate is selected and both fields are filled', () => {
    expect(isFigureInputComplete(complete)).toBe(true);
    expect(isFigureInputComplete({ ...complete, hasSelected: false })).toBe(false);
    expect(isFigureInputComplete({ ...complete, captionText: '' })).toBe(false);
    expect(isFigureInputComplete({ ...complete, alternativeText: '   ' })).toBe(false);
  });

  it('reports every gap on a figure, not just the first', () => {
    const list = parse('::figure\n');
    const gaps = figuresMissingNarrationInput(list.blocks, new Map());
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.missing).toEqual(['selectedImage', 'captionText', 'alternativeText']);
  });

  it('carries the figure number so a refusal can name it', () => {
    const list = parse('::figure\n\n::figure\n');
    const second = list.blocks[1]!;
    const gaps = figuresMissingNarrationInput(
      list.blocks,
      new Map([[list.blocks[0]!.blockId, { ...complete }]]),
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.blockId).toBe(second.blockId);
    expect(gaps[0]!.figureNumber).toBe(2);
  });

  it('ignores non-figure blocks entirely', () => {
    const list = parse('# Title\n\nBody.\n\n| a |\n|---|\n| 1 |\n');
    expect(figuresMissingNarrationInput(list.blocks, new Map())).toEqual([]);
  });

  it('reports nothing when every figure is complete', () => {
    const list = parse('::figure\n');
    const inputs = new Map([[list.blocks[0]!.blockId, complete]]);
    expect(figuresMissingNarrationInput(list.blocks, inputs)).toEqual([]);
  });
});

/**
 * The spec's worked case, as one test rather than four worker runs.
 *
 * The fixtures are deliberately long sentences with one word altered: block
 * identity survives an edit only above SIMILARITY_THRESHOLD (0.6 trigram), so a
 * short paragraph rewritten wholesale mints a NEW blockId and reads as a delete
 * plus an add rather than a change. Both behaviours are covered below.
 */
const KEEP = 'The Japanese writing system uses three scripts in combination.';
const EDIT_BEFORE = 'Hiragana is a syllabary used for grammar.';
const EDIT_AFTER = 'Hiragana is a syllabary used for particles.';
const REMOVED = 'A paragraph that will be removed entirely.';
const ADDED = 'Zebra mussels colonise freshwater intake pipes.';

const lessonBefore = `${KEEP}\n\n${EDIT_BEFORE}\n\n${REMOVED}\n`;
const lessonAfter = `${KEEP}\n\n${EDIT_AFTER}\n\n${ADDED}\n`;

describe('reconcileSegments', () => {
  const before = parse(lessonBefore);
  const [keepBlock, editBlock, removedBlock] = before.blocks as [Block, Block, Block];

  // The admin hand-edited the first segment and left the rest as generated.
  const previous: NarrationSegment[] = [
    buildSegment({ block: keepBlock, segmentOrder: 0, narrationText: 'MY WORDS.', isEdited: true }),
    buildSegment({ block: editBlock, segmentOrder: 1, narrationText: 'Old two.', isEdited: false }),
    buildSegment({ block: removedBlock, segmentOrder: 2, narrationText: 'Old three.', isEdited: false }),
  ];

  const after = parse(lessonAfter, before);
  const addedBlock = after.blocks[2] as Block;

  const result = reconcileSegments({
    previous,
    generated: new Map(after.blocks.map((block) => [block.blockId, `Fresh ${block.blockId}.`])),
    blocks: after.blocks,
  });

  it('preserves the blockId of a block edited above the similarity threshold', () => {
    // Guards the fixtures themselves: if identity stopped surviving this edit,
    // the cases below would silently stop testing what they claim to.
    expect(after.blocks[1]!.blockId).toBe(editBlock.blockId);
    expect(addedBlock.blockId).not.toBe(removedBlock.blockId);
  });

  it('keeps a hand-edited segment whose block did not change', () => {
    const kept = result.segments.find((segment) => segment.blockId === keepBlock.blockId);
    expect(kept?.narrationText).toBe('MY WORDS.');
    expect(kept?.isEdited).toBe(true);
    expect(result.preservedBlockIds).toEqual([keepBlock.blockId]);
  });

  it('replaces a segment whose block changed, and clears isEdited', () => {
    const changed = result.segments.find((segment) => segment.blockId === editBlock.blockId);
    expect(changed?.narrationText).toBe(`Fresh ${editBlock.blockId}.`);
    expect(changed?.isEdited).toBe(false);
  });

  it('generates a segment for a block that had none', () => {
    expect(
      result.segments.find((segment) => segment.blockId === addedBlock.blockId)?.narrationText,
    ).toBe(`Fresh ${addedBlock.blockId}.`);
  });

  it('drops the segment of a deleted block', () => {
    expect(result.segments.map((segment) => segment.blockId)).not.toContain(removedBlock.blockId);
    expect(result.droppedBlockIds).toEqual([removedBlock.blockId]);
  });

  it('returns one segment per block, in block order, renumbered', () => {
    expect(result.segments.map((segment) => segment.blockId)).toEqual(
      after.blocks.map((block) => block.blockId),
    );
    expect(result.segments.map((segment) => segment.segmentOrder)).toEqual([0, 1, 2]);
  });

  it('reorders a preserved segment instead of regenerating it', () => {
    const list = parse(`${KEEP}\n\n${EDIT_BEFORE}\n`);
    const [one, two] = list.blocks as [Block, Block];
    const swapped = parse(`${EDIT_BEFORE}\n\n${KEEP}\n`, list);

    const kept = reconcileSegments({
      previous: [
        buildSegment({ block: one, segmentOrder: 0, narrationText: 'A.', isEdited: true }),
        buildSegment({ block: two, segmentOrder: 1, narrationText: 'B.', isEdited: true }),
      ],
      generated: new Map(swapped.blocks.map((block) => [block.blockId, 'REGENERATED'])),
      blocks: swapped.blocks,
    });

    expect(kept.preservedBlockIds).toHaveLength(2);
    expect(kept.segments.map((segment) => segment.narrationText)).toEqual(['B.', 'A.']);
    expect(kept.segments.map((segment) => segment.segmentOrder)).toEqual([0, 1]);
  });

  it('throws rather than writing a gap when generated text is missing', () => {
    expect(() =>
      reconcileSegments({ previous: [], generated: new Map(), blocks: after.blocks }),
    ).toThrow(/no generated text/u);
  });
});

describe('narrationStaleness', () => {
  const before = parse(lessonBefore);
  const segments = segmentsOf(before, ['a', 'b', 'c']);
  const after = parse(lessonAfter, before);

  const staleness = narrationStaleness(after.blocks, segments);

  it('reports a block whose content moved', () => {
    expect(staleness.changedBlockIds).toEqual([before.blocks[1]!.blockId]);
  });

  it('reports a block that has no segment', () => {
    expect(staleness.missingBlockIds).toEqual([after.blocks[2]!.blockId]);
  });

  it('reports a segment whose block is gone', () => {
    expect(staleness.orphanedSegmentBlockIds).toEqual([before.blocks[2]!.blockId]);
  });

  it('keeps the three sets pairwise disjoint', () => {
    const all = [
      ...staleness.changedBlockIds,
      ...staleness.missingBlockIds,
      ...staleness.orphanedSegmentBlockIds,
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  it('reports nothing when the script matches the lesson', () => {
    expect(narrationStaleness(before.blocks, segments)).toEqual({
      changedBlockIds: [],
      missingBlockIds: [],
      orphanedSegmentBlockIds: [],
    });
  });

  it('reports nothing for a pure reorder, though the lesson checksum moves', () => {
    // Documented in narrationStaleness: these sets are detail, not the staleness
    // decision. §6.5 decides that by comparing the content checksum, which array
    // order is part of. Deriving staleness from these sets would miss this case.
    const reordered = parse(`${EDIT_BEFORE}\n\n${KEEP}\n\n${REMOVED}\n`, before);
    expect(narrationStaleness(reordered.blocks, segments)).toEqual({
      changedBlockIds: [],
      missingBlockIds: [],
      orphanedSegmentBlockIds: [],
    });
  });
});
