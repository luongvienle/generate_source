import { describe, expect, it } from 'vitest';
import {
  FAKE_PAYMENT_SIGNATURE_HEADER,
  FakePaymentProvider,
  signFakeWebhook,
  type FakeWebhookBody,
} from '../src/fake-payment-provider';
import { PaymentProviderUnavailableError, mintProviderOrderReference } from '../src/payment-provider';
import {
  UnavailablePaymentProvider,
  isPaymentProviderAvailable,
} from '../src/unavailable-payment-provider';

/**
 * The fake provider's signature check — the only credential the webhook has.
 *
 * The case that matters most is the re-serialized body: an implementation that
 * verifies `JSON.stringify(parsedBody)` instead of the raw bytes passes every
 * other test here and fails against any real gateway.
 */

const secret = 'test-only-fake-webhook-secret';
const provider = new FakePaymentProvider({
  webhookSecret: secret,
  apiPublicUrl: 'http://localhost:3001/',
});

const body: FakeWebhookBody = {
  providerOrderReference: 'ref-abc',
  outcome: 'paid',
  amount: '180000',
  currencyCode: 'VND',
};

const deliver = (rawBody: string, signature: string | string[] | undefined) =>
  provider.verifyWebhook({
    rawBody: Buffer.from(rawBody, 'utf8'),
    headers: { [FAKE_PAYMENT_SIGNATURE_HEADER]: signature },
  });

describe('FakePaymentProvider.verifyWebhook', () => {
  it('accepts a body signed with the secret and reports its event', async () => {
    const { rawBody, signature } = provider.signedWebhook(body);

    const event = await deliver(rawBody, signature);

    expect(event).toEqual({ ...body, payload: body });
  });

  it('refuses a signature with one flipped byte', async () => {
    const { rawBody, signature } = provider.signedWebhook(body);
    const flipped = `${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`;

    expect(await deliver(rawBody, flipped)).toBeNull();
  });

  it('refuses the same object re-serialized with different whitespace — the bytes are what was signed', async () => {
    const { rawBody, signature } = provider.signedWebhook(body);
    const reserialized = JSON.stringify(JSON.parse(rawBody), null, 2);
    expect(reserialized).not.toBe(rawBody);

    expect(await deliver(reserialized, signature)).toBeNull();
  });

  it('refuses a body whose amount was changed after signing', async () => {
    const { signature } = provider.signedWebhook(body);

    expect(await deliver(JSON.stringify({ ...body, amount: '1' }), signature)).toBeNull();
  });

  it('refuses a request with no signature header', async () => {
    expect(await deliver(JSON.stringify(body), undefined)).toBeNull();
  });

  it('refuses a body signed with a different secret', async () => {
    const rawBody = JSON.stringify(body);

    expect(await deliver(rawBody, signFakeWebhook(rawBody, 'someone-elses-secret'))).toBeNull();
  });

  it.each([
    ['too short', 'abcd'],
    ['too long', 'a'.repeat(66)],
    ['not hex', 'z'.repeat(64)],
  ])('refuses a signature that is %s without throwing', async (_label, signature) => {
    await expect(deliver(JSON.stringify(body), signature)).resolves.toBeNull();
  });

  it('reads the first value when the header arrives as a list', async () => {
    const { rawBody, signature } = provider.signedWebhook(body);

    expect(await deliver(rawBody, [signature, 'ignored'])).not.toBeNull();
  });

  it.each([
    ['not JSON', 'not json at all'],
    ['an unknown outcome', JSON.stringify({ ...body, outcome: 'refunded' })],
    ['a numeric amount', JSON.stringify({ ...body, amount: 180000 })],
    ['an empty reference', JSON.stringify({ ...body, providerOrderReference: '' })],
  ])('refuses a correctly signed body that is %s', async (_label, rawBody) => {
    expect(await deliver(rawBody, signFakeWebhook(rawBody, secret))).toBeNull();
  });
});

describe('FakePaymentProvider checkout', () => {
  it('redirects to the hosted page for the reference, trimming a trailing slash', async () => {
    const redirect = await provider.createCheckout({
      orderId: 'order-1',
      providerOrderReference: 'ref/with space',
      amount: '180000',
      currencyCode: 'VND',
      description: 'Tiếng Nhật N5',
      returnUrl: 'http://localhost:3002/checkout/return?orderId=order-1',
    });

    expect(redirect.redirectUrl).toBe(
      'http://localhost:3001/api/payments/fake/checkout/ref%2Fwith%20space',
    );
  });

  it('refuses to construct without a webhook secret', () => {
    expect(
      () => new FakePaymentProvider({ webhookSecret: '', apiPublicUrl: 'http://localhost:3001' }),
    ).toThrow(/PAYMENT_FAKE_WEBHOOK_SECRET/);
  });

  it('reports pending until the hosted page records an outcome', async () => {
    const fresh = new FakePaymentProvider({ webhookSecret: secret, apiPublicUrl: 'http://x' });

    expect(await fresh.getOrderStatus('ref-xyz')).toBe('pending');
    fresh.recordDeliveredOutcome('ref-xyz', 'failed');
    expect(await fresh.getOrderStatus('ref-xyz')).toBe('failed');
  });
});

describe('mintProviderOrderReference', () => {
  it('mints distinct URL-safe references of 128 bits', () => {
    const references = new Set(Array.from({ length: 200 }, () => mintProviderOrderReference()));

    expect(references.size).toBe(200);
    for (const reference of references) expect(reference).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

describe('UnavailablePaymentProvider', () => {
  const closed = new UnavailablePaymentProvider();

  it('rejects every method with PaymentProviderUnavailableError', async () => {
    await expect(
      closed.createCheckout(),
    ).rejects.toBeInstanceOf(PaymentProviderUnavailableError);
    await expect(closed.verifyWebhook()).rejects.toBeInstanceOf(PaymentProviderUnavailableError);
    await expect(closed.getOrderStatus()).rejects.toBeInstanceOf(PaymentProviderUnavailableError);
  });

  it('is the only provider that reports itself unavailable', () => {
    expect(isPaymentProviderAvailable(closed)).toBe(false);
    expect(isPaymentProviderAvailable(provider)).toBe(true);
  });
});
