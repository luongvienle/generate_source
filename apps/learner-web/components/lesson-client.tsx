'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiBaseUrl, apiFetch } from '../lib/api';
import type { LessonReadView } from '../lib/reader-types';
import { AudioPlayer } from './player/audio-player';

/**
 * The interactive layer over a rendered lesson: the player (FR-AUDIO-02) and
 * progress (FR-LRN-02).
 *
 * Anonymous readers get neither — §7.3 lets them read free content, but
 * progress needs an identity to belong to. Nothing is written to localStorage
 * as a shadow of `lesson_progress`: a half-progress that only one browser knows
 * about is worse than none, because "My courses" would disagree with it.
 */

/**
 * FR-LRN-02 persists scroll and audio position. Batched, because both change
 * continuously and neither is worth a request per pixel.
 */
const DEBOUNCE_MS = 3_000;

interface ProgressState {
  completed: boolean;
  scrollPercentage: number;
  audioPositionMs: number;
}

export function LessonClient({
  lesson,
  isSignedIn,
  initialProgress,
}: {
  lesson: LessonReadView;
  isSignedIn: boolean;
  initialProgress: ProgressState | null;
}) {
  const [completed, setCompleted] = useState(initialProgress?.completed ?? false);
  const [saving, setSaving] = useState(false);

  /**
   * Held in a ref rather than state: these change on every scroll and
   * timeupdate, and re-rendering the page for a number nobody displays would
   * cost more than the write it is batching.
   */
  const pending = useRef<ProgressState>({
    completed: initialProgress?.completed ?? false,
    scrollPercentage: initialProgress?.scrollPercentage ?? 0,
    audioPositionMs: initialProgress?.audioPositionMs ?? 0,
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);

  const flush = useCallback(async () => {
    if (!isSignedIn || !dirty.current) return;
    dirty.current = false;
    try {
      await apiFetch(`/lessons/${lesson.lessonId}/progress`, {
        method: 'PUT',
        body: JSON.stringify(pending.current),
      });
    } catch {
      // A lost position is not worth an error dialog over a lesson the learner
      // is still reading. The next flush carries the newer value anyway.
    }
  }, [isSignedIn, lesson.lessonId]);

  const schedule = useCallback(() => {
    if (!isSignedIn) return;
    dirty.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), DEBOUNCE_MS);
  }, [flush, isSignedIn]);

  /** FR-LRN-02: scroll position, as a percentage of the scrollable range. */
  useEffect(() => {
    if (!isSignedIn) return undefined;

    const onScroll = () => {
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      const percentage = scrollable <= 0 ? 0 : Math.round((window.scrollY / scrollable) * 100);
      pending.current.scrollPercentage = Math.max(0, Math.min(100, percentage));
      schedule();
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [isSignedIn, schedule]);

  /**
   * The flush that matters: closing the tab.
   *
   * `pagehide` rather than `beforeunload`, which bfcache skips — and which is
   * exactly the moment FR-LRN-02's resume is supposed to capture.
   *
   * `fetch(..., { keepalive: true })` rather than `navigator.sendBeacon`, which
   * the spec named. Beacon is fixed to POST and cannot be given
   * `credentials: 'include'`, and apps/api is a different origin from this app
   * (:3001 against :3002), so a beacon would arrive as an unauthenticated POST
   * to an endpoint that is a credentialed PUT. `keepalive` survives the
   * document the same way and keeps both the method and the cookie.
   */
  useEffect(() => {
    if (!isSignedIn) return undefined;

    const onHide = () => {
      if (!dirty.current) return;
      dirty.current = false;
      void fetch(`${apiBaseUrl()}/api/lessons/${lesson.lessonId}/progress`, {
        method: 'PUT',
        keepalive: true,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pending.current),
      }).catch(() => undefined);
    };

    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      if (timer.current) clearTimeout(timer.current);
      void flush();
    };
  }, [flush, isSignedIn, lesson.lessonId]);

  /** Mark complete writes immediately — it is a decision, not a position. */
  const toggleComplete = async () => {
    const next = !completed;
    setCompleted(next);
    setSaving(true);
    pending.current.completed = next;
    try {
      await apiFetch(`/lessons/${lesson.lessonId}/progress`, {
        method: 'PUT',
        body: JSON.stringify({ ...pending.current, completed: next }),
      });
      dirty.current = false;
    } catch {
      setCompleted(!next);
      pending.current.completed = !next;
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {lesson.audio ? (
        <AudioPlayer
          audio={lesson.audio}
          initialPositionMs={initialProgress?.audioPositionMs ?? 0}
          onPositionChange={(positionMs) => {
            pending.current.audioPositionMs = positionMs;
            schedule();
          }}
        />
      ) : null}

      <div className="mt-6">
        {isSignedIn ? (
          <button
            type="button"
            onClick={() => void toggleComplete()}
            disabled={saving}
            data-testid="mark-complete"
            data-completed={completed ? 'true' : 'false'}
            className={
              completed
                ? 'rounded border border-neutral-300 px-4 py-2'
                : 'rounded bg-neutral-900 px-4 py-2 text-white'
            }
          >
            {completed ? '✓ Đã hoàn thành' : 'Đánh dấu đã hoàn thành'}
          </button>
        ) : (
          <p className="text-sm text-neutral-600" data-testid="signin-prompt">
            <Link href="/signin" className="underline">
              Đăng nhập
            </Link>{' '}
            để lưu tiến độ học và tiếp tục từ chỗ đang đọc.
          </p>
        )}
      </div>
    </>
  );
}
