'use client';

import { useCallback, useRef, useState } from 'react';
import { apiBaseUrl, ApiError, apiFetch } from '../../../lib/api';
import type { ImportPlanResult, JobSnapshot } from '../../../lib/job-types';
import { JobProgress } from '../../../components/job-progress';

/**
 * §5.2 curriculum import.
 *
 * FR-IMP-02: the commit action stays disabled until a dry run has succeeded for
 * the payload currently in the editor, and a single keystroke disables it again.
 * The gate is in the browser, exactly as FR-IMP-02 words it — the API accepts any
 * well-formed commit and the commit job re-validates and re-diffs from scratch,
 * so nothing unsafe depends on this.
 */

type Phase = 'idle' | 'dry-run' | 'commit';

interface Issue {
  path: string;
  message: string;
}

export default function ImportPage() {
  const [payload, setPayload] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [jobId, setJobId] = useState<string | null>(null);
  const [plan, setPlan] = useState<ImportPlanResult | null>(null);
  const [committed, setCommitted] = useState<ImportPlanResult | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [failure, setFailure] = useState<string | null>(null);

  /** The payload the successful dry run was for. Commit is gated on it matching. */
  const [previewedPayload, setPreviewedPayload] = useState<string | null>(null);

  /**
   * What the in-flight job was started for. A ref rather than state: the SSE
   * callback needs the value at settle time, and re-rendering on it would
   * restart the subscription.
   */
  const inFlight = useRef<{ phase: Exclude<Phase, 'idle'>; forPayload: string } | null>(null);

  const commitEnabled = plan !== null && previewedPayload === payload && phase === 'idle';

  const onPayloadChange = (next: string) => {
    setPayload(next);
    // Editing invalidates the preview: FR-IMP-02 gates commit on a dry run for
    // the payload *currently* in the editor.
    if (next !== previewedPayload) {
      setPlan(null);
      setPreviewedPayload(null);
    }
  };

  const settled = useCallback(
    (snapshot: JobSnapshot, startedPhase: Phase, forPayload: string) => {
      setPhase('idle');
      if (snapshot.jobStatus !== 'succeeded') {
        setFailure(snapshot.errorMessage ?? `Job ${snapshot.jobStatus}`);
        return;
      }
      const result = snapshot.result as ImportPlanResult | null;
      if (!result) return;
      if (startedPhase === 'dry-run') {
        setPlan(result);
        setPreviewedPayload(forPayload);
      } else {
        setCommitted(result);
        setPlan(null);
        setPreviewedPayload(null);
      }
    },
    [],
  );

  async function start(next: Exclude<Phase, 'idle'>) {
    setFailure(null);
    setIssues([]);
    setCommitted(null);
    setJobId(null);

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch (error) {
      setFailure(`That is not valid JSON: ${(error as Error).message}`);
      return;
    }

    const path = next === 'dry-run' ? '/admin/courses/import/dry-run' : '/admin/courses/import';
    setPhase(next);
    const forPayload = payload;
    inFlight.current = null;

    try {
      const response = await apiFetch<{ jobId: string }>(path, {
        method: 'POST',
        body: JSON.stringify(parsed),
      });
      inFlight.current = { phase: next, forPayload };
      // The stream drives the rest; see the JobProgress callback below.
      setJobId(response.jobId);
    } catch (error) {
      setPhase('idle');
      if (error instanceof ApiError) {
        setIssues([...(error.failure.issues ?? [])]);
        setFailure(error.failure.errorCode ?? `Request failed (${error.failure.status})`);
        return;
      }
      setFailure((error as Error).message);
    }
  }

  return (
    <section>
      <h1>Import a curriculum outline</h1>
      <p>
        Paste the JSON your AI account produced.{' '}
        <a href={`${apiBaseUrl()}/api/admin/import-template`} data-testid="template-download">
          Download the prompt template
        </a>{' '}
        if you have not already.
      </p>

      <textarea
        data-testid="payload"
        aria-label="Import payload"
        value={payload}
        onChange={(event) => onPayloadChange(event.target.value)}
        rows={16}
        style={{ width: '100%', fontFamily: 'monospace', fontSize: '0.85rem' }}
      />

      <div style={{ display: 'flex', gap: '0.75rem', margin: '0.75rem 0' }}>
        <button
          type="button"
          data-testid="dry-run"
          onClick={() => void start('dry-run')}
          disabled={phase !== 'idle' || payload.trim() === ''}
        >
          Run dry run
        </button>
        <button
          type="button"
          data-testid="commit"
          onClick={() => void start('commit')}
          disabled={!commitEnabled}
        >
          Commit import
        </button>
      </div>

      <JobProgress
        jobId={jobId}
        onSettled={(snapshot) => {
          const context = inFlight.current;
          inFlight.current = null;
          settled(snapshot, context?.phase ?? 'dry-run', context?.forPayload ?? '');
        }}
      />

      {failure ? (
        <p data-testid="failure" role="alert" style={{ color: '#b00' }}>
          {failure}
        </p>
      ) : null}

      {issues.length > 0 ? (
        <table data-testid="issues">
          <caption>Every problem found, with its JSON path</caption>
          <thead>
            <tr>
              <th scope="col">Path</th>
              <th scope="col">Problem</th>
            </tr>
          </thead>
          <tbody>
            {issues.map((issue) => (
              <tr key={`${issue.path}:${issue.message}`}>
                <td>
                  <code>{issue.path}</code>
                </td>
                <td>{issue.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {plan ? <PlanTable plan={plan} testId="preview" heading="Dry run preview" /> : null}
      {committed ? <PlanTable plan={committed} testId="applied" heading="Imported" /> : null}
    </section>
  );
}

function PlanTable({
  plan,
  testId,
  heading,
}: {
  plan: ImportPlanResult;
  testId: string;
  heading: string;
}) {
  const rows: Array<[string, number]> = [
    ['Chapters to create', plan.counts.chaptersCreated],
    ['Chapters to update', plan.counts.chaptersUpdated],
    ['Chapters to delete', plan.counts.chaptersDeleted],
    ['Lessons to create', plan.counts.lessonsCreated],
    ['Lessons to update', plan.counts.lessonsUpdated],
    ['Lessons to delete', plan.counts.lessonsDeleted],
    ['Conflicts', plan.counts.conflicts],
  ];

  return (
    <section data-testid={testId}>
      <h2>{heading}</h2>
      <p>
        Course <code>{plan.course.slug}</code> — {plan.course.action}
        {plan.course.isPublished ? ' (published: learners keep the last published version)' : ''}.
        Category <code>{plan.category.slug}</code> — {plan.category.action}.
      </p>
      <table>
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label}>
              <th scope="row" style={{ textAlign: 'left', paddingRight: '1rem' }}>
                {label}
              </th>
              <td data-testid={`${testId}-${label.replace(/\s+/g, '-').toLowerCase()}`}>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {plan.conflicts.length > 0 ? (
        <>
          <h3>Conflicts</h3>
          <ul data-testid={`${testId}-conflicts`}>
            {plan.conflicts.map((conflict, index) => (
              <li key={`${conflict.kind}-${conflict.lessonId ?? conflict.chapterId ?? index}`}>
                <strong>{conflict.title}</strong> — {conflict.reason}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
