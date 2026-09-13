'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, apiFetch } from '../../lib/api';

/**
 * FR-REQ-01: submit a topic.
 *
 * The cap is enforced by the API and only reported here. The number is read off
 * the 409 body rather than passed in, so it lives in exactly one place —
 * TOPIC_REQUEST_PENDING_CAP in the API's environment — and the form cannot
 * disagree with the server about what the limit is.
 */
export function SubmitForm() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    try {
      await apiFetch('/topic-requests', {
        method: 'POST',
        body: JSON.stringify({
          requestedTopicTitle: title.trim(),
          ...(description.trim() ? { requestDescription: description.trim() } : {}),
        }),
      });
      setTitle('');
      setDescription('');
      // The board is server-rendered; refresh re-reads it rather than
      // reconstructing the new row in the client and risking a different shape.
      router.refresh();
    } catch (error) {
      setFailure(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="mt-6 rounded border border-neutral-200 p-4">
      <h2 className="font-semibold">Đề xuất một chủ đề</h2>
      <label className="mt-3 block text-sm" htmlFor="request-title">
        Chủ đề bạn muốn học
      </label>
      <input
        id="request-title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        maxLength={120}
        required
        minLength={3}
        data-testid="request-title"
        className="mt-1 w-full rounded border border-neutral-300 px-3 py-2"
      />
      <label className="mt-3 block text-sm" htmlFor="request-description">
        Mô tả thêm (không bắt buộc)
      </label>
      <textarea
        id="request-description"
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        maxLength={1000}
        rows={3}
        data-testid="request-description"
        className="mt-1 w-full rounded border border-neutral-300 px-3 py-2"
      />
      <button
        type="submit"
        disabled={busy || title.trim().length < 3}
        data-testid="request-submit"
        className="mt-3 rounded bg-neutral-900 px-4 py-2 text-white disabled:opacity-50"
      >
        {busy ? 'Đang gửi…' : 'Gửi đề xuất'}
      </button>
      {failure ? (
        <p className="mt-3 text-sm text-red-700" data-testid="request-error" role="alert">
          {failure}
        </p>
      ) : null}
    </form>
  );
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.failure.errorCode === 'TOPIC_REQUEST_LIMIT_REACHED') {
      const cap = error.failure.body?.['pendingCap'];
      const limit = typeof cap === 'number' ? cap : null;
      return limit === null
        ? 'Bạn đã đạt giới hạn đề xuất đang chờ duyệt. Hãy rút bớt một đề xuất trước khi gửi thêm.'
        : `Bạn đang có ${limit} đề xuất chờ duyệt. Hãy rút bớt một đề xuất trước khi gửi thêm.`;
    }
    if (error.failure.status === 401) {
      return 'Bạn cần đăng nhập để gửi đề xuất.';
    }
  }
  return 'Không gửi được đề xuất. Vui lòng thử lại.';
}
