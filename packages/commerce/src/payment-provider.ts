import { randomBytes } from 'node:crypto';
import type { OrderStatus } from '@knowledge-explorer/shared';

/**
 * §11's `PaymentProvider` port — `createCheckout`, `verifyWebhook`,
 * `getOrderStatus` — bound through the `PAYMENT_PROVIDER` token.
 *
 * §14 decision 1 (the gateway) is still open, so P8a ships only a deterministic
 * fake behind this interface (specs/p8a-commerce/spec.md). The first real adapter
 * must honour three constraints this port assumes:
 *
 *  1. ROUND-TRIP THE APP'S REFERENCE. `provider_order_reference` is minted here and
 *     inserted with the pending order BEFORE `createCheckout` runs, so the row
 *     exists by the time any webhook can arrive. The adapter carries it through the
 *     gateway — as an order code, a transaction reference, or metadata — and reports
 *     it back in the event.
 *  2. VERIFY RAW BYTES. `verifyWebhook` receives the request body exactly as it
 *     arrived. An HMAC over re-serialized JSON passes every self-signed test and
 *     fails against a gateway whose whitespace or key order differs from Node's.
 *  3. REPORT WHOLE VND. `amount` is compared as a string of digits against the
 *     order's `amount`; a mismatch fails the order rather than granting.
 */

export interface CreateCheckoutInput {
  readonly orderId: string;
  readonly providerOrderReference: string;
  /** Whole VND, digits only. */
  readonly amount: string;
  readonly currencyCode: 'VND';
  readonly description: string;
  /** Where the gateway sends the browser afterwards. Visiting it grants nothing. */
  readonly returnUrl: string;
}

export interface CheckoutRedirect {
  readonly redirectUrl: string;
}

export interface WebhookInput {
  readonly rawBody: Buffer;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** What a webhook says once its signature has been verified, and only then. */
export interface VerifiedPaymentEvent {
  readonly providerOrderReference: string;
  readonly outcome: 'paid' | 'failed';
  readonly amount: string;
  readonly currencyCode: string;
  /** Stored in `payment_orders.raw_webhook_payload`. */
  readonly payload: unknown;
}

export interface PaymentProvider {
  /** Written to `payment_orders.provider_name`; half of the NFR-06 idempotency key. */
  readonly providerName: string;
  createCheckout(input: CreateCheckoutInput): Promise<CheckoutRedirect>;
  /** `null` means the request is not authentic. Nothing about it may be trusted or stored. */
  verifyWebhook(input: WebhookInput): Promise<VerifiedPaymentEvent | null>;
  /**
   * No caller in P8a: abandoned orders stay `pending` and nothing reconciles.
   * Declared because §11 names it; reconciliation arrives with a real gateway.
   */
  getOrderStatus(providerOrderReference: string): Promise<OrderStatus>;
}

/** Injection token. A Symbol cannot collide with another provider's token. */
export const PAYMENT_PROVIDER = Symbol('PaymentProvider');

/**
 * A fresh `provider_order_reference`: 128 random bits, URL-safe.
 *
 * Unguessable because the fake provider's hosted page is addressed by it and is
 * unauthenticated, as a real gateway's page is.
 */
export function mintProviderOrderReference(): string {
  return randomBytes(16).toString('base64url');
}

/** Thrown by every method of the provider bound when no gateway is configured. */
export class PaymentProviderUnavailableError extends Error {
  constructor() {
    super('No payment provider is configured: PAYMENT_PROVIDER is unset or unknown.');
    this.name = 'PaymentProviderUnavailableError';
  }
}
