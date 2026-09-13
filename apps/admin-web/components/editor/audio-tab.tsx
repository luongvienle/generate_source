'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiFetch } from '../../lib/api';
import { JobProgress } from '../job-progress';
import {
  audioPath,
  formatDuration,
  runCost,
  type AudioRowView,
  type AudioView,
} from '../../lib/audio-types';

/**
 * §5.6 audio: generate, watch, and hear the result.
 *
 * A FULL-WIDTH TAB beside narration, for the same reason: the segment list is
 * read top to bottom across the whole lesson.
 *
 * NO HIGHLIGHT SYNC AND NO SEEK-TO-BLOCK. This is a plain `<audio>` element on
 * the merged file, so the phase's output can actually be heard. FR-AUDIO-02's
 * player — the one that follows the voice and seeks when a learner clicks a
 * block — is P7's, and it consumes the offsets this tab only displays.
 */

const errorMessages: Record<string, string> = {
  AUDIO_SCRIPT_NOT_FOUND: 'Generate a narration script for this lesson first.',
  AUDIO_SCRIPT_NOT_APPROVED: 'The narration script must be approved before audio can be generated.',
  AUDIO_SCRIPT_STALE: 'The narration script is out of date. Regenerate and approve it first.',
  AUDIO_GENERATION_IN_FLIGHT: 'An audio run is already going for this lesson.',
  AUDIO_TOO_MANY_SEGMENTS: 'This lesson has too many segments to voice in one run. Split it.',
  AUDIO_SEGMENT_TOO_LONG: 'One narration segment is too long for the voice provider. Shorten it.',
  AUDIO_VOICE_NOT_CONFIGURED: 'This course is set to a voice the provider does not offer.',
  FORBIDDEN_COURSE_PUBLISHED: 'This course is published, so only the owner can change it (R-01).',
  FORBIDDEN_NOT_ASSIGNED: 'This lesson is assigned to another admin (R-02).',
};

const describe = (caught: unknown): string => {
  if (caught instanceof ApiError) {
    return (
      errorMessages[caught.failure.errorCode ?? ''] ?? `Request failed (${caught.failure.status}).`
    );
  }
  return caught instanceof Error ? caught.message : String(caught);
};

const statusLabels: Record<string, string> = {
  pending: 'Not generated',
  generating: 'Generating…',
  ready: 'Ready',
  stale: 'Out of date',
  failed: 'Failed',
};

const freshnessLabels: Record<AudioRowView['freshness'], string> = {
  fresh: '',
  stale: 'Narration changed',
  missing: 'No audio',
};

/** What a segment is called in the left column. */
const blockLabel = (row: AudioRowView): string => {
  if (row.figureNumber !== null) return `Figure ${String(row.figureNumber)}`;
  if (row.tableNumber !== null) return `Table ${String(row.tableNumber)}`;
  return `Segment ${String(row.segmentOrder + 1)}`;
};

