import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  PAYMENT_PROVIDER,
  isPaymentProviderAvailable,
  stackExpiry,
  type PaymentProvider,
  type WebhookInput,
} from '@knowledge-explorer/commerce';
import type { PrismaClient } from '@knowledge-explorer/database';
import { errorCodes } from '@knowledge-explorer/shared';
import { PrismaService } from '../prisma/prisma.service';
import { toHundredths } from './money';

/**
 * FR-COM-03 and NFR-06 — the payment webhook (specs/p8a-commerce/spec.md,
 * "The webhook").
 *
 * "Access is granted only when a webhook with a verified signature reports
 * payment success. A browser redirect never grants access. Webhook handling is
 * idempotent on (providerName, providerOrderReference)."
 *
 * ONE TRANSACTION, TWO LOCKS:
 *
 *  - `SELECT … FOR UPDATE` on the order row serializes two deliveries of the SAME
 *    order. The second sees a terminal status and changes nothing.
 *  - `pg_advisory_xact_lock` keyed on (user, scope) serializes two DIFFERENT paid
 *    orders for the same learner and course or category. A row lock cannot do
 *    this: when neither has a grant yet there is no row to lock, both would
 *    insert, and one would lose to the partial unique index — or, with a row,
 *    both would read the same `expires_at` and one term of paid time would vanish.
 *
 * The order update and the grant write share the transaction, so a failed grant
 * write leaves the order `pending` and the gateway's retry replays it whole.
 */

export type WebhookOutcome =
  | 'paid'
  | 'failed'
  | 'amount_mismatch'
  | 'already_settled'
  | 'unknown_order';

type Tx = Pick<PrismaClient, 'paymentOrder' | 'product' | 'accessGrant' | '$queryRaw' | '$executeRaw'>;

interface SettlingOrder {
  readonly id: string;
  readonly userId: string;
  readonly productId: string;
}

/** Long enough for a concurrent delivery holding the advisory lock to finish first. */
const TRANSACTION_TIMEOUT_MILLISECONDS = 15_000;

@Injectable()
export class PurchaseService {
  private readonly logger = new Logger('PaymentWebhook');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  async handleWebhook(input: WebhookInput): Promise<WebhookOutcome> {
    if (!isPaymentProviderAvailable(this.provider)) {
      throw new ServiceUnavailableException({ errorCode: errorCodes.PAYMENT_PROVIDER_UNAVAILABLE });
    }

    // 1. Verify. Nothing about an unverified request is trusted or stored — not
    //    even its payload.
    const event = await this.provider.verifyWebhook(input);
    if (!event) throw new UnauthorizedException({ errorCode: errorCodes.WEBHOOK_SIGNATURE_INVALID });

    const outcome = await this.prisma.client.$transaction(
      async (tx) => {
        // 2 + 3. Find and lock. Unknown → 200 and nothing written, so a gateway
        //        does not retry forever against a reference this database never
        //        minted.
        const locked = await tx.$queryRaw<Array<{ id: string; order_status: string }>>`
          SELECT id::text AS id, order_status
            FROM payment_orders
           WHERE provider_name = ${this.provider.providerName}
             AND provider_order_reference = ${event.providerOrderReference}
           FOR UPDATE`;
        const row = locked[0];
        if (!row) return 'unknown_order' as const;
        // A terminal order never changes again — including a `failed` event
        // arriving after `paid`. This is the replay guarantee.
        if (row.order_status !== 'pending') return 'already_settled' as const;

        const order = await tx.paymentOrder.findUniqueOrThrow({
          where: { id: row.id },
          select: { id: true, userId: true, productId: true, amount: true, currencyCode: true },
        });
        const now = new Date();
        const settled = {
          completedAt: now,
          rawWebhookPayload: event.payload as object,
        };

        // 4. Failed.
        if (event.outcome === 'failed') {
          await tx.paymentOrder.update({
            where: { id: order.id },
            data: { orderStatus: 'failed', ...settled },
          });
          return 'failed' as const;
        }

        // 5. Paid, but not what was charged. Fails the order rather than granting.
        if (
          !sameAmount(event.amount, order.amount.toString()) ||
          event.currencyCode !== order.currencyCode
        ) {
          await tx.paymentOrder.update({
            where: { id: order.id },
            data: { orderStatus: 'failed', ...settled },
          });
          this.logger.error(
            JSON.stringify({
              reason: 'PAYMENT_AMOUNT_MISMATCH',
              orderId: order.id,
              providerName: this.provider.providerName,
              expectedAmount: order.amount.toString(),
              expectedCurrency: order.currencyCode,
              reportedAmount: event.amount,
              reportedCurrency: event.currencyCode,
            }),
          );
          return 'amount_mismatch' as const;
        }

        // 6. Paid and matching.
        await tx.paymentOrder.update({
          where: { id: order.id },
          data: { orderStatus: 'paid', ...settled },
        });
        await this.applyPurchaseToGrant(tx, order);
        return 'paid' as const;
      },
      { timeout: TRANSACTION_TIMEOUT_MILLISECONDS },
    );

    this.logger.log(
      JSON.stringify({
        event: 'payment_webhook',
        providerName: this.provider.providerName,
        providerOrderReference: event.providerOrderReference,
        reportedOutcome: event.outcome,
        outcome,
      }),
    );
    if (outcome === 'unknown_order') {
      this.logger.warn(
        `webhook for unknown order reference ${event.providerOrderReference}; nothing written`,
      );
    }
    return outcome;
  }

