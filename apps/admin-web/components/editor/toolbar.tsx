'use client';

import type { EditorHandle } from './markdown-editor';

/**
 * FR-EDIT-01's authoring affordances.
 *
 * Insert-table and insert-figure earn their place: a GFM table is painful to
 * type by hand, and `::figure` / `::caption` are dialect-specific syntax nobody
 * should have to memorise.
 */

const TABLE_SKELETON = [
  '::caption[Caption]',
  '',
  '| Column A | Column B |',
  '|---|---|',
  '| value | value |',
  '',
].join('\n');

export function Toolbar({
  editor,
  disabled,
}: {
  editor: React.RefObject<EditorHandle | null>;
  disabled: boolean;
}) {
  const act = (run: (handle: EditorHandle) => void) => () => {
    const handle = editor.current;
    if (handle) run(handle);
  };

  const buttons: ReadonlyArray<{ label: string; testId: string; onClick: () => void }> = [
    { label: 'Bold', testId: 'bold', onClick: act((e) => e.wrap('**', '**')) },
    { label: 'Italic', testId: 'italic', onClick: act((e) => e.wrap('*', '*')) },
    { label: 'Code', testId: 'inline-code', onClick: act((e) => e.wrap('`', '`')) },
    { label: 'Link', testId: 'link', onClick: act((e) => e.wrap('[', '](https://)')) },
    { label: 'Heading', testId: 'heading', onClick: act((e) => e.prefixLines('## ')) },
    { label: 'Bullets', testId: 'bullet-list', onClick: act((e) => e.prefixLines('- ')) },
    { label: 'Numbers', testId: 'ordered-list', onClick: act((e) => e.prefixLines('1. ')) },
    { label: 'Quote', testId: 'blockquote', onClick: act((e) => e.prefixLines('> ')) },
    { label: 'Table', testId: 'insert-table', onClick: act((e) => e.insert(TABLE_SKELETON)) },
    { label: 'Figure', testId: 'insert-figure', onClick: act((e) => e.insert('::figure\n\n')) },
  ];

  return (
    <div className="flex flex-wrap gap-1" role="toolbar" aria-label="Formatting">
      {buttons.map((button) => (
        <button
          key={button.testId}
          type="button"
          data-testid={`toolbar-${button.testId}`}
          disabled={disabled}
          onClick={button.onClick}
          className="rounded border border-slate-300 bg-white px-2 py-1 text-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {button.label}
        </button>
      ))}
    </div>
  );
}
