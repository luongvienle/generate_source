'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiFetch } from '../lib/api';
import { JobProgress } from './job-progress';
import {
  publishLabel,
  statusLabels,
  type PublicationStatusView,
  type PublishChecklistView,
} from '../lib/publish-types';

/**
 * §5.7 publishing, for the owner and the admin who hands work over.
 *
 * WHAT EACH ROLE SEES, and why it differs. The checklist is a §9.2 OWNER
 * endpoint, so an admin is refused it server-side and the panel does not ask for
 * it; an admin sees the publication status and the one action §3 grants them,
 * submit-for-review. The owner sees the checklist and every transition §4.2
 * allows from the current state.
 *
 * Nothing here is enforcement. `allowedTransitions` comes from the server's own
 * §4.2 table and the endpoints refuse anything else, so this only avoids
 * offering a button that would 409 or 403 (R-01: "enforced server-side, not by
 * hiding buttons").
 */
export function PublishPanel({ courseId, isOwner }: { courseId: string; isOwner: boolean }) {
  const [status, setStatus] = useState<PublicationStatusView | null>(null);
  const [checklist, setChecklist] = useState<PublishChecklistView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await apiFetch<PublicationStatusView>(
        `/admin/courses/${courseId}/publication-status`,
      );
      setStatus(next);
      if (isOwner) {
        setChecklist(
          await apiFetch<PublishChecklistView>(`/admin/courses/${courseId}/publish-checklist`),
        );
      }
    } catch (caught) {
      setError(describe(caught));
    }
  }, [courseId, isOwner]);

  useEffect(() => {
    void load();
  }, [load]);

  async function transition(action: string) {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/admin/courses/${courseId}/${action}`, { method: 'POST' });
      await load();
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setBusy(false);
    }
  }

  /**
   * FR-PUB-02. A 422 is not an error to report and forget: it carries the whole
   * checklist, so the panel re-renders the failures the owner has to fix rather
   * than making them reload to find out what went wrong.
   */
  async function publish() {
    setBusy(true);
    setError(null);
    try {
      const { jobId: started } = await apiFetch<{ jobId: string }>(
        `/admin/courses/${courseId}/publish`,
        { method: 'POST' },
      );
      setJobId(started);
    } catch (caught) {
      if (caught instanceof ApiError && caught.failure.status === 422) {
        const failed = caught.failure.body?.['checklist'] as PublishChecklistView | undefined;
        if (failed) setChecklist(failed);
        setError('The publish checklist has failures. Fix the items below and try again.');
      } else {
        setError(describe(caught));
      }
    } finally {
      setBusy(false);
    }
  }

  if (!status) {
    return (
      <section data-testid="publish-panel">
        {error ? <p data-testid="publish-error">{error}</p> : <p>Loading publication state…</p>}
      </section>
    );
  }

  const can = (to: string) => status.allowedTransitions.includes(to);

  return (
    <section data-testid="publish-panel">
      <h2>Publishing</h2>

      <p>
        <span data-testid="publication-status" data-status={status.publicationStatus}>
          {statusLabels[status.publicationStatus] ?? status.publicationStatus}
        </span>
        {status.publishedVersionNumber !== null ? (
          <span data-testid="published-version"> · version {status.publishedVersionNumber}</span>
        ) : null}
        {status.hasUnpublishedChanges ? (
          <span data-testid="unpublished-changes"> · has unpublished changes</span>
        ) : null}
      </p>

      {error ? <p data-testid="publish-error">{error}</p> : null}

      {checklist ? (
        <ul data-testid="publish-checklist" data-passed={String(checklist.passed)}>
          {checklist.items.map((item) => (
            <li key={item.id} data-testid={`checklist-${item.id}`} data-passed={String(item.passed)}>
              <strong>{item.passed ? 'PASS' : 'FAIL'}</strong> {item.requirement}
              <br />
              <span data-testid={`checklist-reason-${item.id}`}>{item.reason}</span>
              {item.offenders.length > 0 ? (
                <ul data-testid={`checklist-offenders-${item.id}`}>
                  {item.offenders.map((offender) => (
                    <li key={offender}>{offender}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <JobProgress
        jobId={jobId}
        onSettled={() => {
          setJobId(null);
          void load();
        }}
      />

      <div>
        {isOwner && can('publishing') ? (
          <button type="button" data-testid="publish" disabled={busy} onClick={() => void publish()}>
            {publishLabel(status)}
          </button>
        ) : null}

        {isOwner && can('unpublished') ? (
          <button
            type="button"
            data-testid="unpublish"
            disabled={busy}
            onClick={() => void transition('unpublish')}
          >
            Unpublish
          </button>
        ) : null}

        {can('in_review') ? (
          <button
            type="button"
            data-testid="submit-review"
            disabled={busy}
            onClick={() => void transition('submit-review')}
          >
            Submit for review
          </button>
        ) : null}

        {isOwner && status.publicationStatus === 'in_review' ? (
          <button
            type="button"
            data-testid="return-to-draft"
            disabled={busy}
            onClick={() => void transition('return-to-draft')}
          >
            Return to draft
          </button>
        ) : null}

        {isOwner && can('archived') ? (
          <button
            type="button"
            data-testid="archive"
            disabled={busy}
            onClick={() => void transition('archive')}
          >
            Archive
          </button>
        ) : null}
      </div>
    </section>
  );
}

function describe(caught: unknown): string {
  if (caught instanceof ApiError) {
    return caught.failure.reason ?? caught.failure.errorCode ?? 'Request failed';
  }
  return (caught as Error).message;
}
