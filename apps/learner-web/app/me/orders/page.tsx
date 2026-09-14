import Link from 'next/link';
import { isSignedIn, serverApiFetch } from '../../../lib/server-api';
import {
  formatVietnamDateTime,
  formatVnd,
  type OrderListView,
  type OrderStatus,
} from '../../../lib/commerce-types';

/**
 * The learner's own orders — every status, newest first.
 *
 * Carries no provider reference: that identifier is between the API and the
 * gateway. Per-learner, so never cached.
 */
export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<OrderStatus, string> = {
  pending: 'Đang chờ thanh toán',
  paid: 'Đã thanh toán',
  failed: 'Không thành công',
  refunded: 'Đã hoàn tiền',
};

export default async function MyOrdersPage() {
  if (!(await isSignedIn())) {
    return (
      <main className="wide-main">
        <h1 className="text-2xl font-semibold">Đơn hàng của tôi</h1>
        <p className="mt-4 text-neutral-700" data-testid="my-orders-signin">
          <Link href={`/signin?callbackUrl=${encodeURIComponent('/me/orders')}`} className="underline">
            Đăng nhập
          </Link>{' '}
          để xem các đơn hàng của bạn.
        </p>
      </main>
    );
  }

  const orders = await serverApiFetch<OrderListView>('/me/orders?pageSize=50', {
    cache: 'no-store',
  }).catch(() => null);

  return (
    <main className="wide-main">
      <h1 className="text-2xl font-semibold">Đơn hàng của tôi</h1>

      {orders === null ? (
        <p className="mt-4 text-neutral-700">Không tải được đơn hàng. Vui lòng thử lại.</p>
      ) : orders.items.length === 0 ? (
        <p className="mt-4 text-neutral-700" data-testid="my-orders-empty">
          Bạn chưa có đơn hàng nào.
        </p>
      ) : (
        <ul className="mt-6 space-y-3" data-testid="my-orders-list">
          {orders.items.map((order) => {
            const discounted = order.amount !== order.listPriceAmount;
            return (
              <li
                key={order.orderId}
                className="rounded border border-neutral-200 p-4"
                data-testid="my-order"
                data-order-id={order.orderId}
                data-status={order.orderStatus}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="font-medium">{order.productName}</h2>
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${
                      order.orderStatus === 'paid'
                        ? 'bg-emerald-100 text-emerald-900'
                        : order.orderStatus === 'pending'
                          ? 'bg-neutral-100 text-neutral-800'
                          : 'bg-red-100 text-red-900'
                    }`}
                  >
                    {STATUS_LABEL[order.orderStatus]}
                  </span>
                </div>
                <p className="mt-1 text-sm text-neutral-600">
                  {order.target.courseTitle ?? `Trọn bộ ${order.target.categoryName}`}
                </p>
                <p className="mt-2 text-sm">
                  {discounted ? (
                    <span className="mr-2 text-neutral-500 line-through">
                      {formatVnd(order.listPriceAmount)}
                    </span>
                  ) : null}
                  <span data-testid="my-order-amount">{formatVnd(order.amount)}</span>
                  {order.discountCode ? (
                    <span className="ml-2 text-neutral-600">· mã {order.discountCode}</span>
                  ) : null}
                </p>
                <p className="mt-1 text-xs text-neutral-500">
                  Tạo lúc {formatVietnamDateTime(order.createdAt)}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