  /**
   * Creates or extends the learner's grant for the product's scope.
   *
   * - A same-scope, un-revoked row is EXTENDED IN PLACE — §8's partial unique
   *   index allows exactly one — by §7.4's `stackExpiry`, with the purchase's
   *   product and order, `access_source = 'purchase'`, and reminder milestones
   *   reset so the new term's reminders are not suppressed by the old one's.
   *   `granted_by_user_id` is left as it was.
   * - That row being PERPETUAL — possible only if the owner granted it after this
   *   checkout passed its refusal — leaves it untouched. The order is still paid.
   * - Otherwise a new row is inserted. A revoked row is never extended.
   *
   * No other grant is touched: a bundle purchase leaves single-course grants in
   * its category alone, and vice versa.
   */
  private async applyPurchaseToGrant(tx: Tx, order: SettlingOrder): Promise<void> {
    const product = await tx.product.findUniqueOrThrow({
      where: { id: order.productId },
      // Duration and grace are read NOW, at webhook time, whether or not the
      // product is still active: the order's amount was fixed at checkout, its
      // terms were not.
      select: { courseId: true, categoryId: true, accessDurationDays: true, gracePeriodDays: true },
    });

    const scope = product.courseId
      ? ({ scopeType: 'course', scopeCourseId: product.courseId } as const)
      : ({ scopeType: 'category', scopeCategoryId: product.categoryId! } as const);
    const scopeId = product.courseId ?? product.categoryId!;

    // Serialize every purchase for this learner and scope, including the insert
    // case. `$executeRaw`, not `$queryRaw`: the function returns `void`, which the
    // driver adapter cannot deserialize as a result column.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${order.userId}:${scope.scopeType}:${scopeId}`}, 0))`;

    // Read AFTER the lock, so a concurrent purchase that committed first is seen.
    const now = new Date();
    const live = await tx.accessGrant.findFirst({
      where: { userId: order.userId, revokedAt: null, ...scope },
      select: { id: true, expiresAt: true },
    });

    if (live && live.expiresAt === null) {
      this.logger.log(
        JSON.stringify({
          event: 'purchase_over_perpetual_grant',
          orderId: order.id,
          grantId: live.id,
          note: 'order paid; perpetual grant left unchanged',
        }),
      );
      return;
    }

    if (live) {
      await tx.accessGrant.update({
        where: { id: live.id },
        data: {
          expiresAt: stackExpiry(live.expiresAt, now, product.accessDurationDays),
          renewalCount: { increment: 1 },
          gracePeriodDays: product.gracePeriodDays,
          sourceProductId: order.productId,
          paymentOrderId: order.id,
          accessSource: 'purchase',
          sentReminderMilestones: [],
        },
      });
      return;
    }

    await tx.accessGrant.create({
      data: {
        userId: order.userId,
        ...scope,
        accessSource: 'purchase',
        sourceProductId: order.productId,
        paymentOrderId: order.id,
        expiresAt: stackExpiry(null, now, product.accessDurationDays),
        gracePeriodDays: product.gracePeriodDays,
      },
    });
  }
}

/** Amount equality in integer hundredths; anything unparsable is simply not equal. */
function sameAmount(reported: string, expected: string): boolean {
  try {
    return toHundredths(reported) === toHundredths(expected);
  } catch {
    return false;
  }
}
