import Link from 'next/link';
import type { QuoteView } from '../../lib/commerce-types';

/**
 * The confirm page's discount-code field.
 *
 * A plain GET form: applying a code re-renders the page with `?code=`, and the
 * SERVER re-quotes with it. No client state holds a price the server did not
 * compute, and the POST still re-evaluates the code from scratch.
 *
 * A code that does not apply is explained, and the amount above falls back to
 * the list price — the learner can remove the code and still pay.
 */

const MESSAGES: Record<string, string> = {
  DISCOUNT_CODE_NOT_FOUND: 'Mã giảm giá không tồn tại hoặc đã ngừng áp dụng.',
  DISCOUNT_CODE_OUTSIDE_WINDOW: 'Mã giảm giá này chưa bắt đầu hoặc đã hết hạn.',
  DISCOUNT_CODE_NOT_APPLICABLE: 'Mã giảm giá này không áp dụng cho sản phẩm này.',
  DISCOUNT_CODE_EXHAUSTED: 'Mã giảm giá này đã hết lượt sử dụng.',
  DISCOUNT_CODE_ALREADY_USED: 'Bạn đã sử dụng mã giảm giá này rồi.',
  DISCOUNT_CODE_NEW_PURCHASES_ONLY:
    'Mã giảm giá này chỉ dành cho lần mua mới, không áp dụng khi gia hạn quyền truy cập đang còn hiệu lực.',
};

export function DiscountField({
  productId,
  enteredCode,
  quote,
}: {
  productId: string;
  enteredCode: string | undefined;
  quote: QuoteView;
}) {
  return (
    <section className="mt-4 rounded border border-neutral-200 p-4" data-testid="checkout-discount">
      <form method="get" action={`/checkout/${encodeURIComponent(productId)}`} className="flex flex-wrap items-end gap-2">
        <label className="flex-1 text-sm" htmlFor="discount-code">
          Mã giảm giá
          <input
            id="discount-code"
            name="code"
            defaultValue={enteredCode ?? ''}
            maxLength={64}
            autoComplete="off"
            data-testid="checkout-discount-input"
            className="mt-1 w-full rounded border border-neutral-300 px-3 py-2 uppercase"
          />
        </label>
        <button
          type="submit"
          data-testid="checkout-discount-apply"
          className="rounded border border-neutral-900 px-4 py-2 text-sm"
        >
          Áp dụng
        </button>
      </form>

      {quote.discount ? (
        <p className="mt-2 text-sm text-emerald-800" data-testid="checkout-discount-applied">
          Đã áp dụng mã {quote.discount.code}: giảm {quote.discount.percentOff}%.{' '}
          <Link href={`/checkout/${encodeURIComponent(productId)}`} className="underline">
            Bỏ mã
          </Link>
        </p>
      ) : null}
      {quote.discountError ? (
        <p
          className="mt-2 text-sm text-red-700"
          data-testid="checkout-discount-error"
          data-code={quote.discountError.errorCode}
          role="alert"
        >
          {MESSAGES[quote.discountError.errorCode] ?? 'Không áp dụng được mã giảm giá này.'}
        </p>
      ) : null}
    </section>
  );
}
