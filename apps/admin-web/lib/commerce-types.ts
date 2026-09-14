/**
 * Owner-side commerce views, mirroring apps/api/src/commerce/*.service.ts
 * (specs/p8a-commerce/spec.md).
 *
 * Money is a string of digits on the wire and stays one here; `formatVnd` is the
 * only place a price becomes a number, and only to be displayed.
 */

export type ProductType = 'single_course' | 'category_bundle';

export interface ProductTargetView {
  readonly scopeType: 'course' | 'category';
  readonly courseId: string | null;
  readonly courseTitle: string | null;
  readonly courseSlug: string | null;
  readonly coursePublicationStatus: string | null;
  readonly categoryId: string;
  readonly categoryName: string;
  readonly categorySlug: string;
}

export interface ProductView {
  readonly productId: string;
  readonly productType: ProductType;
  readonly displayName: string;
  readonly priceAmount: string;
  readonly currencyCode: string;
  readonly accessDurationDays: number;
  readonly gracePeriodDays: number;
  readonly isActive: boolean;
  readonly createdAt: string;
  readonly target: ProductTargetView;
}

export interface PriceCheckView {
  readonly bundlePriceAmount: string;
  readonly sumOfSinglePriceAmounts: string;
  readonly isBelowSum: boolean;
  readonly includedCourses: ReadonlyArray<{ courseId: string; title: string; priceAmount: string }>;
  readonly coursesWithoutSingleProduct: ReadonlyArray<{ courseId: string; title: string }>;
}

export interface NotForSaleCourse {
  readonly courseId: string;
  readonly title: string;
  readonly slug: string;
}

/** Warning codes are `commerceWarningCodes` in packages/shared; a save that warns still succeeded. */
export type ProductWarning =
  | { readonly code: 'BUNDLE_PRICE_NOT_BELOW_SUM'; readonly priceCheck: PriceCheckView }
  | { readonly code: 'COURSE_NOT_FOR_SALE'; readonly courses: readonly NotForSaleCourse[] };

export interface ProductSaveView {
  readonly product: ProductView;
  readonly warnings: readonly ProductWarning[];
}

export interface CourseOption {
  readonly id: string;
  readonly title: string;
  readonly levelLabel: string;
  readonly publicationStatus: string;
  readonly categoryName: string;
}

export interface CategoryOption {
  readonly id: string;
  readonly displayName: string;
  readonly slug: string;
}

export interface ProductListView {
  readonly items: readonly ProductView[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly courseOptions: readonly CourseOption[];
  readonly categoryOptions: readonly CategoryOption[];
}

export interface ProductTermsBody {
  displayName: string;
  priceAmount: string;
  accessDurationDays: number;
  gracePeriodDays: number;
}

export type CreateProductBody =
  | (ProductTermsBody & { productType: 'single_course'; courseId: string })
  | (ProductTermsBody & { productType: 'category_bundle'; categoryId: string });

/** §9.2's four editable fields; send only the ones that changed. */
export interface UpdateProductBody {
  priceAmount?: string;
  accessDurationDays?: number;
  gracePeriodDays?: number;
  isActive?: boolean;
}

export interface GrantView {
  readonly grantId: string;
  readonly learnerId: string;
  readonly learnerEmail: string;
  readonly scopeType: 'course' | 'category';
  readonly courseId: string | null;
  readonly categoryId: string | null;
  readonly scopeName: string;
  readonly accessSource: 'purchase' | 'granted_by_owner';
  readonly expiresAt: string | null;
  readonly gracePeriodDays: number;
  readonly renewalCount: number;
  readonly revokedAt: string | null;
  /** From §7.3's `isGrantActive` on the server — never recomputed here. */
  readonly isActive: boolean;
  readonly grantedByEmail: string | null;
  readonly sourceProductName: string | null;
  readonly createdAt: string;
}

export interface GrantListView {
  readonly items: readonly GrantView[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

interface GrantTermsBody {
  learnerEmail: string;
  /** `YYYY-MM-DD` in Asia/Ho_Chi_Minh, or null for perpetual. */
  expiresOn: string | null;
  gracePeriodDays: number;
}

export type CreateGrantBody =
  | (GrantTermsBody & { scopeType: 'course'; courseId: string })
  | (GrantTermsBody & { scopeType: 'category'; categoryId: string });

export interface DiscountCodeView {
  readonly codeId: string;
  readonly code: string;
  readonly percentOff: number;
  readonly appliesToAllProducts: boolean;
  readonly products: ReadonlyArray<{ productId: string; displayName: string }>;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly maxRedemptions: number | null;
  readonly oncePerLearner: boolean;
  readonly newPurchasesOnly: boolean;
  readonly isActive: boolean;
  /** Paid orders carrying the code. */
  readonly redemptionCount: number;
  readonly createdAt: string;
}

export interface DiscountCodeListView {
  readonly items: readonly DiscountCodeView[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export interface CreateDiscountCodeBody {
  code: string;
  percentOff: number;
  appliesToAllProducts?: boolean;
  productIds?: string[];
  startsOn?: string | null;
  endsOn?: string | null;
  maxRedemptions?: number | null;
  oncePerLearner?: boolean;
  newPurchasesOnly?: boolean;
}

/** Code, percent and products are fixed at creation and not part of this body. */
export interface UpdateDiscountCodeBody {
  startsOn?: string | null;
  endsOn?: string | null;
  maxRedemptions?: number | null;
  oncePerLearner?: boolean;
  newPurchasesOnly?: boolean;
  isActive?: boolean;
}

export type OrderStatus = 'pending' | 'paid' | 'failed' | 'refunded';

export interface AdminOrderView {
  readonly orderId: string;
  readonly productId: string;
  readonly productName: string;
  readonly productType: ProductType;
  readonly target: {
    readonly courseSlug: string | null;
    readonly courseTitle: string | null;
    readonly categorySlug: string;
    readonly categoryName: string;
  };
  readonly amount: string;
  readonly listPriceAmount: string;
  readonly discountCode: string | null;
  readonly orderStatus: OrderStatus;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly learnerEmail: string;
  readonly providerName: string;
  readonly providerOrderReference: string;
}

export interface AdminOrderListView {
  readonly items: readonly AdminOrderView[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

/** The `YYYY-MM-DD` an instant falls on in Vietnam — what a date input shows. */
export const vietnamDateOf = (iso: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(iso));

/** An instant shown on the day and time it falls on in Vietnam, the timezone grants are picked in. */
export const formatVietnamTime = (iso: string): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso));

/** Display only. VND has no minor unit. */
export const formatVnd = (amount: string): string =>
  `${new Intl.NumberFormat('vi-VN').format(Number(amount))} VND`;
