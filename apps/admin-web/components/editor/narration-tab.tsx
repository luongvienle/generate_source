'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, apiFetch } from '../../lib/api';
import { JobProgress } from '../job-progress';
import {
  formatRuntime,
  narrationScriptPath,
  type IncompleteFigure,
  type NarrationRowView,
  type NarrationScriptView,
} from '../../lib/narration-types';

/**
 * FR-SCRIPT-01 to FR-SCRIPT-04: the per-block review screen.
 *
 * A FULL-WIDTH TAB, not a drawer. Narration is read top to bottom across the
 * whole lesson, and a 320px drawer cannot show a block's text beside its
 * segment. The images drawer is unchanged — an image belongs to one figure, and
 * a drawer is right for that.
 *
 * Block text comes from the SERVER's block list in this response, never from the
 * editor's local parse, whose ids are display-only — the distinction
 * lib/figure-resolve.ts documents and P3's drawer defect still pays for.
 */

const errorMessages: Record<string, string> = {
  SCRIPT_LESSON_EMPTY: 'Write some lesson content before generating narration.',
  SCRIPT_GENERATION_IN_FLIGHT: 'A narration run is already going for this lesson.',
  SCRIPT_TOO_MANY_CHUNKS: 'This lesson is too long to narrate in one run. Split it into smaller lessons.',
  SCRIPT_NOT_FOUND: 'There is no narration script for this lesson yet.',
  SCRIPT_SEGMENT_UNKNOWN: 'That block is no longer in the script. Reload and try again.',
  SCRIPT_NOT_APPROVABLE: 'Only a fresh script can be approved. Regenerate it first.',
  SCRIPT_CONFLICT: 'Another admin saved first. Reload to see their version.',
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

const freshnessLabels: Record<NarrationRowView['freshness'], string> = {
  fresh: '',
  changed: 'Block changed',
  missing: 'No narration',
};

/** What a block is called in the left column. */
const blockLabel = (row: NarrationRowView): string => {
  if (row.blockType === 'figure') return `Figure ${String(row.figureNumber ?? '?')}`;
  if (row.blockType === 'table') return `Table ${String(row.tableNumber ?? '?')}`;
  return row.blockType;
};

export function NarrationTab({
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
  const [view, setView] = useState<NarrationScriptView | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [figureGaps, setFigureGaps] = useState<IncompleteFigure[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await apiFetch<NarrationScriptView>(narrationScriptPath(lessonId));
      setView(next);
      setDrafts({});
      setError(null);
    } catch (caught) {
      setError(describe(caught));
    }
  }, [lessonId]);

  useEffect(() => {
    void load();
  }, [load]);

  const editedCount = useMemo(
    () => (view?.rows ?? []).filter((row) => row.isEdited).length,
    [view],
  );

  const startGeneration = useCallback(async () => {
    setBusy(true);
    setError(null);
    setFigureGaps(null);
    try {
      const response = await apiFetch<{ jobId: string }>(narrationScriptPath(lessonId), {
        method: 'POST',
      });
      setJobId(response.jobId);
    } catch (caught) {
      if (caught instanceof ApiError) {
        const body = (caught.failure.body ?? {}) as {
          figures?: IncompleteFigure[];
          jobId?: string;
        };
        // A 409 carries the run already going: attach to it rather than starting a rival.
        if (caught.failure.errorCode === 'SCRIPT_GENERATION_IN_FLIGHT' && body.jobId) {
          setJobId(body.jobId);
        }
        if (Array.isArray(body.figures)) setFigureGaps(body.figures);
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
    // Regenerating replaces machine text and CLEARS APPROVAL, even where every
    // segment is preserved. Hand edits on unchanged blocks survive, so the
    // confirmation says so rather than implying total loss.
    if (editedCount > 0 && !confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    onGenerateRequested();
  }, [editedCount, confirming, onGenerateRequested]);

  const save = useCallback(
    async (body: object) => {
      if (!view?.scriptChecksum) return;
      setBusy(true);
      setError(null);
      try {
        const next = await apiFetch<NarrationScriptView>(narrationScriptPath(lessonId), {
          method: 'PUT',
          body: JSON.stringify({ scriptChecksum: view.scriptChecksum, ...body }),
        });
        setView(next);
        setDrafts({});
      } catch (caught) {
        setError(describe(caught));
      } finally {
        setBusy(false);
      }
    },
    [lessonId, view?.scriptChecksum],
  );

  const commitEdit = useCallback(
    (blockId: string) => {
      const narrationText = drafts[blockId];
      if (narrationText === undefined) return;
      const row = view?.rows.find((item) => item.blockId === blockId);
      if (!row || row.narrationText === narrationText) return;
      void save({ segments: [{ blockId, narrationText }] });
    },
    [drafts, save, view],
  );

  if (!view) {
    return <p data-testid="narration-tab">{error ?? 'Loading…'}</p>;
  }

  const status = view.status;
  const approvable = status === 'ready';
  const isApproved = view.reviewedAt !== null;
  /**
   * A pure block reorder moves the lesson checksum while every block's own
   * checksum is unchanged, so the script reads stale with no row badged. Saying
   * so is better than showing an empty explanation.
   */
  const staleWithoutRowDetail =
    status === 'stale' && view.rows.every((row) => row.freshness === 'fresh');

  return (
    <section data-testid="narration-tab" data-status={status ?? 'none'} className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <span
          data-testid="narration-status"
          className="rounded border border-slate-300 bg-slate-50 px-2 py-1 text-sm"
        >
          {status ? (statusLabels[status] ?? status) : 'Not generated'}
        </span>

        {isApproved ? (
          <span data-testid="narration-approved" className="text-sm text-emerald-700">
            Approved
          </span>
        ) : null}

        <span className="text-sm text-slate-600">
          About {formatRuntime(view.totalEstimatedSeconds)}
        </span>

        <button
          type="button"
          data-testid="narration-generate"
          disabled={!canEdit || busy || status === 'generating' || pendingGeneration === 'flushing'}
          onClick={onGenerateClick}
          className="rounded border border-slate-400 px-3 py-1 text-sm disabled:opacity-50"
        >
          {status === null ? 'Generate narration' : 'Regenerate'}
        </button>

        <button
          type="button"
          data-testid="narration-approve"
          disabled={!canEdit || busy || !approvable}
          title={approvable ? undefined : 'Only a fresh script can be approved.'}
          onClick={() => void save({ approve: !isApproved })}
          className="rounded border border-slate-400 px-3 py-1 text-sm disabled:opacity-50"
        >
          {isApproved ? 'Withdraw approval' : 'Approve'}
        </button>

        <button
          type="button"
          onClick={() => void load()}
          className="rounded border border-slate-300 px-2 py-1 text-sm"
        >
          Reload
        </button>
      </div>

      {confirming ? (
        <p
          role="alert"
          data-testid="narration-regenerate-confirm"
          className="rounded border border-amber-400 bg-amber-50 px-3 py-2 text-sm"
        >
          {editedCount} segment{editedCount === 1 ? '' : 's'} you edited by hand will be kept where
          the block is unchanged, and approval will be cleared.{' '}
          <button
            type="button"
            data-testid="narration-regenerate-confirmed"
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
        <p role="status" data-testid="narration-read-only" className="text-sm text-slate-700">
          {errorMessages[view.readOnlyReason ?? ''] ?? 'You cannot edit this lesson.'}
        </p>
      ) : null}

      {staleWithoutRowDetail ? (
        <p role="status" className="text-sm text-slate-700">
          The lesson&rsquo;s block order changed. Regenerating will reorder the narration without
          rewriting it.
        </p>
      ) : null}

      {figureGaps ? (
        <ul data-testid="narration-figure-gaps" className="rounded border border-amber-400 bg-amber-50 p-3 text-sm">
          {figureGaps.map((figure) => (
            <li key={figure.blockId}>
              Figure {String(figure.figureNumber ?? '?')} needs: {figure.missing.join(', ')} — open
              it in the Write tab and fill them in.
            </li>
          ))}
        </ul>
      ) : null}

      {pendingGeneration === 'cancelled' ? (
        <p role="alert" data-testid="narration-save-blocked" className="text-sm text-red-700">
          Your lesson content could not be saved, so nothing was generated. Fix it in the Write tab
          and try again.
        </p>
      ) : null}

      {error ? (
        <p role="alert" data-testid="narration-error" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}

      {view.errorMessage ? (
        <p data-testid="narration-failure-reason" className="text-sm text-red-700">
          Last run failed: {view.errorMessage}
        </p>
      ) : null}

      {/*
        The job settles only after withJobLifecycle has marked the row, which is
        after the processor's write committed — so reloading here always sees the
        finished script rather than the state before it.
      */}
      <JobProgress
        jobId={jobId}
        onSettled={() => {
          setJobId(null);
          void load();
        }}
      />

      <table className="w-full table-fixed border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-300 text-left">
            <th className="w-1/2 p-2">Lesson</th>
            <th className="w-1/2 p-2">Narration</th>
          </tr>
        </thead>
        <tbody>
          {view.rows.map((row) => (
            <tr
              key={row.blockId}
              data-testid="narration-row"
              data-block-id={row.blockId}
              data-freshness={row.freshness}
              className="border-b border-slate-200 align-top"
            >
              <td className="p-2">
                <span className="mr-2 text-xs uppercase text-slate-500">{blockLabel(row)}</span>
                {row.freshness !== 'fresh' ? (
                  <span data-testid="narration-badge" className="mr-2 text-xs text-amber-700">
                    {freshnessLabels[row.freshness]}
                  </span>
                ) : null}
                {row.isEdited ? (
                  <span data-testid="narration-edited" className="text-xs text-sky-700">
                    Edited
                  </span>
                ) : null}
                <p className="whitespace-pre-wrap text-slate-700">{row.text || <em>(no text)</em>}</p>
              </td>
              <td className="p-2">
                <textarea
                  data-testid="narration-text"
                  className="min-h-[4rem] w-full border border-slate-300 p-2"
                  readOnly={!canEdit || row.narrationText === null}
                  value={drafts[row.blockId] ?? row.narrationText ?? ''}
                  onChange={(event) =>
                    setDrafts((current) => ({ ...current, [row.blockId]: event.target.value }))
                  }
                  onBlur={() => commitEdit(row.blockId)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {view.orphanedSegments.length > 0 ? (
        <div data-testid="narration-orphans" className="rounded border border-slate-300 p-3 text-sm">
          <p className="font-semibold">
            Narration for blocks that are no longer in the lesson ({view.orphanedSegments.length})
          </p>
          <p className="text-slate-600">
            These are kept until the next run, which drops them.
          </p>
          <ul>
            {view.orphanedSegments.map((segment) => (
              <li key={segment.blockId} className="text-slate-600">
                {segment.narrationText}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
