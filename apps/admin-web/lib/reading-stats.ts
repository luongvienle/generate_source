import type { BlockList } from '@knowledge-explorer/content';

/**
 * The counts the editor's status bar displays.
 *
 * Pure, and kept out of the component file so they are testable: the app's
 * tsconfig sets `jsx: "preserve"` for Next, which stops Vitest transforming
 * `.tsx`.
 *
 * These are displayed only. `lessons.estimated_minutes` stays P1's column and
 * P2 never writes it — an admin who set it deliberately should not have it
 * silently overwritten by a word count.
 */

/** 200 words per minute, the conventional silent-reading figure. */
const WORDS_PER_MINUTE = 200;

export function countWords(blockList: BlockList): number {
  return blockList.blocks.reduce((total, block) => {
    const words = block.text.trim();
    return total + (words.length === 0 ? 0 : words.split(/\s+/u).length);
  }, 0);
}

export function readingMinutes(words: number): number {
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}
