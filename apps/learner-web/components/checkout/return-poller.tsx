'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ApiError, apiFetch } from '../../lib/api';
import type { OrderView } from '../../lib/commerce-types';

/**
 * The return page's one job: ask what happened to the order.
 *
 * A browser redirect never grants access (FR-COM-03). The gateway sends the
 * learner back here whatever the outcome, and the order settles only when the
 * provider's verified webhook arrives — which may be before this page loads, or a
 * few seconds after. So the page polls `GET /me/orders/:orderId` and reports what
 * the server says. It writes nothing, and nothing about access depends on it
 * having loaded at all.
 */

const POLL_INTERVAL_MILLISECONDS = 2_000;
const POLL_WINDOW_MILLISECONDS = 60_000;

type State =
  | { kind: 'checking' }
  | { kind: 'paid'; order: OrderView }
  | { kind: 'failed'; order: OrderView }
  | { kind: 'pending' }
  | { kind: 'not-found' }
  | { kind: 'signed-out' };

export function ReturnPoller({ orderId }: { orderId: string }) {
  const [state, setState] = useState<State>({ kind: 'checking' });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + POLL_WINDOW_MILLISECONDS;

    const poll = async () => {
      try {
        const order = await apiFetch<OrderView>(`/me/orders/${encodeURIComponent(orderId)}`, {
          cache: 'no-store',
        });
        if (cancelled) return;
        if (order.orderStatus === 'paid') return setState({ kind: 'paid', order });
        if (order.orderStatus === 'failed' || order.orderStatus === 'refunded') {
          return setState({ kind: 'failed', order });
        }
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.failure.status === 404) {
          return setState({ kind: 'not-found' });
        }
        if (error instanceof ApiError && error.failure.status === 401) {
          return setState({ kind: 'signed-out' });
        }
        // A transient failure is retried like a pending order.
      }
      if (Date.now() >= deadline) return setState({ kind: 'pending' });
      timer = setTimeout(poll, POLL_INTERVAL_MILLISECONDS);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [orderId]);

  switch (state.kind) {
    case 'checking':
      return (
        <p className="mt-4 text-neutral-700" data-testid="return-checking" role="status">
          Đang xác nhận thanh toán…
        </p>
      );
    case 'paid': {
      const { target } = state.order;
      const href = target.courseSlug ? `/courses/${target.courseSlug}` : `/categories/${target.categorySlug}`;
      return (
        <div className="mt-4 rounded border border-emerald-300 bg-emerald-50 p-4" data-testid="return-paid">
          <p className="font-medium text-emerald-900">Thanh toán thành công.</p>
          <p className="mt-2 text-sm text-emerald-900">
            Bạn đã có quyền truy cập {target.courseTitle ?? `trọn bộ ${target.categoryName}`}.
          </p>
          <p className="mt-3 flex flex-wrap gap-3">
            <Link href={href} className="rounded bg-neutral-900 px-4 py-2 text-sm text-white" data-testid="return-course-link">
              Vào học
            </Link>
            <Link href="/me/courses" className="rounded border border-neutral-300 px-4 py-2 text-sm">
              Khoá của tôi
            </Link>
          </p>
        </div>
      );
    }
    case 'failed':
      return (
        <div className="mt-4 rounded border border-red-300 bg-red-50 p-4" data-testid="return-failed">
          <p className="font-medium text-red-900">Thanh toán không thành công.</p>
          <p className="mt-2 text-sm text-red-900">Bạn chưa bị trừ tiền cho đơn hàng này.</p>
          <p className="mt-3">
            <Link
              href={`/checkout/${state.order.productId}`}
              className="rounded bg-neutral-900 px-4 py-2 text-sm text-white"
              data-testid="return-retry"
            >
              Thử lại
            </Link>
          </p>
        </div>
      );
    case 'pending':
      return (
        <div className="mt-4 rounded border border-neutral-300 p-4" data-testid="return-pending">
          <p className="font-medium">Đơn hàng đang được xử lý.</p>
          <p className="mt-2 text-sm text-neutral-700">
            Quyền truy cập sẽ có ngay khi cổng thanh toán xác nhận. Bạn có thể theo dõi trong mục đơn
            hàng.
          </p>
          <p className="mt-3">
            <Link href="/me/orders" className="underline">
              Xem đơn hàng của tôi
            </Link>
          </p>
        </div>
      );
    case 'not-found':
      return (
        <p className="mt-4 text-neutral-700" data-testid="return-not-found">
          Không tìm thấy đơn hàng này.
        </p>
      );
    case 'signed-out':
      return (
        <p className="mt-4 text-neutral-700" data-testid="return-signed-out">
          Phiên đăng nhập đã hết hạn.{' '}
          <Link href={`/signin?callbackUrl=${encodeURIComponent(`/checkout/return?orderId=${orderId}`)}`} className="underline">
            Đăng nhập lại
          </Link>{' '}
          để xem kết quả thanh toán.
        </p>
      );
  }
}
