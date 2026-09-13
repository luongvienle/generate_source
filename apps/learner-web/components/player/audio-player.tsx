'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '../../lib/api';
import type { ReaderAudioView } from '../../lib/reader-types';

/**
 * FR-AUDIO-02: playback with highlight sync.
 *
 * A client component that WRAPS the rendered body rather than living inside the
 * renderer. `LessonBody` is shared with the admin preview and stays free of
 * click handling; it already emits `data-block-id` on every block, and this
 * component finds blocks through the DOM by that attribute. Nothing in
 * `packages/content` changes.
 *
 * THE SIGNED URL IS MINTED AT PLAY, NOT AT PAGE LOAD, and re-minted as it
 * nears expiry. E-03: "a long-lived URL survives the grant that produced it",
 * and every mint re-runs §7.3 — so a grant revoked mid-listen stops the next
 * refresh. A lesson longer than the TTL, or a learner who pauses and comes
 * back, would otherwise hit a dead URL with no diagnosis.
 */

const SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const;

/**
 * Playback speed persists across lessons (FR-AUDIO-02). §8 defines no
 * user-preferences table and P7 adds no column, so this is a per-browser
 * preference in localStorage — which is what "across lessons" needs and no more.
 */
const SPEED_KEY = 'ke.playbackRate';

/** Re-mint this far before the URL actually expires, so a seek never races it. */
const REFRESH_MARGIN_SECONDS = 60;

interface SignedUrl {
  url: string;
  expiresInSeconds: number;
}

export function AudioPlayer({
  audio,
  initialPositionMs,
  onPositionChange,
}: {
  audio: ReaderAudioView;
  initialPositionMs?: number;
  onPositionChange?: (positionMs: number) => void;
}) {
  const elementRef = useRef<HTMLAudioElement | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [rate, setRate] = useState(1);
  const [positionMs, setPositionMs] = useState(initialPositionMs ?? 0);
  const expiresAtRef = useRef(0);

  /** Ordered once; highlight lookup runs on every timeupdate. */
  const segments = useMemo(
    () => [...audio.segments].sort((a, b) => a.startMillisecond - b.startMillisecond),
    [audio.segments],
  );

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(SPEED_KEY);
      const parsed = stored === null ? NaN : Number(stored);
      if (SPEEDS.includes(parsed as (typeof SPEEDS)[number])) setRate(parsed);
    } catch {
      // Private windows and blocked site data throw on access. A missing speed
      // preference is not worth a broken player.
    }
  }, []);

  useEffect(() => {
    if (elementRef.current) elementRef.current.playbackRate = rate;
  }, [rate, source]);

  const mint = useCallback(async (): Promise<string | null> => {
    try {
      const signed = await apiFetch<SignedUrl>(`/media/${audio.mediaId}/signed-url`, {
        cache: 'no-store',
      });
      expiresAtRef.current = Date.now() + signed.expiresInSeconds * 1000;
      setSource(signed.url);
      setFailed(false);
      return signed.url;
    } catch {
      // A refusal here is entitlement changing under the listener — a revoked
      // or expired grant. Surface it as a dead player rather than a crash.
      setFailed(true);
      return null;
    }
  }, [audio.mediaId]);

  /** Re-mint if the current URL is close enough to expiry to fail a seek. */
  const ensureFresh = useCallback(async () => {
    if (source && Date.now() < expiresAtRef.current - REFRESH_MARGIN_SECONDS * 1000) return;
    await mint();
  }, [mint, source]);

  /**
   * The first play is our own button, not the native control.
   *
   * With no `src` the element cannot fire `onPlay` at all, so there is nothing
   * to intercept — and giving it a `src` up front is exactly the page-load mint
   * this design avoids. So: mint, set the source, then play once the element
   * has it.
   */
  const startPlayback = useCallback(async () => {
    const url = await mint();
    if (!url) return;
    const element = elementRef.current;
    if (!element) return;
    element.src = url;
    if (initialPositionMs && initialPositionMs > 0) {
      element.currentTime = initialPositionMs / 1000;
    }
    element.playbackRate = rate;
    await element.play().catch(() => undefined);
  }, [initialPositionMs, mint, rate]);

  /** The block currently being read, by offset. */
  const activeBlockId = useMemo(() => {
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      const segment = segments[index];
      if (segment && positionMs >= segment.startMillisecond && positionMs < segment.endMillisecond) {
        return segment.blockId;
      }
    }
    return null;
  }, [positionMs, segments]);

  /**
   * Highlighting is a DOM write rather than React state on the body, because
   * the body is server-rendered markup this component does not own.
   */
  useEffect(() => {
    const nodes = document.querySelectorAll<HTMLElement>('[data-block-id]');
    nodes.forEach((node) => {
      const isActive = node.dataset['blockId'] === activeBlockId;
      if (isActive) node.dataset['playing'] = 'true';
      else delete node.dataset['playing'];
    });
  }, [activeBlockId]);

  /** FR-AUDIO-02: "The player seeks to a block when the learner clicks it." */
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-block-id]');
      const blockId = target?.dataset['blockId'];
      if (!blockId) return;
      const segment = segments.find((candidate) => candidate.blockId === blockId);
      const element = elementRef.current;
      if (!segment || !element) return;

      void (async () => {
        await ensureFresh();
        element.currentTime = segment.startMillisecond / 1000;
        setPositionMs(segment.startMillisecond);
        await element.play().catch(() => undefined);
      })();
    };

    const body = document.querySelector('[data-testid="lesson-body"]');
    body?.addEventListener('click', onClick as EventListener);
    return () => body?.removeEventListener('click', onClick as EventListener);
  }, [ensureFresh, segments]);

  const changeRate = (next: number) => {
    setRate(next);
    try {
      window.localStorage.setItem(SPEED_KEY, String(next));
    } catch {
      // Same as the read: the preference is a convenience, not state.
    }
  };

  return (
    <section
      className="sticky bottom-0 mt-6 flex flex-wrap items-center gap-3 border-t border-neutral-200 bg-white/95 py-3"
      data-testid="audio-player"
    >
      {source === null ? (
        <button
          type="button"
          onClick={() => void startPlayback()}
          data-testid="audio-start"
          className="rounded bg-neutral-900 px-4 py-2 text-white"
        >
          ▶ Nghe bài học
        </button>
      ) : null}

      <audio
        ref={elementRef}
        controls
        preload="none"
        data-testid="audio-element"
        className={source === null ? 'hidden' : 'min-w-0 flex-1'}
        onPlay={() => void ensureFresh()}
        onTimeUpdate={(event) => {
          const ms = Math.floor(event.currentTarget.currentTime * 1000);
          setPositionMs(ms);
          onPositionChange?.(ms);
        }}
        onError={() => {
          // A dead URL mid-listen is the expiry case E-03 describes. Re-mint
          // once; if entitlement is genuinely gone, `mint` surfaces that.
          if (source) void mint();
        }}
      />

      <label className="flex items-center gap-2 text-sm">
        <span>Tốc độ</span>
        <select
          value={rate}
          data-testid="playback-rate"
          onChange={(event) => changeRate(Number(event.target.value))}
          className="rounded border border-neutral-300 px-2 py-1"
        >
          {SPEEDS.map((speed) => (
            <option key={speed} value={speed}>
              {speed}×
            </option>
          ))}
        </select>
      </label>

      {failed ? (
        <p className="text-sm text-neutral-600" data-testid="audio-unavailable">
          Không phát được audio. Quyền truy cập có thể đã hết hạn.
        </p>
      ) : null}
    </section>
  );
}
