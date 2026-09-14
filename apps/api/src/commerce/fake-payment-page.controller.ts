import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpException,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Redirect,
} from '@nestjs/common';
import { z } from 'zod';
import {
  FAKE_PAYMENT_SIGNATURE_HEADER,
  FakePaymentProvider,
  PAYMENT_PROVIDER,
  type PaymentProvider,
} from '@knowledge-explorer/commerce';
import { errorCodes } from '@knowledge-explorer/shared';
import { PrismaService } from '../prisma/prisma.service';
import { apiPublicUrl, learnerWebUrl } from './payment-provider.factory';

/**
 * The fake provider's "hosted checkout page" (specs/p8a-commerce/spec.md).
 *
 * It stands in for a gateway's page: the browser lands here from `createCheckout`,
 * the learner clicks Pay or Fail, and this controller DELIVERS A SIGNED WEBHOOK
 * OVER HTTP to `/api/webhooks/payment` — the same controller, raw-body capture and
 * signature check a real gateway's call takes — before redirecting to learner-web's
 * return page. It never calls the purchase service in-process: the network hop is
 * what makes the fake exercise the real path.
 *
 * TWO LAYERS KEEP IT OUT OF PRODUCTION:
 *
 *  1. It is registered only through `AppModule.withFakePaymentPage()`, which
 *     main.ts chooses after `.env` is loaded, when `PAYMENT_PROVIDER=fake`.
 *  2. Every handler answers a bare 404 unless the bound provider IS the fake, so a
 *     controller left registered by mistake is indistinguishable from a route that
 *     does not exist.
 *
 * Unauthenticated, as a gateway's page is: it is addressed by an unguessable
 * 128-bit reference and shows nothing but a product name and an amount.
 */

const outcomeSchema = z.strictObject({ outcome: z.enum(['paid', 'failed']) });

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

@Controller('payments/fake/checkout')
export class FakePaymentPageController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  @Get(':reference')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async page(@Param('reference') reference: string): Promise<string> {
    this.requireFake();
    const order = await this.findOrder(reference);
    const action = `/api/payments/fake/checkout/${encodeURIComponent(reference)}`;
    const amount = new Intl.NumberFormat('vi-VN').format(Number(order.amount.toString()));

    // Owner-entered text is escaped: a product name is not markup.
    return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Fake payment</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem">
  <p style="color:#92400e"><strong>Fake payment provider.</strong> No money moves. For development and tests only.</p>
  <h1 data-testid="fake-product">${escapeHtml(order.product.displayName)}</h1>
  <p data-testid="fake-amount">${escapeHtml(amount)} ${escapeHtml(order.currencyCode)}</p>
  <p data-testid="fake-status">Order status: ${escapeHtml(order.orderStatus)}</p>
  <form method="post" action="${action}" style="display:inline">
    <input type="hidden" name="outcome" value="paid">
    <button type="submit" data-testid="fake-pay">Pay</button>
  </form>
  <form method="post" action="${action}" style="display:inline; margin-left: 1rem">
    <input type="hidden" name="outcome" value="failed">
    <button type="submit" data-testid="fake-fail">Fail</button>
  </form>
</body>
</html>`;
  }

  @Post(':reference')
  @Redirect()
  async outcome(
    @Param('reference') reference: string,
    @Body() body: unknown,
  ): Promise<{ url: string; statusCode: number }> {
    const fake = this.requireFake();
    const parsed = outcomeSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ errorCode: 'INVALID_BODY' });
    const order = await this.findOrder(reference);

    // Delivered even when the order is no longer pending: replay is exactly what
    // a gateway retry does, and the webhook must shrug it off.
    const { rawBody, signature } = fake.signedWebhook({
      providerOrderReference: reference,
      outcome: parsed.data.outcome,
      amount: order.amount.toString(),
      currencyCode: order.currencyCode,
    });

    let delivered: Response;
    try {
      delivered = await fetch(`${apiPublicUrl()}/api/webhooks/payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [FAKE_PAYMENT_SIGNATURE_HEADER]: signature },
        body: rawBody,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new HttpException({ errorCode: errorCodes.PAYMENT_PROVIDER_ERROR }, HttpStatus.BAD_GATEWAY);
    }
    if (!delivered.ok) {
      throw new HttpException({ errorCode: errorCodes.PAYMENT_PROVIDER_ERROR }, HttpStatus.BAD_GATEWAY);
    }

    fake.recordDeliveredOutcome(reference, parsed.data.outcome);
    return {
      url: `${learnerWebUrl()}/checkout/return?orderId=${encodeURIComponent(order.id)}`,
      statusCode: HttpStatus.SEE_OTHER,
    };
  }

  /** A bare 404 — the same body an unregistered route returns — unless the fake is bound. */
  private requireFake(): FakePaymentProvider {
    if (!(this.provider instanceof FakePaymentProvider)) throw new NotFoundException();
    return this.provider;
  }

  private async findOrder(reference: string) {
    const order = await this.prisma.client.paymentOrder.findUnique({
      where: {
        providerName_providerOrderReference: {
          providerName: this.provider.providerName,
          providerOrderReference: reference,
        },
      },
      select: {
        id: true,
        amount: true,
        currencyCode: true,
        orderStatus: true,
        product: { select: { displayName: true } },
      },
    });
    if (!order) throw new NotFoundException({ errorCode: errorCodes.ORDER_NOT_FOUND });
    return order;
  }
}
