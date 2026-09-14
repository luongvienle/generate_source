import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { getPrismaClient } from '@knowledge-explorer/database';
import {
  FAKE_PAYMENT_SIGNATURE_HEADER,
  mintProviderOrderReference,
  signFakeWebhook,
} from '@knowledge-explorer/commerce';
import { AppModule } from '../src/app.module';

// Set BEFORE loadEnv: dotenv never overrides a key that is already present.
const SECRET = 'commerce-webhook-test-secret';
process.env['PAYMENT_PROVIDER'] = 'fake';
process.env['PAYMENT_FAKE_WEBHOOK_SECRET'] = SECRET;
process.env['LEARNER_WEB_URL'] = 'http://learner.webhook.test';
loadEnv({ path: ['../../.env', '.env'] });

/**
 * FR-COM-03 / NFR-06 — specs/p8a-commerce/spec.md, "The webhook".
 *
 * Four properties here would pass a casual reading while being wrong:
 *
 *  - **the webhook has no guard, on purpose.** Asserted by name: an unsigned
 *    caller gets 401 from the signature check, not 403 from deny-by-default.
 *  - **the signature covers the raw bytes.** A body re-serialized with different
 *    whitespace, under the original signature, must be refused.
 *  - **a replay changes nothing.** The grant row is compared whole, before and
 *    after.
 *  - **two different paid orders for one learner and scope both stack.** Without
 *    the advisory lock one term of paid time silently disappears.
 */

const run = randomBytes(4).toString('hex');
const prisma = getPrismaClient();
const DAY = 86_400_000;

let app: INestApplication;
const api = () => request(app.getHttpServer());

const users: Record<string, string> = {};
const ids: Record<string, string> = {};

async function seedUser(key: string, userRole = 'learner'): Promise<void> {
  const user = await prisma.user.create({
    data: { email: `${key}-webhook-${run}@example.test`, userRole },
    select: { id: true },
  });
  users[key] = user.id;
}

interface Order {
  readonly id: string;
  readonly reference: string;
}

async function pendingOrder(userKey: string, productKey: string, amount: string): Promise<Order> {
  const reference = mintProviderOrderReference();
  const order = await prisma.paymentOrder.create({
    data: {
      userId: users[userKey]!,
      productId: ids[productKey]!,
      providerName: 'fake',
      providerOrderReference: reference,
      amount,
      listPriceAmount: amount,
      currencyCode: 'VND',
    },
    select: { id: true },
  });
  return { id: order.id, reference };
}

const bodyFor = (
  order: Order,
  outcome: 'paid' | 'failed',
  amount: string,
  currencyCode = 'VND',
): string =>
  JSON.stringify({ providerOrderReference: order.reference, outcome, amount, currencyCode });

const deliver = (rawBody: string, signature: string | null = signFakeWebhook(rawBody, SECRET)) => {
  const call = api().post('/api/webhooks/payment').set('Content-Type', 'application/json');
  if (signature !== null) call.set(FAKE_PAYMENT_SIGNATURE_HEADER, signature);
  return call.send(rawBody);
};

const orderRow = (id: string) =>
  prisma.paymentOrder.findUniqueOrThrow({
    where: { id },
    select: { orderStatus: true, completedAt: true, rawWebhookPayload: true },
  });

const grantsOf = (userKey: string) =>
  prisma.accessGrant.findMany({
    where: { userId: users[userKey]! },
    orderBy: { createdAt: 'asc' },
  });

const within = (actual: Date | null, expected: number, toleranceMs = 15_000) => {
  expect(actual).not.toBeNull();
  expect(Math.abs(actual!.getTime() - expected)).toBeLessThan(toleranceMs);
};

