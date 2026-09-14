/**
 * The checkout and order shapes this app reads, mirroring
 * apps/api/src/commerce/checkout.service.ts (specs/p8a-commerce/spec.md).
 *
 * Written out rather than imported, as catalog-types.ts explains. Money is a
 * string of digits and stays one; `formatVnd` reads it for display only.
 */

export interface CheckoutWarning {
  code: 'BUNDLE_OVERLAPS_OWNED_COURSES' | 'COURSE_COVERED_BY_BUNDLE';
  courses?: Array<{ courseSlug: string; courseTitle: string }>;
  categorySlug?: string;
  categoryName?: string;
}

export interface CheckoutRefusal {
  errorCode: string;
  currentExpiresAt?: string;
  renewableFrom?: string;
}

export interface QuoteView {
  product: {
    productId: string;
    productType: 'single_course' | 'category_bundle';
    displayName: string;
    accessDurationDays: number;
    gracePeriodDays: number;
    currencyCode: string;
  };
  target: {
    scopeType: 'course' | 'category';
    courseSlug: string | null;
    courseTitle: string | null;
    categorySlug: string;
    categoryName: string;
  };
  listPriceAmount: string;
  amount: string;
  discount: { code: string; percentOff: number } | null;
  discountError: { errorCode: string } | null;
  currentExpiresAt: string | null;
  resultingExpiresAt: string;
  isRenewal: boolean;
  warnings: CheckoutWarning[];
  blockedBy: CheckoutRefusal | null;
  paymentAvailable: boolean;
}

export interface CheckoutRedirectView {
  orderId: string;
  redirectUrl: string;
}

export type OrderStatus = 'pending' | 'paid' | 'failed' | 'refunded';

export interface OrderView {
  orderId: string;
  productId: string;
  productName: string;
  productType: 'single_course' | 'category_bundle';
  target: {
    courseSlug: string | null;
    courseTitle: string | null;
    categorySlug: string;
    categoryName: string;
  };
  amount: string;
  listPriceAmount: string;
  discountCode: string | null;
  orderStatus: OrderStatus;
  createdAt: string;
  completedAt: string | null;
}

export interface OrderListView {
  items: OrderView[];
  total: number;
  page: number;
  pageSize: number;
}

/** Display only. VND has no minor unit. */
export const formatVnd = (amount: string, currencyCode = 'VND'): string =>
  `${new Intl.NumberFormat('vi-VN').format(Number(amount))} ${currencyCode}`;

/** A date as it falls in Vietnam, the timezone every commerce date is expressed in. */
export const formatVietnamDate = (iso: string): string =>
  new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'long' }).format(
    new Date(iso),
  );

export const formatVietnamDateTime = (iso: string): string =>
  new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso));

/** Why a checkout cannot proceed, in words. The server's code decides; the page never guesses. */
export function describeRefusal(refusal: CheckoutRefusal): string {
  switch (refusal.errorCode) {
    case 'CHECKOUT_COURSE_NOT_PUBLISHED':
      return 'Khoá học này chưa được phát hành nên chưa thể mua.';
    case 'CHECKOUT_COURSE_FREE':
      return 'Khoá học này miễn phí — bạn có thể học ngay mà không cần mua.';
    case 'CHECKOUT_BUNDLE_EMPTY':
      return 'Trọn bộ này chưa có khoá học nào được phát hành.';
    case 'CHECKOUT_ALREADY_PERPETUAL':
      return 'Bạn đã có quyền truy cập không thời hạn, không cần mua thêm.';
    case 'CHECKOUT_TERM_TOO_LONG':
      return refusal.renewableFrom
        ? `Bạn vẫn còn hơn một kỳ truy cập. Bạn có thể gia hạn từ ngày ${formatVietnamDate(refusal.renewableFrom)}.`
        : 'Bạn vẫn còn hơn một kỳ truy cập, nên chưa thể gia hạn thêm.';
    case 'CHECKOUT_RATE_LIMITED':
      return 'Bạn đã tạo quá nhiều đơn hàng trong một giờ. Vui lòng thử lại sau.';
    case 'PAYMENT_PROVIDER_UNAVAILABLE':
      return 'Cửa hàng tạm đóng. Vui lòng quay lại sau.';
    case 'PAYMENT_PROVIDER_ERROR':
      return 'Không kết nối được cổng thanh toán. Vui lòng thử lại.';
    case 'PRODUCT_NOT_FOUND':
      return 'Sản phẩm này hiện không được bán.';
    default:
      return 'Không thể thanh toán lúc này. Vui lòng thử lại.';
  }
}

/** A warning that does not block the purchase, in words. */
export function describeWarning(warning: CheckoutWarning): string {
  if (warning.code === 'BUNDLE_OVERLAPS_OWNED_COURSES') {
    const titles = (warning.courses ?? []).map((course) => course.courseTitle).join(', ');
    return `Bạn đã có quyền truy cập ${titles}, nằm trong trọn bộ này. Bạn vẫn có thể mua trọn bộ, nhưng phần trùng lặp không được hoàn tiền.`;
  }
  return `Trọn bộ ${warning.categoryName ?? ''} mà bạn đang có đã bao gồm khoá học này. Bạn vẫn có thể mua riêng.`;
}
