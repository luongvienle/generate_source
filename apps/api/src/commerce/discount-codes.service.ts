import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  isCalendarDate,
  isGrantActive,
  isWellFormedDiscountCode,
  normalizeDiscountCode,
  vietnamDayEnd,
  vietnamDayStart,
  type GrantWindow,
} from '@knowledge-explorer/commerce';
import { errorCodes } from '@knowledge-explorer/shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Discount codes — a percentage off chosen products (specs/p8a-commerce/spec.md,
 * "Discount codes"). Not in §5.9 or §9; added to P8a by decision.
 *
 * A REDEMPTION IS A PAID ORDER carrying the code. Pending and failed orders do not
 * count, which is also why `idx_payment_orders_discount_paid` is partial.
 *
 * WHAT IS FIXED AT CREATION: the code string, the percentage and the product
 * list. Changing any of them would change what an order already sold under the
 * code meant. The controller refuses them on PATCH; to change a discount, the
 * owner deactivates the code and creates another.
 */

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
  /** Paid orders carrying this code. */
  readonly redemptionCount: number;
  readonly createdAt: string;
}

export interface DiscountCodeListView {
  readonly items: readonly DiscountCodeView[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export interface CreateDiscountCodeInput {
  readonly code: string;
  readonly percentOff: number;
  readonly appliesToAllProducts?: boolean | undefined;
  readonly productIds?: readonly string[] | undefined;
  /** `YYYY-MM-DD` in Asia/Ho_Chi_Minh. */
  readonly startsOn?: string | null | undefined;
  readonly endsOn?: string | null | undefined;
  readonly maxRedemptions?: number | null | undefined;
  readonly oncePerLearner?: boolean | undefined;
  readonly newPurchasesOnly?: boolean | undefined;
}

export interface UpdateDiscountCodeInput {
  readonly startsOn?: string | null | undefined;
  readonly endsOn?: string | null | undefined;
  readonly maxRedemptions?: number | null | undefined;
  readonly oncePerLearner?: boolean | undefined;
  readonly newPurchasesOnly?: boolean | undefined;
  readonly isActive?: boolean | undefined;
}

/** A code that applies, or the first reason it does not. */
export type DiscountEvaluation =
  | { readonly ok: true; readonly codeId: string; readonly code: string; readonly percentOff: number }
  | { readonly ok: false; readonly errorCode: string };

const refused = (errorCode: string): DiscountEvaluation => ({ ok: false, errorCode });

const CODE_SELECT = {
  id: true,
  code: true,
  percentOff: true,
  appliesToAllProducts: true,
  startsAt: true,
  endsAt: true,
  maxRedemptions: true,
  oncePerLearner: true,
  newPurchasesOnly: true,
  isActive: true,
  createdAt: true,
  products: { select: { product: { select: { id: true, displayName: true } } } },
  _count: { select: { paymentOrders: { where: { orderStatus: 'paid' } } } },
} as const;

type CodeRow = {
  id: string;
  code: string;
  percentOff: number;
  appliesToAllProducts: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  maxRedemptions: number | null;
  oncePerLearner: boolean;
  newPurchasesOnly: boolean;
  isActive: boolean;
  createdAt: Date;
  products: Array<{ product: { id: string; displayName: string } }>;
  _count: { paymentOrders: number };
};

function toCodeView(row: CodeRow): DiscountCodeView {
  return {
    codeId: row.id,
    code: row.code,
    percentOff: row.percentOff,
    appliesToAllProducts: row.appliesToAllProducts,
    products: row.products.map(({ product }) => ({
      productId: product.id,
      displayName: product.displayName,
    })),
    startsAt: row.startsAt?.toISOString() ?? null,
    endsAt: row.endsAt?.toISOString() ?? null,
    maxRedemptions: row.maxRedemptions,
    oncePerLearner: row.oncePerLearner,
    newPurchasesOnly: row.newPurchasesOnly,
    isActive: row.isActive,
    redemptionCount: row._count.paymentOrders,
    createdAt: row.createdAt.toISOString(),
  };
}

const invalidBody = (reason: string) =>
  new BadRequestException({ errorCode: 'INVALID_BODY', reason });

/** A picked day as an instant, or `null`/`undefined` passed through. */
function toInstant(
  date: string | null | undefined,
  edge: 'start' | 'end',
): Date | null | undefined {
  if (date === undefined || date === null) return date;
  if (!isCalendarDate(date)) throw invalidBody(`not a calendar date: ${date}`);
  return edge === 'start' ? vietnamDayStart(date) : vietnamDayEnd(date);
}

const isUniqueViolation = (error: unknown): boolean =>
  (error as { code?: string } | null)?.code === 'P2002';

@Injectable()
export class DiscountCodesService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(page: number, pageSize: number): Promise<DiscountCodeListView> {
    const [rows, total] = await Promise.all([
      this.prisma.client.discountCode.findMany({
        select: CODE_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.client.discountCode.count(),
    ]);
    return { items: rows.map(toCodeView), total, page, pageSize };
  }

  async create(input: CreateDiscountCodeInput, createdByUserId: string): Promise<DiscountCodeView> {
    const code = normalizeDiscountCode(input.code);
    if (!isWellFormedDiscountCode(code)) {
      throw invalidBody('a code is 3 to 32 letters, digits or hyphens');
    }

    const productIds = [...new Set(input.productIds ?? [])];
    const allProducts = input.appliesToAllProducts === true;
    // Exactly one of the two: an empty list meaning "everything" is a footgun.
    if (allProducts === productIds.length > 0) {
      throw invalidBody('choose appliesToAllProducts or a non-empty productIds, not both or neither');
    }

    const startsAt = toInstant(input.startsOn, 'start') ?? null;
    const endsAt = toInstant(input.endsOn, 'end') ?? null;
    if (startsAt && endsAt && startsAt >= endsAt) {
      throw invalidBody('the window must end after it starts');
    }

    if (productIds.length > 0) {
      const found = await this.prisma.client.product.count({ where: { id: { in: productIds } } });
      if (found !== productIds.length) {
        throw new NotFoundException({ errorCode: errorCodes.PRODUCT_NOT_FOUND });
      }
    }

    await this.refuseIfExists(code);

    try {
      const row = await this.prisma.client.discountCode.create({
        data: {
          code,
          percentOff: input.percentOff,
          appliesToAllProducts: allProducts,
          startsAt,
          endsAt,
          maxRedemptions: input.maxRedemptions ?? null,
          oncePerLearner: input.oncePerLearner ?? false,
          newPurchasesOnly: input.newPurchasesOnly ?? false,
          createdByUserId,
          products: { create: productIds.map((productId) => ({ productId })) },
        },
        select: CODE_SELECT,
      });
      return toCodeView(row);
    } catch (error) {
      if (isUniqueViolation(error)) await this.refuseIfExists(code);
      throw error;
    }
  }

  /**
   * The editable fields only. Lowering `maxRedemptions` below the current count
   * is allowed and simply exhausts the code; limits bind future checkouts, not
   * orders already paid.
   */
  async update(codeId: string, input: UpdateDiscountCodeInput): Promise<DiscountCodeView> {
    const existing = await this.prisma.client.discountCode.findUnique({
      where: { id: codeId },
      select: { startsAt: true, endsAt: true },
    });
    if (!existing) throw new NotFoundException({ errorCode: errorCodes.DISCOUNT_CODE_NOT_FOUND });

    const startsAt = toInstant(input.startsOn, 'start');
    const endsAt = toInstant(input.endsOn, 'end');
    const nextStart = startsAt === undefined ? existing.startsAt : startsAt;
    const nextEnd = endsAt === undefined ? existing.endsAt : endsAt;
    // Checked here so the window CHECK constraint never has to answer with a 500.
    if (nextStart && nextEnd && nextStart >= nextEnd) {
      throw invalidBody('the window must end after it starts');
    }

    const row = await this.prisma.client.discountCode.update({
      where: { id: codeId },
      data: {
        ...(startsAt === undefined ? {} : { startsAt }),
        ...(endsAt === undefined ? {} : { endsAt }),
        ...(input.maxRedemptions === undefined ? {} : { maxRedemptions: input.maxRedemptions }),
        ...(input.oncePerLearner === undefined ? {} : { oncePerLearner: input.oncePerLearner }),
        ...(input.newPurchasesOnly === undefined ? {} : { newPurchasesOnly: input.newPurchasesOnly }),
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
      },
      select: CODE_SELECT,
    });
    return toCodeView(row);
  }

  /**
   * Whether a code applies to this checkout, as the spec's table orders it — the
   * first failing row wins:
   *
   *   1. unknown, or deactivated            DISCOUNT_CODE_NOT_FOUND
   *   2. now outside [starts_at, ends_at]   DISCOUNT_CODE_OUTSIDE_WINDOW
   *   3. product not covered                DISCOUNT_CODE_NOT_APPLICABLE
   *   4. paid redemptions ≥ the cap         DISCOUNT_CODE_EXHAUSTED
   *   5. once per learner, already paid     DISCOUNT_CODE_ALREADY_USED
   *   6. new purchases only, and the
   *      SAME-SCOPE grant is still active   DISCOUNT_CODE_NEW_PURCHASES_ONLY
   *
   * Row 6 asks `isGrantActive`, never `expires_at` directly: a learner whose grant
   * has lapsed past expiry and grace is coming back, not renewing, and may use it.
   *
   * LIMITS ARE CHECKED HERE, AT CHECKOUT, AND NOWHERE ELSE. The webhook grants an
   * order whose code has since expired, been deactivated or been exhausted by a
   * concurrent order: the learner paid the discounted amount they were shown.
   * `max_redemptions` and `once_per_learner` can therefore be exceeded by orders in
   * flight — a known bound (spec), not something to "fix" by refusing money
   * already taken.
   */
  async evaluate(input: {
    readonly rawCode: string;
    readonly productId: string;
    readonly userId: string;
    readonly sameScopeGrant: GrantWindow | undefined;
    readonly now: Date;
  }): Promise<DiscountEvaluation> {
    const normalized = normalizeDiscountCode(input.rawCode);
    const code = isWellFormedDiscountCode(normalized)
      ? await this.prisma.client.discountCode.findUnique({
          where: { code: normalized },
          select: {
            id: true,
            code: true,
            percentOff: true,
            appliesToAllProducts: true,
            startsAt: true,
            endsAt: true,
            maxRedemptions: true,
            oncePerLearner: true,
            newPurchasesOnly: true,
            isActive: true,
            products: { where: { productId: input.productId }, select: { productId: true } },
          },
        })
      : null;

    if (!code || !code.isActive) return refused(errorCodes.DISCOUNT_CODE_NOT_FOUND);

    const now = input.now.getTime();
    if ((code.startsAt && now < code.startsAt.getTime()) || (code.endsAt && now > code.endsAt.getTime())) {
      return refused(errorCodes.DISCOUNT_CODE_OUTSIDE_WINDOW);
    }

    if (!code.appliesToAllProducts && code.products.length === 0) {
      return refused(errorCodes.DISCOUNT_CODE_NOT_APPLICABLE);
    }

    if (code.maxRedemptions !== null) {
      const redemptions = await this.prisma.client.paymentOrder.count({
        where: { discountCodeId: code.id, orderStatus: 'paid' },
      });
      if (redemptions >= code.maxRedemptions) return refused(errorCodes.DISCOUNT_CODE_EXHAUSTED);
    }

    if (code.oncePerLearner) {
      const used = await this.prisma.client.paymentOrder.count({
        where: { discountCodeId: code.id, orderStatus: 'paid', userId: input.userId },
      });
      if (used > 0) return refused(errorCodes.DISCOUNT_CODE_ALREADY_USED);
    }

    if (
      code.newPurchasesOnly &&
      input.sameScopeGrant &&
      isGrantActive(input.sameScopeGrant, input.now)
    ) {
      return refused(errorCodes.DISCOUNT_CODE_NEW_PURCHASES_ONLY);
    }

    return { ok: true, codeId: code.id, code: code.code, percentOff: code.percentOff };
  }

  private async refuseIfExists(code: string): Promise<void> {
    const existing = await this.prisma.client.discountCode.findUnique({
      where: { code },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException({
        errorCode: errorCodes.DISCOUNT_CODE_ALREADY_EXISTS,
        codeId: existing.id,
      });
    }
  }
}
