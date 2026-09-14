import Link from 'next/link';
import { ApiError } from '../../../lib/api';
import { isSignedIn, serverApiFetch } from '../../../lib/server-api';
import {
  describeRefusal,
  describeWarning,
  formatVietnamDate,
  formatVnd,
  type QuoteView,
} from '../../../lib/commerce-types';
import { PayButton } from '../../../components/checkout/pay-button';
import { DiscountField } from '../../../components/checkout/discount-field';

/**
 * FR-COM-02's confirm page: what a learner is about to buy, before any redirect.
 *
 * Per-learner — the resulting expiry stacks onto THEIR grant (§7.4), and the
 * overlap warnings read THEIR grants — so it is never cached, and the course page
 * that links here stays ISR and anonymous.
 *
 * A refusal the server reports in `blockedBy` is shown in words with NO pay
 * button, rather than letting the click fail.
 */
export const dynamic = 'force-dynamic';

export default async function CheckoutPage({
  params,
  searchParams,
}: {
  params: Promise<{ productId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { productId } = await params;
  const here = `/checkout/${encodeURIComponent(productId)}`;
  const rawCode = (await searchParams)['code'];
  const enteredCode = typeof rawCode === 'string' && rawCode.trim() ? rawCode.trim() : undefined;

  if (!(await isSignedIn())) return <SignInPrompt callbackPath={here} />;

  let quote: QuoteView;
  try {
    const query = new URLSearchParams({ productId });
    if (enteredCode) query.set('discountCode', enteredCode);
    quote = await serverApiFetch<QuoteView>(`/checkout/quote?${query.toString()}`, {
      cache: 'no-store',
    });
  } catch (error) {
    if (error instanceof ApiError && error.failure.status === 401) {
      return <SignInPrompt callbackPath={here} />;
    }
    if (error instanceof ApiError && [400, 403, 404].includes(error.failure.status)) {
      return (
        <main className="reading-main">
          <h1 className="text-2xl font-semibold">Thanh toán</h1>
          <p className="mt-4 text-neutral-700" data-testid="checkout-not-for-sale">
            {error.failure.status === 403
              ? 'Tài khoản này không thể mua khoá học.'
              : 'Sản phẩm này hiện không được bán.'}
          </p>
          <p className="mt-4">
            <Link href="/" className="underline">
              Xem danh mục khoá học
            </Link>
          </p>
        </main>
      );
    }
    throw error;
  }

  const target =
    quote.target.scopeType === 'course'
      ? quote.target.courseTitle
      : `Trọn bộ ${quote.target.categoryName}`;
  const discounted = quote.amount !== quote.listPriceAmount;

  return (
    <main className="reading-main" data-testid="checkout-page">
      <h1 className="text-2xl font-semibold">Xác nhận thanh toán</h1>

      <section className="mt-6 rounded border border-neutral-300 p-4">
        <p className="text-xs uppercase tracking-wide text-neutral-500">
          {quote.product.productType === 'single_course' ? 'Khoá học' : 'Trọn bộ'}
        </p>
        <h2 className="mt-1 text-lg font-medium" data-testid="checkout-product">
          {quote.product.displayName}
        </h2>
        <p className="text-sm text-neutral-600">{target}</p>

        <dl className="mt-4 space-y-2 text-sm">
          <div className="flex flex-wrap justify-between gap-2">
            <dt className="text-neutral-600">Giá</dt>
            <dd data-testid="checkout-amount" className="text-base font-medium">
              {discounted ? (
                <span className="mr-2 text-neutral-500 line-through" data-testid="checkout-list-price">
                  {formatVnd(quote.listPriceAmount, quote.product.currencyCode)}
                </span>
              ) : null}
              {formatVnd(quote.amount, quote.product.currencyCode)}
            </dd>
          </div>
          <div className="flex flex-wrap justify-between gap-2">
            <dt className="text-neutral-600">Thời hạn truy cập</dt>
            <dd>{quote.product.accessDurationDays} ngày</dd>
          </div>
          {quote.currentExpiresAt ? (
            <div className="flex flex-wrap justify-between gap-2">
              <dt className="text-neutral-600">Hạn hiện tại</dt>
              <dd data-testid="checkout-current-expiry">{formatVietnamDate(quote.currentExpiresAt)}</dd>
            </div>
          ) : null}
          <div className="flex flex-wrap justify-between gap-2">
            <dt className="text-neutral-600">{quote.isRenewal ? 'Hạn sau khi gia hạn' : 'Truy cập đến'}</dt>
            <dd data-testid="checkout-resulting-expiry" data-iso={quote.resultingExpiresAt}>
              {formatVietnamDate(quote.resultingExpiresAt)}
            </dd>
          </div>
        </dl>

        {quote.isRenewal ? (
          <p className="mt-3 text-sm text-neutral-600">
            Thời gian còn lại của bạn được giữ nguyên và cộng thêm một kỳ mới.
          </p>
        ) : null}
      </section>

      {quote.warnings.length > 0 ? (
        <ul className="mt-4 space-y-2" data-testid="checkout-warnings">
          {quote.warnings.map((warning) => (
            <li
              key={warning.code}
              className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
              data-testid="checkout-warning"
              data-code={warning.code}
            >
              {describeWarning(warning)}
            </li>
          ))}
        </ul>
      ) : null}

      {quote.paymentAvailable && !quote.blockedBy ? (
        <DiscountField productId={quote.product.productId} enteredCode={enteredCode} quote={quote} />
      ) : null}

      {!quote.paymentAvailable ? (
        <p className="mt-6 rounded border border-neutral-300 p-4 text-sm" data-testid="checkout-closed">
          {describeRefusal({ errorCode: 'PAYMENT_PROVIDER_UNAVAILABLE' })}
        </p>
      ) : quote.blockedBy ? (
        <p
          className="mt-6 rounded border border-neutral-300 p-4 text-sm"
          data-testid="checkout-blocked"
          data-code={quote.blockedBy.errorCode}
        >
          {describeRefusal(quote.blockedBy)}
        </p>
      ) : (
        // Only a code the server accepted travels to the POST, which re-checks it.
        <PayButton
          productId={quote.product.productId}
          {...(quote.discount ? { discountCode: quote.discount.code } : {})}
        />
      )}
    </main>
  );
}

function SignInPrompt({ callbackPath }: { callbackPath: string }) {
  return (
    <main className="reading-main">
      <h1 className="text-2xl font-semibold">Thanh toán</h1>
      <p className="mt-4 text-neutral-700">
        Bạn cần đăng nhập để mua quyền truy cập. Sau khi đăng nhập, bạn sẽ quay lại trang này.
      </p>
      <p className="mt-4">
        <Link
          href={`/signin?callbackUrl=${encodeURIComponent(callbackPath)}`}
          className="inline-block rounded bg-neutral-900 px-4 py-2 text-white"
          data-testid="checkout-signin"
        >
          Đăng nhập
        </Link>
      </p>
    </main>
  );
}
