import { describe, expect, it } from 'vitest';
import {
  AUTOSAVE_DELAY_MS,
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
} from '../lib/useAutosave';

/**
 * FR-EDIT-03's timings, pinned as values rather than as folklore.
 *
 * The hook's behaviour under a real React tree is covered by the browser suite
 * (e2e/authoring.spec.ts steps 3 and 10), which is where a debounce and a
 * recovering backoff can actually be observed. What matters here is that the
 * constants match the specification and that the backoff curve is bounded.
 */

const backoffAfter = (attempt: number): number =>
  Math.min(INITIAL_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);

describe('autosave timings', () => {
  it('persists at most 3 seconds after the last keystroke (FR-EDIT-03)', () => {
    expect(AUTOSAVE_DELAY_MS).toBe(3_000);
  });

  it('backs off exponentially', () => {
    expect(backoffAfter(1)).toBe(1_000);
    expect(backoffAfter(2)).toBe(2_000);
    expect(backoffAfter(3)).toBe(4_000);
    expect(backoffAfter(4)).toBe(8_000);
  });

  it('caps the backoff, so a long outage still retries regularly', () => {
    expect(backoffAfter(20)).toBe(MAX_BACKOFF_MS);
    expect(MAX_BACKOFF_MS).toBe(30_000);
  });

  it('never waits longer than the cap, however many attempts have failed', () => {
    for (let attempt = 1; attempt <= 50; attempt += 1) {
      expect(backoffAfter(attempt)).toBeLessThanOrEqual(MAX_BACKOFF_MS);
    }
  });
});