beforeAll(async () => {
  for (const key of [
    'buyer',
    'failer',
    'mismatch',
    'renewer',
    'perpetual',
    'revoked',
    'concurrent',
    'bundleBuyer',
    'pageBuyer',
  ]) {
    await seedUser(key);
  }
  await seedUser('owner', 'admin_owner');

  const k = await prisma.category.create({
    data: { slug: `webhook-${run}-k`, displayName: `K ${run}` },
    select: { id: true },
  });
  ids['k'] = k.id;
  const x = await prisma.course.create({
    data: {
      categoryId: k.id,
      slug: `webhook-${run}-x`,
      levelLabel: 'X',
      levelOrder: 1,
      title: `X ${run}`,
      pricingType: 'paid',
      publicationStatus: 'published',
    },
    select: { id: true },
  });
  ids['x'] = x.id;

  ids['singleX'] = (
    await prisma.product.create({
      data: {
        productType: 'single_course',
        courseId: x.id,
        displayName: 'Single X',
        priceAmount: '200000',
        accessDurationDays: 365,
        gracePeriodDays: 2,
        createdByUserId: users['owner']!,
      },
      select: { id: true },
    })
  ).id;
  ids['bundleK'] = (
    await prisma.product.create({
      data: {
        productType: 'category_bundle',
        categoryId: k.id,
        displayName: 'Bundle K',
        priceAmount: '300000',
        accessDurationDays: 365,
        createdByUserId: users['owner']!,
      },
      select: { id: true },
    })
  ).id;

  // The fake hosted page is registered here, as main.ts registers it when
  // PAYMENT_PROVIDER=fake: its POST delivers a webhook over HTTP, so the app must
  // actually listen, and API_PUBLIC_URL must point at it.
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.withFakePaymentPage()],
  }).compile();
  // rawBody: the signature covers the bytes as they arrived, and nothing else.
  app = moduleRef.createNestApplication({ rawBody: true });
  app.setGlobalPrefix('api', { exclude: ['health'] });
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  process.env['API_PUBLIC_URL'] = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  const userIds = Object.values(users);
  await prisma.paymentOrder.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.accessGrant.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.product.deleteMany({ where: { createdByUserId: users['owner']! } });
  await prisma.course.deleteMany({ where: { slug: { startsWith: `webhook-${run}-` } } });
  await prisma.category.deleteMany({ where: { slug: { startsWith: `webhook-${run}-` } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('FR-COM-03 — only a verified signature is trusted', () => {
  it('serves an unsigned caller with 401, not 403 — no guard, deliberately', async () => {
    const order = await pendingOrder('buyer', 'singleX', '200000');

    const response = await deliver(bodyFor(order, 'paid', '200000'), null).expect(401);

    // 403 FORBIDDEN_NO_POLICY here would mean someone "fixed" the controller with
    // a guard, and every real gateway would be refused.
    expect(response.body.errorCode).toBe('WEBHOOK_SIGNATURE_INVALID');
    expect((await orderRow(order.id)).orderStatus).toBe('pending');
  });

  it('refuses a signature with one flipped character, writing nothing', async () => {
    const order = await pendingOrder('buyer', 'singleX', '200000');
    const body = bodyFor(order, 'paid', '200000');
    const signature = signFakeWebhook(body, SECRET);
    const flipped = `${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`;

    await deliver(body, flipped).expect(401);

    expect(await orderRow(order.id)).toEqual({
      orderStatus: 'pending',
      completedAt: null,
      rawWebhookPayload: null,
    });
    expect(await grantsOf('buyer')).toEqual([]);
  });

  it('refuses the same body re-serialized with different whitespace under the original signature', async () => {
    const order = await pendingOrder('buyer', 'singleX', '200000');
    const body = bodyFor(order, 'paid', '200000');
    const reserialized = JSON.stringify(JSON.parse(body), null, 2);

    await deliver(reserialized, signFakeWebhook(body, SECRET)).expect(401);

    expect((await orderRow(order.id)).orderStatus).toBe('pending');
  });

  it('answers 200 for an unknown reference and writes nothing', async () => {
    const before = await prisma.paymentOrder.count();
    const body = JSON.stringify({
      providerOrderReference: `never-minted-${run}`,
      outcome: 'paid',
      amount: '200000',
      currencyCode: 'VND',
    });

    await deliver(body).expect(200);

    expect(await prisma.paymentOrder.count()).toBe(before);
  });
});

describe('FR-COM-03 — settling an order', () => {
  let paidOrder: Order;

  it('marks a matching paid order paid and inserts a purchase grant from now', async () => {
    // The earlier pending orders for this learner stay pending and grant nothing.
    paidOrder = await pendingOrder('buyer', 'singleX', '200000');

    await deliver(bodyFor(paidOrder, 'paid', '200000')).expect(200);

    const order = await orderRow(paidOrder.id);
    expect(order.orderStatus).toBe('paid');
    expect(order.completedAt).not.toBeNull();
    expect(order.rawWebhookPayload).toMatchObject({ outcome: 'paid', amount: '200000' });

    const grants = await grantsOf('buyer');
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      scopeType: 'course',
      scopeCourseId: ids['x'],
      accessSource: 'purchase',
      sourceProductId: ids['singleX'],
      paymentOrderId: paidOrder.id,
      gracePeriodDays: 2,
      renewalCount: 0,
      revokedAt: null,
      grantedByUserId: null,
    });
    within(grants[0]!.expiresAt, Date.now() + 365 * DAY);
  });

  it('changes nothing when the same webhook is replayed', async () => {
    const before = await grantsOf('buyer');

    await deliver(bodyFor(paidOrder, 'paid', '200000')).expect(200);

    expect(await grantsOf('buyer')).toEqual(before);
  });

  it('never moves a terminal order, even on a later failed event', async () => {
    await deliver(bodyFor(paidOrder, 'failed', '200000')).expect(200);

    expect((await orderRow(paidOrder.id)).orderStatus).toBe('paid');
    expect(await grantsOf('buyer')).toHaveLength(1);
  });

  it('fails an order reported failed, with no grant', async () => {
    const order = await pendingOrder('failer', 'singleX', '200000');

    await deliver(bodyFor(order, 'failed', '200000')).expect(200);

    const row = await orderRow(order.id);
    expect(row.orderStatus).toBe('failed');
    expect(row.completedAt).not.toBeNull();
    expect(await grantsOf('failer')).toEqual([]);
  });

  it.each([
    ['a different amount', '1', 'VND'],
    ['a different currency', '200000', 'USD'],
    ['an unparsable amount', '200000.999', 'VND'],
  ])('fails a paid order reporting %s, with no grant', async (_label, amount, currency) => {
    const order = await pendingOrder('mismatch', 'singleX', '200000');

    await deliver(bodyFor(order, 'paid', amount, currency)).expect(200);

    expect((await orderRow(order.id)).orderStatus).toBe('failed');
    expect(await grantsOf('mismatch')).toEqual([]);
  });
});

describe('§7.4 — extending an existing grant', () => {
  it('stacks onto an owner-granted dated row, flipping its source and resetting reminders', async () => {
    const oldExpiry = new Date(Date.now() + 60 * DAY);
    const existing = await prisma.accessGrant.create({
      data: {
        userId: users['renewer']!,
        scopeType: 'course',
        scopeCourseId: ids['x']!,
        accessSource: 'granted_by_owner',
        grantedByUserId: users['owner']!,
        expiresAt: oldExpiry,
        sentReminderMilestones: ['day_30'],
      },
      select: { id: true },
    });
    const order = await pendingOrder('renewer', 'singleX', '200000');

    await deliver(bodyFor(order, 'paid', '200000')).expect(200);

    const grants = await grantsOf('renewer');
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      id: existing.id,
      accessSource: 'purchase',
      // The original grantor is kept; the row now also records the purchase.
      grantedByUserId: users['owner'],
      sourceProductId: ids['singleX'],
      paymentOrderId: order.id,
      renewalCount: 1,
      gracePeriodDays: 2,
      sentReminderMilestones: [],
    });
    // Sixty days left plus a full term — fourteen months, never twelve.
    expect(grants[0]!.expiresAt!.getTime()).toBe(oldExpiry.getTime() + 365 * DAY);
  });

  it('leaves a perpetual row untouched while still marking the order paid', async () => {
    const perpetual = await prisma.accessGrant.create({
      data: {
        userId: users['perpetual']!,
        scopeType: 'course',
        scopeCourseId: ids['x']!,
        accessSource: 'granted_by_owner',
        grantedByUserId: users['owner']!,
        expiresAt: null,
      },
    });
    const order = await pendingOrder('perpetual', 'singleX', '200000');

    await deliver(bodyFor(order, 'paid', '200000')).expect(200);

    expect((await orderRow(order.id)).orderStatus).toBe('paid');
    expect(await grantsOf('perpetual')).toEqual([perpetual]);
  });

  it('never extends a revoked row; it inserts a new one beside it', async () => {
    const revoked = await prisma.accessGrant.create({
      data: {
        userId: users['revoked']!,
        scopeType: 'course',
        scopeCourseId: ids['x']!,
        accessSource: 'purchase',
        expiresAt: new Date(Date.now() + 100 * DAY),
        revokedAt: new Date(),
      },
    });
    const order = await pendingOrder('revoked', 'singleX', '200000');

    await deliver(bodyFor(order, 'paid', '200000')).expect(200);

    const grants = await grantsOf('revoked');
    expect(grants).toHaveLength(2);
    expect(grants[0]).toEqual(revoked);
    expect(grants[1]).toMatchObject({ revokedAt: null, paymentOrderId: order.id, renewalCount: 0 });
    within(grants[1]!.expiresAt, Date.now() + 365 * DAY);
  });

  /**
   * EIGHT orders, not two. With two, the transactions almost never overlap —
   * one commits before the other reads — and this test passed against an
   * implementation with the advisory lock removed. Eight concurrent deliveries
   * reliably put several transactions between "read the grant" and "write the
   * grant" at once; without the lock they collide on the partial unique index or
   * stack onto the same stale expiry, and terms go missing. (P9 recorded the same
   * blind spot for its vote counter.)
   */
  it('stacks every one of several different paid orders delivered at the same moment', async () => {
    const orders = await Promise.all(
      Array.from({ length: 8 }, () => pendingOrder('concurrent', 'singleX', '200000')),
    );

    const responses = await Promise.all(
      orders.map((order) => deliver(bodyFor(order, 'paid', '200000'))),
    );
    expect(responses.map((response) => response.status)).toEqual(orders.map(() => 200));

    const grants = await grantsOf('concurrent');
    expect(grants).toHaveLength(1);
    expect(grants[0]!.renewalCount).toBe(7);
    // Eight full terms, each stacked on the last.
    within(grants[0]!.expiresAt, Date.now() + 8 * 365 * DAY);
    const paid = await prisma.paymentOrder.count({
      where: { userId: users['concurrent']!, orderStatus: 'paid' },
    });
    expect(paid).toBe(8);
  });

  it('inserts a category grant for a bundle and leaves the learner single-course grant alone', async () => {
    const single = await prisma.accessGrant.create({
      data: {
        userId: users['bundleBuyer']!,
        scopeType: 'course',
        scopeCourseId: ids['x']!,
        accessSource: 'purchase',
        expiresAt: new Date(Date.now() + 100 * DAY),
      },
    });
    const order = await pendingOrder('bundleBuyer', 'bundleK', '300000');

    await deliver(bodyFor(order, 'paid', '300000')).expect(200);

    const grants = await grantsOf('bundleBuyer');
    expect(grants).toHaveLength(2);
    expect(grants[0]).toEqual(single);
    expect(grants[1]).toMatchObject({
      scopeType: 'category',
      scopeCategoryId: ids['k'],
      paymentOrderId: order.id,
    });
  });
});

