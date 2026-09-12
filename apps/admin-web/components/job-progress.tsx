'use client';

import { useEffect, useState } from 'react';
import { apiBaseUrl } from '../lib/api';
import { isTerminal, type JobSnapshot } from '../lib/job-types';

/**
 * NFR-04 progress over server-sent events.
 *
 * EventSource must be constructed with withCredentials so the Auth.js session
 * cookie is attached; the stream is owner-only and would otherwise 401.
 */
export function JobProgress({
  jobId,
  onSettled,
}: {
  jobId: string | null;
  onSettled?: (snapshot: JobSnapshot) => void;
}) {
  const [snapshot, setSnapshot] = useState<JobSnapshot | null>(null);

  useEffect(() => {
    if (!jobId) {
      setSnapshot(null);
      return;
    }

    const source = new EventSource(`${apiBaseUrl()}/api/admin/jobs/${jobId}/stream`, {
      withCredentials: true,
    });

    source.onmessage = (event: MessageEvent<string>) => {
      const next = JSON.parse(event.data) as JobSnapshot;
      setSnapshot(next);
      if (isTerminal(next.jobStatus)) {
        source.close();
        onSettled?.(next);
      }
    };
    // The server closes the stream once the job settles; the browser would
    // otherwise reconnect and re-deliver the terminal event forever.
    source.onerror = () => source.close();

    return () => source.close();
    // onSettled is intentionally excluded: callers pass an inline closure, and
    // re-subscribing on every render would restart the stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  if (!jobId) return null;

  const status = snapshot?.jobStatus ?? 'queued';
  return (
    <p data-testid="job-progress" data-status={status} role="status">
      <strong>Job {jobId}:</strong> {status}
      {snapshot?.attemptCount ? ` (attempt ${snapshot.attemptCount})` : ''}
      {snapshot?.errorMessage ? (
        <>
          {' — '}
          <span data-testid="job-error">{snapshot.errorMessage}</span>
        </>
      ) : null}
    </p>
  );
}
