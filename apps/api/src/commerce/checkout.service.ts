import {
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  PAYMENT_PROVIDER,
  applyPercentDiscount,
  exceedsTermCap,
  isGrantActive,
  isPaymentProviderAvailable,
  mintProviderOrderReference,
  renewableFrom,
  stackExpiry,
  type PaymentProvider,
} from '@knowledge-explorer/commerce';
import {
  SUPPORTED_CURRENCY_CODE,
  commerceWarningCodes,
  errorCodes,
  type OrderStatus,
  type ProductType,
} from '@knowledge-explorer/shared';
import { PrismaService } from '../prisma/prisma.service';
import { DiscountCodesService } from './discount-codes.service';
import { checkoutHourlyCap, learnerWebUrl } from './payment-provider.factory';

/**
 * FR-COM-02 — checkout (specs/p8a-commerce/spec.md, "Checkout").
 *
 * The quote and the POST share ONE evaluation. The POST recomputes everything
 * and never trusts a quote the browser might hold: prices, grants and
 * publication status can all change between the two requests.
 *
 * TWO RULES THIS FILE MUST NOT BREAK:
 *
 *  - §7.4's arithmetic lives in packages/commerce/src/renewal.ts. The preview
 *    here calls `stackExpiry` and `exceedsTermCap`; it never adds days itself.
 *  - Activity is `isGrantActive`'s decision. Queries select grants by identity —
 *    user, scope, `revoked_at IS NULL` — and never compare `expires_at` to now.
 *
 * A BROWSER REDIRECT NEVER GRANTS ACCESS (FR-COM-03). Nothing in this file writes
 * `access_grants`; the pending order it creates is inert until a verified webhook
 * settles it.
 */

const PUBLISHED = 'published';
const HOUR_MILLISECONDS = 60 * 60 * 1000;

export type CheckoutWarning =
  | {
      readonly code: typeof commerceWarningCodes.BUNDLE_OVERLAPS_OWNED_COURSES;
      readonly courses: ReadonlyArray<{ courseSlug: string; courseTitle: string }>;
    }
  | {
      readonly code: typeof commerceWarningCodes.COURSE_COVERED_BY_BUNDLE;
      readonly categorySlug: string;
      readonly categoryName: string;
    };

/** What POST /checkout would refuse with; the quote reports it instead of throwing. */
export type CheckoutRefusal =
  | { readonly errorCode: typeof errorCodes.CHECKOUT_COURSE_NOT_PUBLISHED }
  | { readonly errorCode: typeof errorCodes.CHECKOUT_COURSE_FREE }
  | { readonly errorCode: typeof errorCodes.CHECKOUT_BUNDLE_EMPTY }
  | { readonly errorCode: typeof errorCodes.CHECKOUT_ALREADY_PERPETUAL }
  | {
      readonly errorCode: typeof errorCodes.CHECKOUT_TERM_TOO_LONG;
      readonly currentExpiresAt: string;
      readonly renewableFrom: string;
    };

export interface QuoteView {
  readonly product: {
    readonly productId: string;
    readonly productType: ProductType;
    readonly displayName: string;
    readonly accessDurationDays: number;
    readonly gracePeriodDays: number;
    readonly currencyCode: string;
  };
  readonly target: {
    readonly scopeType: 'course' | 'category';
    readonly courseSlug: string | null;
    readonly courseTitle: string | null;
    readonly categorySlug: string;
    readonly categoryName: string;
  };
  readonly listPriceAmount: string;
  readonly amount: string;
  readonly discount: { readonly code: string; readonly percentOff: number } | null;
  readonly discountError: { readonly errorCode: string } | null;
  /** The same-scope, un-revoked grant's expiry, when there is one. */
  readonly currentExpiresAt: string | null;
  /** §7.4 stacking, previewed with the function the webhook will apply. */
  readonly resultingExpiresAt: string;
  readonly isRenewal: boolean;
  readonly warnings: readonly CheckoutWarning[];
  readonly blockedBy: CheckoutRefusal | null;
  readonly paymentAvailable: boolean;
}

export interface CheckoutRedirectView {
  readonly orderId: string;
  readonly redirectUrl: string;
}

export interface OrderView {
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
}

