import {
  FAKE_PAYMENT_PROVIDER_NAME,
  FakePaymentProvider,
  UnavailablePaymentProvider,
  type PaymentProvider,
} from '@knowledge-explorer/commerce';
import { DEFAULT_CHECKOUT_HOURLY_CAP } from '@knowledge-explorer/shared';

/**
 * §11's `PaymentProvider`, selected by environment ONCE at startup
 * (specs/p8a-commerce/spec.md).
 *
 * DELIBERATELY UNLIKE THE OTHER THREE PROVIDERS. `IMAGE_PROVIDER`,
 * `LLM_PROVIDER` and `TTS_PROVIDER` select their deterministic fake when unset,
 * because a fake image costs nothing and grants nothing. A fake PAYMENT provider
 * grants paid access to anyone who clicks a button, so:
 *
 *  - `PAYMENT_PROVIDER=fake` binds the fake, and refuses to boot without
 *    `PAYMENT_FAKE_WEBHOOK_SECRET` — webhooks anyone could sign are worse than none.
 *  - Anything else, including unset, binds `UnavailablePaymentProvider`: checkout
 *    and the webhook answer 503 and the fake hosted page is not registered. The
 *    store is closed rather than faked.
 *
 * Every function takes the environment rather than reading it at import time:
 * `main.ts` imports `AppModule` before `.env` is loaded, so a module-scope read
 * would see an empty environment in development.
 */

export function isFakePaymentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['PAYMENT_PROVIDER'] === FAKE_PAYMENT_PROVIDER_NAME;
}

/** Where a browser reaches apps/api — the fake hosted page's own origin. */
export function apiPublicUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env['API_PUBLIC_URL'] || `http://localhost:${env['API_PORT'] ?? '3001'}`;
}

/** Where the gateway sends the browser after payment: learner-web's return page. */
export function learnerWebUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env['LEARNER_WEB_URL'] || 'http://localhost:3002').replace(/\/+$/, '');
}

export function createPaymentProvider(env: NodeJS.ProcessEnv = process.env): PaymentProvider {
  if (isFakePaymentEnabled(env)) {
    return new FakePaymentProvider({
      webhookSecret: env['PAYMENT_FAKE_WEBHOOK_SECRET'] ?? '',
      apiPublicUrl: apiPublicUrl(env),
    });
  }
  return new UnavailablePaymentProvider();
}

/** Orders of any status one learner may create in a trailing hour. */
export function checkoutHourlyCap(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env['CHECKOUT_HOURLY_CAP'] ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_CHECKOUT_HOURLY_CAP;
}
