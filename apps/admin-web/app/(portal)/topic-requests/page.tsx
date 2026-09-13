'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiFetch } from '../../../lib/api';
import type {
  QueueRowView,
  QueueView,
  RequestStatus,
  ReviewBody,
} from '../../../lib/topic-request-types';

/**
 * §9.2's review queue — FR-REQ-01's owner half.
 *
 * The form builds only bodies the API accepts: the course picker appears for
 * `accepted` alone, the request picker for `duplicated` alone, and the note is
 * required for `rejected`. That is convenience, not enforcement — every rule is
 * checked server-side in topic-requests-admin.service.ts before anything is
 * written, and a refused review writes neither field.
 *
 * NFR-09: admin screens target 1280 px and wider.
 */
const STATUSES: readonly RequestStatus[] = ['pending', 'accepted', 'rejected', 'duplicated'];

const STATUS_LABEL: Record<RequestStatus, string> = {
  pending: 'Pending',
  accepted: 'Accepted',
  rejected: 'Rejected',
  duplicated: 'Duplicate',
};

export default function TopicRequestsPage() {
  const [status, setStatus] = useState<RequestStatus | 'all'>('pending');
  const [sort, setSort] = useState<'upvotes' | 'newest'>('upvotes');
  const [queue, setQueue] = useState<QueueView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [openRow, setOpenRow] = useState<string | null>(null);
  /**
   * Filters the course picker only.
   *
   * It lives up here rather than inside the form because the options come back
   * on the queue response — the picker is bounded at 50 newest courses, and a
   * platform with more than that needs a search to reach the rest.
   */
  const [courseSearch, setCourseSearch] = useState('');

  const load = useCallback(async () => {
    setFailure(null);
    try {
      const query = new URLSearchParams({ status, sort, pageSize: '50' });
      if (courseSearch.trim()) query.set('courseSearch', courseSearch.trim());
      setQueue(await apiFetch<QueueView>(`/admin/topic-requests?${query.toString()}`));
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : 'Could not load the queue.');
    }
  }, [status, sort, courseSearch]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section>
      <h1 className="text-xl font-semibold">Topic requests</h1>
      <p className="mt-1 text-sm text-slate-600">
        Learner-submitted topics. Accepting one can link the course that answers it.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          Status
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as RequestStatus | 'all')}
            data-testid="queue-status"
            className="rounded border border-slate-300 px-2 py-1"
          >
            <option value="pending">Pending</option>
            <option value="accepted">Accepted</option>
            <option value="rejected">Rejected</option>
            <option value="duplicated">Duplicate</option>
            <option value="all">All</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          Sort
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as 'upvotes' | 'newest')}
            data-testid="queue-sort"
            className="rounded border border-slate-300 px-2 py-1"
          >
            <option value="upvotes">Most upvoted</option>
            <option value="newest">Newest</option>
          </select>
        </label>
        {queue ? <span className="text-slate-500">{queue.total} request(s)</span> : null}
      </div>

      {failure ? (
        <p className="mt-4 text-sm text-red-700" role="alert">
          {failure}
        </p>
      ) : null}

      {queue && queue.items.length === 0 ? (
        <p className="mt-6 text-slate-600" data-testid="queue-empty">
          Nothing in this view.
        </p>
      ) : null}

      <ul className="mt-6 space-y-3" data-testid="queue-list">
        {queue?.items.map((row) => (
          <li
            key={row.id}
            data-testid="queue-row"
            data-request-id={row.id}
            data-status={row.requestStatus}
            className="rounded border border-slate-200 p-4"
          >
            <div className="flex flex-wrap items-baseline gap-3">
              <strong className="text-base">{row.requestedTopicTitle}</strong>
              <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">
                {STATUS_LABEL[row.requestStatus]}
              </span>
              <span className="text-sm text-slate-600" data-testid="queue-count">
                ▲ {row.upvoteCount}
              </span>
              <span className="text-sm text-slate-500" data-testid="queue-email">
                {row.requestedByEmail}
              </span>
              <button
                type="button"
                onClick={() => setOpenRow(openRow === row.id ? null : row.id)}
                data-testid="queue-review-toggle"
                className="ml-auto rounded border border-slate-300 px-3 py-1 text-sm"
              >
                {openRow === row.id ? 'Close' : 'Review'}
              </button>
            </div>

            {row.requestDescription ? (
              <p className="mt-2 text-sm text-slate-700">{row.requestDescription}</p>
            ) : null}
            {row.reviewerNote ? (
              <p className="mt-2 text-sm text-slate-600">Note: {row.reviewerNote}</p>
            ) : null}
            {row.linkedCourse ? (
              <p className="mt-2 text-sm text-slate-600">Linked course: {row.linkedCourse.title}</p>
            ) : null}
            {row.requestStatus === 'duplicated' ? (
              <p className="mt-2 text-sm text-slate-600" data-testid="queue-duplicate-of">
                {/*
                  A duplicate whose target was withdrawn keeps its status and
                  loses its pointer — ON DELETE SET NULL. Render it, never throw.
                */}
                {row.duplicateOf
                  ? `Duplicate of: ${row.duplicateOf.requestedTopicTitle}`
                  : 'Duplicate of a withdrawn request'}
              </p>
            ) : null}

            {openRow === row.id ? (
              <ReviewForm
                row={row}
                queue={queue}
                courseSearch={courseSearch}
                onCourseSearch={setCourseSearch}
                onDone={() => {
                  setOpenRow(null);
                  void load();
                }}
              />
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ReviewForm({
  row,
  queue,
  courseSearch,
  onCourseSearch,
  onDone,
}: {
  row: QueueRowView;
  queue: QueueView;
  courseSearch: string;
  onCourseSearch: (value: string) => void;
  onDone: () => void;
}) {
  const [next, setNext] = useState<RequestStatus>(row.requestStatus);
  const [note, setNote] = useState(row.reviewerNote ?? '');
  const [courseId, setCourseId] = useState(row.linkedCourse?.id ?? '');
  const [duplicateOf, setDuplicateOf] = useState(row.duplicateOf?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // A duplicate may not point at itself, and chains are refused server-side.
  const duplicateTargets = queue.items.filter(
    (item) => item.id !== row.id && item.requestStatus !== 'duplicated',
  );

  const save = async () => {
    setBusy(true);
    setFailure(null);
    const body: ReviewBody = { requestStatus: next };
    if (next !== 'pending' && note.trim()) body.reviewerNote = note.trim();
    if (next === 'accepted' && courseId) body.linkedCourseId = courseId;
    if (next === 'duplicated' && duplicateOf) body.duplicateOfRequestId = duplicateOf;

    try {
      await apiFetch(`/admin/topic-requests/${row.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      onDone();
    } catch (error) {
      setFailure(explain(error));
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 border-t border-slate-200 pt-4" data-testid="review-form">
      <div className="flex flex-wrap gap-4 text-sm">
        {STATUSES.map((option) => (
          <label key={option} className="flex items-center gap-1">
            <input
              type="radio"
              name={`status-${row.id}`}
              value={option}
              checked={next === option}
              onChange={() => setNext(option)}
              data-testid={`review-status-${option}`}
            />
            {STATUS_LABEL[option]}
          </label>
        ))}
      </div>

      {next !== 'pending' ? (
        <label className="mt-3 block text-sm">
          Reviewer note{next === 'rejected' ? ' (required)' : ' (optional)'}
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={2}
            data-testid="review-note"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          />
        </label>
      ) : null}

      {next === 'accepted' ? (
        <div className="mt-3 text-sm">
          <label className="block">
            Find a course
            <input
              type="search"
              value={courseSearch}
              onChange={(event) => onCourseSearch(event.target.value)}
              placeholder="Search by title — the list shows the 50 newest"
              data-testid="review-course-search"
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
            />
          </label>
        <label className="mt-3 block text-sm">
          Link a course (optional)
          <select
            value={courseId}
            onChange={(event) => setCourseId(event.target.value)}
            data-testid="review-course"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          >
            <option value="">No course</option>
            {queue.courseOptions.map((course) => (
              <option key={course.id} value={course.id}>
                {course.levelLabel} — {course.title}
                {course.publicationStatus === 'published' ? '' : ' (not published)'}
              </option>
            ))}
          </select>
        </label>
        </div>
      ) : null}

      {next === 'duplicated' ? (
        <label className="mt-3 block text-sm">
          Duplicate of (required)
          <select
            value={duplicateOf}
            onChange={(event) => setDuplicateOf(event.target.value)}
            data-testid="review-duplicate-of"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          >
            <option value="">Choose a request</option>
            {duplicateTargets.map((item) => (
              <option key={item.id} value={item.id}>
                {item.requestedTopicTitle}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <button
        type="button"
        onClick={save}
        disabled={busy}
        data-testid="review-save"
        className="mt-4 rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
      >
        {busy ? 'Saving…' : 'Save'}
      </button>

      {failure ? (
        <p className="mt-3 text-sm text-red-700" data-testid="review-error" role="alert">
          {failure}
        </p>
      ) : null}
    </div>
  );
}

/** The server's error code decides the message; the form never guesses. */
function explain(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Could not save the review.';
  switch (error.failure.errorCode) {
    case 'TOPIC_REQUEST_NOTE_REQUIRED':
      return 'A rejected request needs a reviewer note.';
    case 'TOPIC_REQUEST_DUPLICATE_TARGET_REQUIRED':
      return 'Choose which request this duplicates.';
    case 'TOPIC_REQUEST_DUPLICATE_TARGET_INVALID':
      return 'That request cannot be the duplicate target.';
    case 'TOPIC_REQUEST_LINKED_COURSE_NOT_FOUND':
      return 'That course no longer exists.';
    case 'TOPIC_REQUEST_NOT_FOUND':
      return 'This request no longer exists.';
    default:
      return 'Could not save the review.';
  }
}