export interface OrderListView {
  readonly items: readonly OrderView[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

const CATEGORY_SELECT = { select: { id: true, slug: true, displayName: true } } as const;

const PRODUCT_SELECT = {
  id: true,
  productType: true,
  displayName: true,
  priceAmount: true,
  currencyCode: true,
  accessDurationDays: true,
  gracePeriodDays: true,
  isActive: true,
  course: {
    select: {
      id: true,
      slug: true,
      title: true,
      publicationStatus: true,
      pricingType: true,
      categoryId: true,
      category: CATEGORY_SELECT,
    },
  },
  category: CATEGORY_SELECT,
} as const;

/** The order fields both learner views and the owner list read. */
export const ORDER_SELECT = {
  id: true,
  productId: true,
  amount: true,
  listPriceAmount: true,
  orderStatus: true,
  createdAt: true,
  completedAt: true,
  discountCode: { select: { code: true } },
  product: {
    select: {
      displayName: true,
      productType: true,
      course: { select: { slug: true, title: true, category: CATEGORY_SELECT } },
      category: CATEGORY_SELECT,
    },
  },
} as const;

type OrderRow = {
  id: string;
  productId: string;
  amount: { toString(): string };
  listPriceAmount: { toString(): string };
  orderStatus: string;
  createdAt: Date;
  completedAt: Date | null;
  discountCode: { code: string } | null;
  product: {
    displayName: string;
    productType: string;
    course: {
      slug: string;
      title: string;
      category: { id: string; slug: string; displayName: string };
    } | null;
    category: { id: string; slug: string; displayName: string } | null;
  };
};

export function toOrderView(row: OrderRow): OrderView {
  const category = row.product.course ? row.product.course.category : row.product.category!;
  return {
    orderId: row.id,
    productId: row.productId,
    productName: row.product.displayName,
    productType: row.product.productType as ProductType,
    target: {
      courseSlug: row.product.course?.slug ?? null,
      courseTitle: row.product.course?.title ?? null,
      categorySlug: category.slug,
      categoryName: category.displayName,
    },
    amount: row.amount.toString(),
    listPriceAmount: row.listPriceAmount.toString(),
    discountCode: row.discountCode?.code ?? null,
    orderStatus: row.orderStatus as OrderStatus,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

/** Everything a checkout decision reads, computed once for the quote and the POST alike. */
interface Evaluation {
  readonly quote: QuoteView;
  readonly productId: string;
  readonly description: string;
  /** Set only when a discount code applied. */
  readonly discountCodeId: string | null;
}

@Injectable()
export class CheckoutService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    @Inject(DiscountCodesService) private readonly discounts: DiscountCodesService,
  ) {}

  /** GET /checkout/quote: what the confirm page shows. Never writes. */
  async quote(userId: string, productId: string, discountCode?: string): Promise<QuoteView> {
    return (await this.evaluate(userId, productId, new Date(), discountCode)).quote;
  }

  /**
   * POST /checkout: FR-COM-02 — "creates a `payment_orders` row in `pending` and
   * returns the provider's redirect target. The same endpoint serves first
   * purchase and renewal."
   *
   * Refusals, first wins: no provider (503), unknown or inactive product (404),
   * the quote's `blockedBy` (409), a discount code that does not apply (422), then
   * the hourly cap (429).
   */
  async checkout(
    userId: string,
    productId: string,
    discountCode?: string,
  ): Promise<CheckoutRedirectView> {
    if (!isPaymentProviderAvailable(this.provider)) {
      throw new ServiceUnavailableException({ errorCode: errorCodes.PAYMENT_PROVIDER_UNAVAILABLE });
    }

    const now = new Date();
    const { quote, description, discountCodeId } = await this.evaluate(
      userId,
      productId,
      now,
      discountCode,
    );
    if (quote.blockedBy) throw new ConflictException(quote.blockedBy);
    // #8. The quote falls back to the list price so the learner can remove the
    // code; a POST that still names a failing code is refused rather than
    // silently charged the undiscounted price.
    if (quote.discountError) throw new UnprocessableEntityException(quote.discountError);

    await this.refuseIfRateLimited(userId, now);

    /**
     * The order row exists BEFORE the provider is called, carrying a reference
     * minted here. A gateway may deliver its webhook before `createCheckout` has
     * even returned; the webhook must find the row waiting.
     */
    const providerOrderReference = mintProviderOrderReference();
    const order = await this.prisma.client.paymentOrder.create({
      data: {
        userId,
        productId,
        providerName: this.provider.providerName,
        providerOrderReference,
        amount: quote.amount,
        listPriceAmount: quote.listPriceAmount,
        currencyCode: SUPPORTED_CURRENCY_CODE,
        orderStatus: 'pending',
        discountCodeId,
      },
      select: { id: true },
    });

    try {
      const redirect = await this.provider.createCheckout({
        orderId: order.id,
        providerOrderReference,
        amount: quote.amount,
        currencyCode: SUPPORTED_CURRENCY_CODE,
        description,
        returnUrl: `${learnerWebUrl()}/checkout/return?orderId=${encodeURIComponent(order.id)}`,
      });
      return { orderId: order.id, redirectUrl: redirect.redirectUrl };
    } catch {
      // The provider never produced a checkout, so no webhook can settle this
      // order. Failing it now keeps it out of anything that reads pending rows.
      await this.prisma.client.paymentOrder.updateMany({
        where: { id: order.id, orderStatus: 'pending' },
        data: { orderStatus: 'failed', completedAt: new Date() },
      });
      throw new HttpException(
        { errorCode: errorCodes.PAYMENT_PROVIDER_ERROR },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  async myOrders(userId: string, page: number, pageSize: number): Promise<OrderListView> {
    const where = { userId };
    const [rows, total] = await Promise.all([
      this.prisma.client.paymentOrder.findMany({
        where,
        select: ORDER_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.client.paymentOrder.count({ where }),
    ]);
    return { items: rows.map(toOrderView), total, page, pageSize };
  }

  /**
   * One of the caller's own orders, polled by the return page.
   *
   * Another learner's order is 404, indistinguishable from a missing one — a 403
   * would confirm the id is real and someone else's.
   */
  async myOrder(userId: string, orderId: string): Promise<OrderView> {
    const row = await this.prisma.client.paymentOrder.findFirst({
      where: { id: orderId, userId },
      select: ORDER_SELECT,
    });
    if (!row) throw new NotFoundException({ errorCode: errorCodes.ORDER_NOT_FOUND });
    return toOrderView(row);
  }

  /**
   * The shared evaluation. Refusals #3–#7 are reported in `blockedBy` in the
   * order the spec fixes, so a product failing two conditions reports the
   * earlier one; #2 (no such product) is a 404 for the quote as well.
   */
  private async evaluate(
    userId: string,
    productId: string,
    now: Date,
    discountCode?: string,
  ): Promise<Evaluation> {
    const product = await this.prisma.client.product.findUnique({
      where: { id: productId },
      select: PRODUCT_SELECT,
    });
    // An inactive product is not for sale, and is indistinguishable from none.
    if (!product || !product.isActive) {
      throw new NotFoundException({ errorCode: errorCodes.PRODUCT_NOT_FOUND });
    }

    const course = product.course;
    // The CHECK constraint guarantees exactly one of course and category.
    const category = course ? course.category : product.category!;
    const isSingle = course !== null;

    // Identity, not activity: every un-revoked grant that could matter here.
    const grants = await this.prisma.client.accessGrant.findMany({
      where: {
        userId,
        revokedAt: null,
        OR: [
          { scopeType: 'category', scopeCategoryId: category.id },
          { scopeType: 'course', scopeCourse: { categoryId: category.id } },
        ],
      },
      select: {
        scopeType: true,
        scopeCourseId: true,
        scopeCategoryId: true,
        expiresAt: true,
        gracePeriodDays: true,
        revokedAt: true,
        scopeCourse: { select: { slug: true, title: true } },
      },
    });

    const categoryGrant = grants.find(
      (grant) => grant.scopeType === 'category' && grant.scopeCategoryId === category.id,
    );
    const sameScope = isSingle
      ? grants.find((grant) => grant.scopeType === 'course' && grant.scopeCourseId === course.id)
      : categoryGrant;

    const days = product.accessDurationDays;
    const currentExpiresAt = sameScope?.expiresAt ?? null;

    const blockedBy = await this.refusal({
      course,
      categoryId: category.id,
      sameScope,
      categoryGrant: isSingle ? categoryGrant : undefined,
      days,
      now,
    });

    const warnings: CheckoutWarning[] = [];
    if (isSingle) {
      if (categoryGrant && isGrantActive(categoryGrant, now)) {
        warnings.push({
          code: commerceWarningCodes.COURSE_COVERED_BY_BUNDLE,
          categorySlug: category.slug,
          categoryName: category.displayName,
        });
      }
    } else {
      const owned = grants.filter(
        (grant) => grant.scopeType === 'course' && grant.scopeCourse && isGrantActive(grant, now),
      );
      if (owned.length > 0) {
        warnings.push({
          code: commerceWarningCodes.BUNDLE_OVERLAPS_OWNED_COURSES,
          courses: owned.map((grant) => ({
            courseSlug: grant.scopeCourse!.slug,
            courseTitle: grant.scopeCourse!.title,
          })),
        });
      }
    }

    const listPriceAmount = product.priceAmount.toString();

    /**
     * #8. A failing code is reported, not thrown, on the quote: the amount falls
     * back to the list price so the learner can drop the code and still pay.
     * `blockedBy` is unaffected by it.
     */
    let amount = listPriceAmount;
    let discount: QuoteView['discount'] = null;
    let discountError: QuoteView['discountError'] = null;
    let discountCodeId: string | null = null;
    if (discountCode !== undefined) {
      const evaluation = await this.discounts.evaluate({
        rawCode: discountCode,
        productId: product.id,
        userId,
        sameScopeGrant: sameScope,
        now,
      });
      if (evaluation.ok) {
        amount = applyPercentDiscount(listPriceAmount, evaluation.percentOff);
        discount = { code: evaluation.code, percentOff: evaluation.percentOff };
        discountCodeId = evaluation.codeId;
      } else {
        discountError = { errorCode: evaluation.errorCode };
      }
    }

    return {
      productId: product.id,
      description: product.displayName,
      discountCodeId,
      quote: {
        product: {
          productId: product.id,
          productType: product.productType as ProductType,
          displayName: product.displayName,
          accessDurationDays: days,
          gracePeriodDays: product.gracePeriodDays,
          currencyCode: product.currencyCode,
        },
        target: {
          scopeType: isSingle ? 'course' : 'category',
          courseSlug: course?.slug ?? null,
          courseTitle: course?.title ?? null,
          categorySlug: category.slug,
          categoryName: category.displayName,
        },
        listPriceAmount,
        amount,
        discount,
        discountError,
        currentExpiresAt: currentExpiresAt?.toISOString() ?? null,
        resultingExpiresAt: stackExpiry(currentExpiresAt, now, days).toISOString(),
        isRenewal: sameScope !== undefined,
        warnings,
        blockedBy,
        paymentAvailable: isPaymentProviderAvailable(this.provider),
      },
    };
  }

  /** Refusals #3–#7, in the spec's order. */
  private async refusal(input: {
    course: { publicationStatus: string; pricingType: string } | null;
    categoryId: string;
    sameScope: { expiresAt: Date | null } | undefined;
    categoryGrant: { expiresAt: Date | null } | undefined;
    days: number;
    now: Date;
  }): Promise<CheckoutRefusal | null> {
    const { course, sameScope, categoryGrant, days, now } = input;

    if (course) {
      // #3: nobody can buy what the catalog hides.
      if (course.publicationStatus !== PUBLISHED) {
        return { errorCode: errorCodes.CHECKOUT_COURSE_NOT_PUBLISHED };
      }
      // #4: §7.3 returns true for a free course before any grant lookup.
      if (course.pricingType === 'free') return { errorCode: errorCodes.CHECKOUT_COURSE_FREE };
    } else {
      // #5: a bundle of nothing.
      const published = await this.prisma.client.course.count({
        where: { categoryId: input.categoryId, publicationStatus: PUBLISHED },
      });
      if (published === 0) return { errorCode: errorCodes.CHECKOUT_BUNDLE_EMPTY };
    }

    // #6: perpetual access can never be lost, so a payment would buy nothing. An
    // un-revoked perpetual row is always active, so identity alone decides.
    if (sameScope && sameScope.expiresAt === null) {
      return { errorCode: errorCodes.CHECKOUT_ALREADY_PERPETUAL };
    }
    if (categoryGrant && categoryGrant.expiresAt === null) {
      return { errorCode: errorCodes.CHECKOUT_ALREADY_PERPETUAL };
    }

    // #7: renewal opens once one term or less remains.
    if (sameScope?.expiresAt && exceedsTermCap(sameScope.expiresAt, now, days)) {
      return {
        errorCode: errorCodes.CHECKOUT_TERM_TOO_LONG,
        currentExpiresAt: sameScope.expiresAt.toISOString(),
        renewableFrom: renewableFrom(sameScope.expiresAt, days).toISOString(),
      };
    }

    return null;
  }

  /**
   * #9: at most CHECKOUT_HOURLY_CAP orders of ANY status in the trailing hour,
   * counted in Postgres.
   *
   * An abuse brake, not an invariant: two simultaneous checkouts at the boundary
   * may both land, as P9's pending cap allows. No lock is added for it, and no
   * Redis limiter exists to inherit.
   */
  private async refuseIfRateLimited(userId: string, now: Date): Promise<void> {
    const cap = checkoutHourlyCap();
    const windowStart = new Date(now.getTime() - HOUR_MILLISECONDS);
    const recent = await this.prisma.client.paymentOrder.findMany({
      where: { userId, createdAt: { gte: windowStart } },
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    if (recent.length < cap) return;

    // The window reopens when the oldest order in it ages out.
    const oldest = recent[0]!.createdAt.getTime();
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((oldest + HOUR_MILLISECONDS - now.getTime()) / 1000),
    );
    throw new HttpException(
      { errorCode: errorCodes.CHECKOUT_RATE_LIMITED, cap, retryAfterSeconds },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
