import { describe, expect, it } from 'vitest';
import { parseLessonMarkdown } from '../src/blocks';
import { blockListChecksum, canonicalJson } from '../src/checksum';
import type { BlockList } from '../src/types';

/**
 * §6.5: what this hashes decides what costs an admin a regeneration.
 *
 * Reformatting must be free; changing a word must not be.
 */

const parse = (markdown: string, previous: BlockList | null = null): BlockList => {
  const result = parseLessonMarkdown(markdown, previous);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.blockList;
};

const checksumOf = (markdown: string, previous: BlockList | null = null): string =>
  blockListChecksum(parse(markdown, previous));

describe('reformatting does not change the checksum', () => {
  const original = parse('One two three four.\n');
  const baseline = blockListChecksum(original);

  it('ignores a reflowed paragraph', () => {
    expect(checksumOf('One two\nthree four.\n', original)).toBe(baseline);
  });

  it('ignores a trailing space', () => {
    expect(checksumOf('One two three four.   \n', original)).toBe(baseline);
  });

  it('ignores collapsed runs of whitespace', () => {
    expect(checksumOf('One   two three    four.\n', original)).toBe(baseline);
  });

  it('ignores a list bullet changing from * to -', () => {
    const list = parse('* one\n* two\n');
    expect(checksumOf('- one\n- two\n', list)).toBe(blockListChecksum(list));
  });
});

describe('a real change does change the checksum', () => {
  it('notices a changed word', () => {
    const original = parse('Hiragana is a syllabary.\n');
    expect(checksumOf('Hiragana is an alphabet.\n', original)).not.toBe(
      blockListChecksum(original),
    );
  });

  it('notices an inserted block', () => {
    const original = parse('One.\n');
    expect(checksumOf('One.\n\nTwo.\n', original)).not.toBe(blockListChecksum(original));
  });

  it('notices a figure being renumbered', () => {
    const original = parse('::figure\n');
    expect(checksumOf('::figure\n\n::figure\n', original)).not.toBe(
      blockListChecksum(original),
    );
  });

  it('notices a table caption change', () => {
    const original = parse('::caption[Before]\n\n| a |\n|---|\n| 1 |\n');
    expect(checksumOf('::caption[After]\n\n| a |\n|---|\n| 1 |\n', original)).not.toBe(
      blockListChecksum(original),
    );
  });
});

describe('canonicalJson', () => {
  it('sorts keys, so key order cannot change the hash', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe(canonicalJson({ b: 1, a: 2 }));
  });

  it('sorts nested keys too', () => {
    expect(canonicalJson({ outer: { z: 1, a: 2 } })).toBe('{"outer":{"a":2,"z":1}}');
  });

  it('preserves array order, which is document order', () => {
    expect(canonicalJson([1, 2, 3])).toBe('[1,2,3]');
  });
});

describe('the checksum itself', () => {
  it('is a 64-character hex sha256', () => {
    expect(checksumOf('One.\n')).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('is stable across repeated computation', () => {
    const list = parse('# Title\n\nBody.\n');
    expect(blockListChecksum(list)).toBe(blockListChecksum(list));
  });

  it('is empty-list stable', () => {
    expect(checksumOf('')).toBe(checksumOf(''));
  });
});