describe("the fake provider's hosted page", () => {
  it('renders the order with owner-entered text escaped', async () => {
    await prisma.product.update({
      where: { id: ids['bundleK']! },
      data: { displayName: 'Bundle <K> & co' },
    });
    const order = await pendingOrder('pageBuyer', 'bundleK', '300000');

    const response = await api().get(`/api/payments/fake/checkout/${order.reference}`).expect(200);

    expect(response.headers['content-type']).toContain('text/html');
    expect(response.text).toContain('Bundle &lt;K&gt; &amp; co');
    expect(response.text).not.toContain('<K>');
    expect(response.text).toContain('data-testid="fake-pay"');
  });

  it('delivers a signed webhook over HTTP on Pay, then redirects to the return page', async () => {
    const order = await pendingOrder('pageBuyer', 'singleX', '200000');

    const response = await api()
      .post(`/api/payments/fake/checkout/${order.reference}`)
      .type('form')
      .send({ outcome: 'paid' })
      .expect(303);

    expect(response.headers['location']).toBe(
      `http://learner.webhook.test/checkout/return?orderId=${order.id}`,
    );
    // The order settled through /api/webhooks/payment — the real path, over the
    // network — not through a call the page made in-process.
    expect((await orderRow(order.id)).orderStatus).toBe('paid');
    const grants = await grantsOf('pageBuyer');
    expect(grants.some((grant) => grant.paymentOrderId === order.id)).toBe(true);
  });

  it('fails an order on Fail', async () => {
    const order = await pendingOrder('pageBuyer', 'singleX', '200000');

    await api()
      .post(`/api/payments/fake/checkout/${order.reference}`)
      .type('form')
      .send({ outcome: 'failed' })
      .expect(303);

    expect((await orderRow(order.id)).orderStatus).toBe('failed');
  });

  it('refuses an unknown outcome and 404s an unknown reference', async () => {
    const order = await pendingOrder('pageBuyer', 'singleX', '200000');
    await api()
      .post(`/api/payments/fake/checkout/${order.reference}`)
      .type('form')
      .send({ outcome: 'refunded' })
      .expect(400);

    await api().get(`/api/payments/fake/checkout/never-minted-${run}`).expect(404);
  });
});
