import { createHmac, timingSafeEqual } from 'node:crypto';
import type { OrderStatus } from '@knowledge-explorer/shared';
import type {
  CheckoutRedirect,
  CreateCheckoutInput,
  PaymentProvider,
  VerifiedPaymentEvent,
  WebhookInput,
} from './payment-provider';

/**
 * The deterministic payment provider every P8a test and the local stack run
 * against (specs/p8a-commerce/spec.md, "The fake provider's hosted page").
 *
 * It behaves like a hosted-checkout gateway: `createCheckout` points the browser
 * at a page the API serves, that page delivers a SIGNED webhook over HTTP, and
 * `verifyWebhook` checks the signature over the raw bytes. Nothing about the flow
 * is simulated in-process, so the webhook path it exercises is the real one.
 *
 * NEVER A DEFAULT. Unlike the image, LLM and TTS fakes, which are selected when
 * their variable is unset, this one grants paid access to anyone who clicks a
 * button. It is bound only when `PAYMENT_PROVIDER=fake`, and refuses to construct
 * without a secret.
 */

export const FAKE_PAYMENT_PROVIDER_NAME = 'fake';

/** Hex HMAC-SHA256 of the raw body. */
export const FAKE_PAYMENT_SIGNATURE_HEADER = 'x-fake-payment-signature';

/** The body the fake page delivers. */
export interface FakeWebhookBody {
  readonly providerOrderReference: string;
  readonly outcome: 'paid' | 'failed';
  readonly amount: string;
  readonly currencyCode: string;
}

export interface FakePaymentProviderOptions {
  readonly webhookSecret: string;
  /** Where the browser reaches apps/api, e.g. `http://localhost:3001`. */
  readonly apiPublicUrl: string;
}

const HEX_SHA256 = /^[0-9a-f]{64}$/i;

/** Signs raw webhook bytes the way the fake page does. Exported for tests that replay or tamper. */
export function signFakeWebhook(rawBody: string | Buffer, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/** The API path of the fake hosted page for one order. */
export function fakeCheckoutPath(providerOrderReference: string): string {
  return `/api/payments/fake/checkout/${encodeURIComponent(providerOrderReference)}`;
}

export class FakePaymentProvider implements PaymentProvider {
  readonly providerName = FAKE_PAYMENT_PROVIDER_NAME;

  /** Outcomes the hosted page has delivered, behind `getOrderStatus`. In-process only. */
  private readonly deliveredOutcomes = new Map<string, OrderStatus>();

  constructor(private readonly options: FakePaymentProviderOptions) {
    if (!options.webhookSecret) {
      throw new Error(
        'PAYMENT_PROVIDER=fake requires PAYMENT_FAKE_WEBHOOK_SECRET. Refusing to start with ' +
          'webhooks that anyone could sign.',
      );
    }
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutRedirect> {
    const base = this.options.apiPublicUrl.replace(/\/+$/, '');
    return { redirectUrl: `${base}${fakeCheckoutPath(input.providerOrderReference)}` };
  }

  /** The exact bytes and signature the hosted page sends for an outcome. */
  signedWebhook(body: FakeWebhookBody): { rawBody: string; signature: string } {
    const rawBody = JSON.stringify(body);
    return { rawBody, signature: signFakeWebhook(rawBody, this.options.webhookSecret) };
  }

  /**
   * Verifies the HMAC over the RAW body, then parses it.
   *
   * Every failure resolves to `null`, never a throw: a missing header, a
   * signature of the wrong length or alphabet, a wrong secret, a body that is not
   * byte-identical to what was signed, or a signed body that is not the shape the
   * fake sends. The comparison is constant-time and lengths are checked first,
   * because `timingSafeEqual` throws on buffers of different lengths.
   */
  async verifyWebhook(input: WebhookInput): Promise<VerifiedPaymentEvent | null> {
    const header = input.headers[FAKE_PAYMENT_SIGNATURE_HEADER];
    const provided = Array.isArray(header) ? header[0] : header;
    if (typeof provided !== 'string' || !HEX_SHA256.test(provided)) return null;

    const expected = Buffer.from(signFakeWebhook(input.rawBody, this.options.webhookSecret), 'hex');
    const given = Buffer.from(provided, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(input.rawBody.toString('utf8'));
    } catch {
      return null;
    }
    if (!isFakeWebhookBody(parsed)) return null;

    return {
      providerOrderReference: parsed.providerOrderReference,
      outcome: parsed.outcome,
      amount: parsed.amount,
      currencyCode: parsed.currencyCode,
      payload: parsed,
    };
  }

  /** Called by the hosted page after it delivers, so `getOrderStatus` has something to report. */
  recordDeliveredOutcome(providerOrderReference: string, outcome: 'paid' | 'failed'): void {
    this.deliveredOutcomes.set(providerOrderReference, outcome);
  }

  async getOrderStatus(providerOrderReference: string): Promise<OrderStatus> {
    return this.deliveredOutcomes.get(providerOrderReference) ?? 'pending';
  }
}

function isFakeWebhookBody(value: unknown): value is FakeWebhookBody {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  return (
    typeof body['providerOrderReference'] === 'string' &&
    body['providerOrderReference'].length > 0 &&
    (body['outcome'] === 'paid' || body['outcome'] === 'failed') &&
    typeof body['amount'] === 'string' &&
    typeof body['currencyCode'] === 'string'
  );
}
