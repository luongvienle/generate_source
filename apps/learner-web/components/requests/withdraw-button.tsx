'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '../../lib/api';

/**
 * FR-REQ-01: withdraw an own request while it is still pending.
 *
 * No confirmation dialog: `window.confirm` blocks the page and, in the browser
 * suite, blocks the automation driving it. The action is reversible by
 * resubmitting and destroys only the caller's own row.
 */
export function WithdrawButton({ requestId }: { requestId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const withdraw = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await apiFetch(`/topic-requests/${requestId}`, { method: 'DELETE' });
      router.refresh();
    } catch {
      setFailure('Không rút được đề xuất. Vui lòng thử lại.');
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={withdraw}
        disabled={busy}
        data-testid="withdraw-button"
        className="rounded border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-50 disabled:opacity-50"
      >
        {busy ? 'Đang rút…' : 'Rút đề xuất'}
      </button>
      {failure ? (
        <span className="mt-1 block text-xs text-red-700" role="alert">
          {failure}
        </span>
      ) : null}
    </>
  );
}
