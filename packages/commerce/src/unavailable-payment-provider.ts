import type { OrderStatus } from '@knowledge-explorer/shared';
import {
  PaymentProviderUnavailableError,
  type CheckoutRedirect,
  type PaymentProvider,
  type VerifiedPaymentEvent,
} from './payment-provider';

export const UNAVAILABLE_PAYMENT_PROVIDER_NAME = 'unavailable';

/**
 * What `PAYMENT_PROVIDER` unset — or set to anything unrecognised — binds.
 *
 * The store is closed rather than faked: checkout and the webhook answer 503, and
 * the fake hosted page is not served. This is the deliberate inverse of the image,
 * LLM and TTS providers, whose fakes are the unset default, because a fake payment
 * provider grants paid access to anyone (specs/p8a-commerce/spec.md).
 */
export class UnavailablePaymentProvider implements PaymentProvider {
  readonly providerName = UNAVAILABLE_PAYMENT_PROVIDER_NAME;

  createCheckout(): Promise<CheckoutRedirect> {
    return Promise.reject(new PaymentProviderUnavailableError());
  }

  verifyWebhook(): Promise<VerifiedPaymentEvent | null> {
    return Promise.reject(new PaymentProviderUnavailableError());
  }

  getOrderStatus(): Promise<OrderStatus> {
    return Promise.reject(new PaymentProviderUnavailableError());
  }
}

/** Whether a bound provider can take payments. */
export function isPaymentProviderAvailable(provider: PaymentProvider): boolean {
  return provider.providerName !== UNAVAILABLE_PAYMENT_PROVIDER_NAME;
}
