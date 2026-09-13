'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ApiError, apiFetch } from '../../lib/api';

/**
 * FR-REQ-01's upvote control.
 *
 * Three states, and the server decides all of them:
 *
 *  - signed out — a link to /signin, not a disabled button. The endpoint would
 *    401 and there is nothing useful to say about that after the fact.
 *  - the caller's own request — disabled, with the reason visible. `viewerIsRequester`
 *    describes the reader, so this leaks nothing: only the submitter ever sees it.
 *  - anyone else's — a toggle.
 *
 * After a successful toggle it calls `router.refresh()` rather than patching a
 * local count. The board is server-rendered and `force-dynamic`; re-reading it is
 * what keeps the number on screen equal to the number in the column.
 */
export function VoteButton({
  requestId,
  upvoteCount,
  viewerHasVoted,
  viewerIsRequester,
  signedIn,
}: {
  requestId: string;
  upvoteCount: number;
  viewerHasVoted: boolean;
  viewerIsRequester: boolean;
  signedIn: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  if (!signedIn) {
    return (
      <Link
        href="/signin"
        data-testid="vote-signin"
        className="shrink-0 rounded border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-50"
      >
        ▲ {upvoteCount}
      </Link>
    );
  }

  if (viewerIsRequester) {
    return (
      <span
        data-testid="vote-own"
        title="Bạn không thể bình chọn cho đề xuất của chính mình"
        className="shrink-0 cursor-not-allowed rounded border border-neutral-200 px-3 py-1 text-sm text-neutral-400"
      >
        ▲ {upvoteCount}
      </span>
    );
  }

  const toggle = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await apiFetch(`/topic-requests/${requestId}/vote`, { method: 'POST' });
      router.refresh();
    } catch (error) {
      setFailure(
        error instanceof ApiError && error.failure.errorCode === 'TOPIC_REQUEST_NOT_PENDING'
          ? 'Đề xuất này đã được duyệt nên không nhận thêm bình chọn.'
          : 'Không bình chọn được. Vui lòng thử lại.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="shrink-0 text-right">
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        aria-pressed={viewerHasVoted}
        data-testid="vote-button"
        data-voted={viewerHasVoted ? 'true' : 'false'}
        className={`rounded border px-3 py-1 text-sm disabled:opacity-50 ${
          viewerHasVoted
            ? 'border-neutral-900 bg-neutral-900 text-white'
            : 'border-neutral-300 hover:bg-neutral-50'
        }`}
      >
        ▲ {upvoteCount}
      </button>
      {failure ? (
        <span className="mt-1 block text-xs text-red-700" role="alert">
          {failure}
        </span>
      ) : null}
    </span>
  );
}
