'use client';

import type { BlockList } from '@knowledge-explorer/content';
import { countWords, readingMinutes } from '../../lib/reading-stats';

export function StatusBar({ blockList }: { blockList: BlockList }) {
  const blocks = blockList.blocks.length;
  const words = countWords(blockList);

  return (
    <p data-testid="status-bar" className="text-sm text-slate-500">
      {blocks} block{blocks === 1 ? '' : 's'} · {words} word{words === 1 ? '' : 's'} · about{' '}
      {readingMinutes(words)} min read
    </p>
  );
}
