'use client';

import { useState } from 'react';
import { ApiError, apiFetch } from '../../lib/api';
import { describeRefusal, type CheckoutRedirectView } from '../../lib/commerce-types';

/**
 * FR-COM-02: create the pending order and go to the provider.
 *
 * The POST re-evaluates everything the confirm page showed — the server never
 * trusts a quote — so a refusal can still arrive here if something changed in
 * between, and is shown in words.
 *
 * Going to `redirectUrl` grants nothing (FR-COM-03). Access arrives only when the
 * provider's verified webhook settles the order; the return page asks for that
 * outcome rather than assuming it.
 */
export function PayButton({ productId, discountCode }: { productId: string; discountCode?: string }) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const pay = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const redirect = await apiFetch<CheckoutRedirectView>('/checkout', {
        method: 'POST',
        body: JSON.stringify({ productId, ...(discountCode ? { discountCode } : {}) }),
      });
      window.location.assign(redirect.redirectUrl);
    } catch (error) {
      setFailure(messageFor(error));
      setBusy(false);
    }
  };

  return (
    <div className="mt-6">
      <button
        type="button"
        onClick={pay}
        disabled={busy}
        data-testid="checkout-pay"
        className="w-full rounded bg-neutral-900 px-4 py-3 text-white disabled:opacity-50 sm:w-auto"
      >
        {busy ? 'Đang chuyển đến cổng thanh toán…' : 'Thanh toán'}
      </button>
      {failure ? (
        <p className="mt-3 text-sm text-red-700" data-testid="checkout-pay-error" role="alert">
          {failure}
        </p>
      ) : null}
    </div>
  );
}

function messageFor(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Không thể thanh toán lúc này. Vui lòng thử lại.';
  if (error.failure.status === 401) return 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.';
  const body = error.failure.body ?? {};
  return describeRefusal({
    errorCode: error.failure.errorCode ?? '',
    renewableFrom: typeof body['renewableFrom'] === 'string' ? body['renewableFrom'] : undefined,
  });
}
