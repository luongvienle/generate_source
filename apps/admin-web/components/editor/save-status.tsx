'use client';

import type { SaveState } from '../../lib/useAutosave';
import type { LessonContentError } from '../../lib/content-types';

/**
 * FR-EDIT-03: "A failed save shows a visible warning and retries; it never fails
 * silently."
 *
 * Every terminal state below is a visible banner rather than a spinner that
 * never resolves, and the retrying state says when it last tried.
 */

const timeOf = (at: Date): string =>
  at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function SaveStatus({
  state,
  onReload,
}: {
  state: SaveState;
  onReload: () => void;
}) {
  switch (state.kind) {
    case 'idle':
      return <span data-testid="save-status" className="text-sm text-slate-500" />;

    case 'dirty':
      return (
        <span data-testid="save-status" className="text-sm text-slate-500">
          Unsaved changes…
        </span>
      );

    case 'saving':
      return (
        <span data-testid="save-status" className="text-sm text-slate-500">
          Saving…
        </span>
      );

    case 'saved':
      return (
        <span data-testid="save-status" className="text-sm text-emerald-700">
          Saved at {timeOf(state.at)}
        </span>
      );

    case 'retrying':
      return (
        <span
          role="alert"
          data-testid="save-status"
          className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-sm text-amber-900"
        >
          Not saved — {state.lastError}. Retrying (attempt {state.attempt}); your changes are
          still here.
        </span>
      );

    case 'conflict':
      return (
        <span
          role="alert"
          data-testid="save-status"
          className="rounded border border-rose-300 bg-rose-50 px-2 py-1 text-sm text-rose-900"
        >
          Someone else saved this lesson while you were editing. Your changes have not been
          saved.{' '}
          <button
            type="button"
            data-testid="reload-server-version"
            onClick={onReload}
            className="underline"
          >
            Load their version
          </button>{' '}
          — copy anything you need first.
        </span>
      );

    case 'invalid':
      return (
        <span
          role="alert"
          data-testid="save-status"
          className="rounded border border-rose-300 bg-rose-50 px-2 py-1 text-sm text-rose-900"
        >
          Not saved — {state.errors.length} problem{state.errors.length === 1 ? '' : 's'} to fix.
        </span>
      );
  }
}

export function ValidationErrors({ errors }: { errors: readonly LessonContentError[] }) {
  if (errors.length === 0) return null;

  return (
    <ul
      role="alert"
      data-testid="editor-errors"
      className="rounded border border-rose-200 bg-rose-50 p-2 text-sm text-rose-900"
    >
      {errors.map((error) => (
        <li key={`${error.line}:${error.column}:${error.message}`}>
          <strong>
            Line {error.line}, column {error.column}:
          </strong>{' '}
          {error.message}
        </li>
      ))}
    </ul>
  );
}
