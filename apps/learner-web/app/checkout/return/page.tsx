import Link from 'next/link';
import { isSignedIn } from '../../../lib/server-api';
import { ReturnPoller } from '../../../components/checkout/return-poller';

/**
 * Where the payment provider sends the browser afterwards, whatever the outcome.
 *
 * Arriving here grants nothing (FR-COM-03): the poller asks the API what the
 * verified webhook decided. Per-learner and time-sensitive, so never cached.
 */
export const dynamic = 'force-dynamic';

export default async function CheckoutReturnPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const orderId = (await searchParams)['orderId'];

  return (
    <main className="reading-main">
      <h1 className="text-2xl font-semibold">Kết quả thanh toán</h1>
      {typeof orderId !== 'string' || orderId.length === 0 ? (
        <p className="mt-4 text-neutral-700" data-testid="return-not-found">
          Không tìm thấy đơn hàng này.
        </p>
      ) : !(await isSignedIn()) ? (
        <p className="mt-4 text-neutral-700" data-testid="return-signed-out">
          <Link
            href={`/signin?callbackUrl=${encodeURIComponent(`/checkout/return?orderId=${orderId}`)}`}
            className="underline"
          >
            Đăng nhập
          </Link>{' '}
          để xem kết quả thanh toán.
        </p>
      ) : (
        <ReturnPoller orderId={orderId} />
      )}
    </main>
  );
}