const asTimestamp = (ms: number | null): string => {
  if (ms === null) return '—';
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60))}:${String(total % 60).padStart(2, '0')}`;
};

export function AudioTab({
  lessonId,
  canEdit,
  onGenerateRequested,
  pendingGeneration,
}: {
  lessonId: string;
  canEdit: boolean;
  /** Asks the editor to flush a dirty buffer first; it calls back through `pendingGeneration`. */
  onGenerateRequested: () => void;
  /** Set by the editor once the buffer is clean and generation may proceed. */
  pendingGeneration: 'idle' | 'flushing' | 'go' | 'cancelled';
}) {
  const [view, setView] = useState<AudioView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await apiFetch<AudioView>(audioPath(lessonId));
      setView(next);
      setError(null);
    } catch (caught) {
      setError(describe(caught));
    }
  }, [lessonId]);

  useEffect(() => {
    void load();
  }, [load]);

  const startGeneration = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch<{ jobId: string }>(audioPath(lessonId), { method: 'POST' });
      setJobId(response.jobId);
    } catch (caught) {
      if (caught instanceof ApiError) {
        const body = (caught.failure.body ?? {}) as { jobId?: string };
        // A 409 carries the run already going: attach to it rather than
        // starting a rival that would pay for the same segments again.
        if (caught.failure.errorCode === 'AUDIO_GENERATION_IN_FLIGHT' && body.jobId) {
          setJobId(body.jobId);
        }
      }
      setError(describe(caught));
    } finally {
      setBusy(false);
    }
  }, [lessonId]);

  // The other half of flush-then-generate: the editor reports the buffer clean.
  useEffect(() => {
    if (pendingGeneration === 'go') void startGeneration();
  }, [pendingGeneration, startGeneration]);

  const onGenerateClick = useCallback(() => {
    // Regenerating over existing audio costs one paid call per changed segment.
    // The confirmation names both numbers, because the reuse is the whole point
    // of FR-AUDIO-01 and is otherwise invisible.
    if (view && view.status !== null && !confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    onGenerateRequested();
  }, [view, confirming, onGenerateRequested]);

  if (!view) {
    return <p data-testid="audio-tab">{error ?? 'Loading…'}</p>;
  }

  const status = view.status;
  const cost = runCost(view.rows);
  /**
   * The server already decided this; the tab only avoids letting an admin click
   * something that cannot work. Every write refuses independently.
   */
  const blocked = view.blockedReason;
  const generateDisabled =
    !canEdit || busy || status === 'generating' || pendingGeneration === 'flushing' || blocked !== null;

  return (
    <section data-testid="audio-tab" data-status={status ?? 'none'} className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <span
          data-testid="audio-status"
          className="rounded border border-slate-300 bg-slate-50 px-2 py-1 text-sm"
        >
          {status ? (statusLabels[status] ?? status) : 'Not generated'}
        </span>

        <span className="text-sm text-slate-600">{formatDuration(view.totalDurationSeconds)}</span>

        <span data-testid="audio-voice" className="text-sm text-slate-600">
          Voice: {view.configuredVoiceIdentifier}
          {view.voiceIdentifier && view.voiceIdentifier !== view.configuredVoiceIdentifier
            ? ` (recorded with ${view.voiceIdentifier})`
            : ''}
        </span>

        <button
          type="button"
          data-testid="audio-generate"
          disabled={generateDisabled}
          title={blocked ? (errorMessages[blocked] ?? blocked) : undefined}
          onClick={onGenerateClick}
          className="rounded border border-slate-400 px-3 py-1 text-sm disabled:opacity-50"
        >
          {status === null ? 'Generate audio' : 'Regenerate audio'}
        </button>

        <button
          type="button"
          onClick={() => void load()}
          className="rounded border border-slate-300 px-2 py-1 text-sm"
        >
          Reload
        </button>
      </div>

      {blocked ? (
        <p role="status" data-testid="audio-blocked" className="text-sm text-amber-800">
          {errorMessages[blocked] ?? blocked}
        </p>
      ) : null}

      {confirming ? (
        <p
          role="alert"
          data-testid="audio-regenerate-confirm"
          className="rounded border border-amber-400 bg-amber-50 px-3 py-2 text-sm"
        >
          {cost.synthesize} segment{cost.synthesize === 1 ? '' : 's'} will be voiced again and{' '}
          {cost.reuse} will be reused.{' '}
          <button
            type="button"
            data-testid="audio-regenerate-confirmed"
            onClick={onGenerateClick}
            className="underline"
          >
            Regenerate anyway
          </button>{' '}
          <button type="button" onClick={() => setConfirming(false)} className="underline">
            Cancel
          </button>
        </p>
      ) : null}

      {!canEdit ? (
        <p role="status" data-testid="audio-read-only" className="text-sm text-slate-700">
          {errorMessages[view.readOnlyReason ?? ''] ?? 'You cannot edit this lesson.'}
        </p>
      ) : null}

      {error ? (
        <p role="alert" data-testid="audio-error" className="text-sm text-rose-700">
          {error}
        </p>
      ) : null}

      {view.errorMessage ? (
        <p role="alert" data-testid="audio-failure-reason" className="text-sm text-rose-700">
          {view.errorMessage}
        </p>
      ) : null}

      <JobProgress
        jobId={jobId}
        onSettled={() => {
          setJobId(null);
          void load();
        }}
      />

      {view.mergedAudioUrl ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption -- the narration script IS the transcript
        <audio
          data-testid="audio-player"
          controls
          preload="none"
          src={view.mergedAudioUrl}
          className="w-full"
        />
      ) : null}

      <ol data-testid="audio-rows" className="space-y-2">
        {view.rows.map((row) => (
          <li
            key={row.blockId}
            data-testid={`audio-row-${row.blockId}`}
            data-freshness={row.freshness}
            className="grid grid-cols-[10rem_1fr_6rem] items-start gap-3 border-b border-slate-200 pb-2"
          >
            <div className="text-sm">
              <div className="font-medium">{blockLabel(row)}</div>
              {freshnessLabels[row.freshness] ? (
                <span
                  data-testid={`audio-freshness-${row.blockId}`}
                  className="text-xs text-amber-700"
                >
                  {freshnessLabels[row.freshness]}
                </span>
              ) : null}
            </div>

            <p className="text-sm text-slate-700">{row.narrationText}</p>

            <span className="text-right text-xs tabular-nums text-slate-500">
              {asTimestamp(row.startMillisecond)}
            </span>
          </li>
        ))}
      </ol>

      {view.orphanedSegmentBlockIds.length > 0 ? (
        <p data-testid="audio-orphans" className="text-sm text-slate-600">
          {view.orphanedSegmentBlockIds.length} recorded segment
          {view.orphanedSegmentBlockIds.length === 1 ? '' : 's'} belong to narration that has since
          been removed. Regenerating drops them.
        </p>
      ) : null}
    </section>
  );
}
