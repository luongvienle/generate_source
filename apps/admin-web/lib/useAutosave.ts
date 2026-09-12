'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';
import type { LessonContentError } from './content-types';

/**
 * FR-EDIT-03: drafts save without an explicit action, and a failed save is
 * never silent.
 *
 * The draft persists at most AUTOSAVE_DELAY_MS after the last keystroke, and
 * immediately on blur. A transport failure retries with exponential backoff
 * capped at MAX_BACKOFF_MS for as long as the tab is open — a closed laptop lid
 * or a restarted API recovers with no user action.
 *
 * Two failures are terminal and stop the loop, because retrying either would be
 * wrong rather than merely slow:
 *
 *   - 409 conflict: another admin saved first. Retrying would overwrite them.
 *   - 422 invalid: the markdown does not parse. Retrying the same bytes cannot
 *     help; editing resumes the loop automatically.
 */

export const AUTOSAVE_DELAY_MS = 3_000;
export const INITIAL_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 30_000;

export type SaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'dirty' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved'; readonly at: Date }
  | { readonly kind: 'retrying'; readonly attempt: number; readonly lastError: string }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'invalid'; readonly errors: readonly LessonContentError[] };

export interface AutosaveOptions<T> {
  /** The current editor text. A change to this starts the debounce. */
  readonly value: string;
  /** The last value known to be persisted; equal values are not re-sent. */
  readonly savedValue: string;
  readonly save: (value: string) => Promise<T>;
  readonly onSaved: (result: T, value: string) => void;
  readonly onConflict: (error: ApiError) => void;
  readonly enabled: boolean;
}

export interface Autosave {
  readonly state: SaveState;
  /** Save now rather than waiting out the debounce — used on blur. */
  readonly flush: () => void;
  /** True when the editor holds work the server has not accepted. */
  readonly hasUnsavedWork: boolean;
}

export function useAutosave<T>({
  value,
  savedValue,
  save,
  onSaved,
  onConflict,
  enabled,
}: AutosaveOptions<T>): Autosave {
  const [state, setState] = useState<SaveState>({ kind: 'idle' });

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inFlight = useRef(false);
  const attempt = useRef(0);

  // Refs so the scheduling effect depends on `value` alone and does not restart
  // the debounce every time a caller re-creates a handler.
  const latest = useRef({ value, savedValue, save, onSaved, onConflict, enabled });
  latest.current = { value, savedValue, save, onSaved, onConflict, enabled };

  const run = useCallback(async () => {
    const { value: current, savedValue: persisted, enabled: on } = latest.current;
    if (!on || inFlight.current || current === persisted) return;

    inFlight.current = true;
    setState({ kind: 'saving' });

    try {
      const result = await latest.current.save(current);
      attempt.current = 0;
      latest.current.onSaved(result, current);
      setState({ kind: 'saved', at: new Date() });
    } catch (caught) {
      if (caught instanceof ApiError && caught.failure.status === 409) {
        latest.current.onConflict(caught);
        setState({ kind: 'conflict' });
        return;
      }
      if (caught instanceof ApiError && caught.failure.status === 422) {
        setState({ kind: 'invalid', errors: caught.failure.errors ?? [] });
        return;
      }

      attempt.current += 1;
      setState({
        kind: 'retrying',
        attempt: attempt.current,
        lastError: caught instanceof ApiError ? `HTTP ${caught.failure.status}` : 'Network error',
      });

      const delay = Math.min(INITIAL_BACKOFF_MS * 2 ** (attempt.current - 1), MAX_BACKOFF_MS);
      timer.current = setTimeout(() => void run(), delay);
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (value === savedValue) {
      // Editing back to the persisted text clears a validation failure without
      // needing a round trip.
      setState((previous) => (previous.kind === 'invalid' ? { kind: 'idle' } : previous));
      return;
    }

    setState((previous) => (previous.kind === 'conflict' ? previous : { kind: 'dirty' }));

    clearTimeout(timer.current);
    timer.current = setTimeout(() => void run(), AUTOSAVE_DELAY_MS);

    return () => clearTimeout(timer.current);
  }, [value, savedValue, enabled, run]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    void run();
  }, [run]);

  return { state, flush, hasUnsavedWork: value !== savedValue };
}
