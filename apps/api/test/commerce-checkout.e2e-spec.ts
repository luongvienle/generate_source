import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { getPrismaClient } from '@knowledge-explorer/database';
import { PAYMENT_PROVIDER, type PaymentProvider } from '@knowledge-explorer/commerce';
import { AppModule } from '../src/app.module';

// Set BEFORE loadEnv: dotenv never overrides a key that is already present, so
// these win over whatever a developer's .env holds.
process.env['PAYMENT_PROVIDER'] = 'fake';
process.env['PAYMENT_FAKE_WEBHOOK_SECRET'] = 'commerce-checkout-test-secret';
process.env['API_PUBLIC_URL'] = 'http://api.checkout.test';
process.env['LEARNER_WEB_URL'] = 'http://learner.checkout.test';
process.env['CHECKOUT_HOURLY_CAP'] = '5';
loadEnv({ path: ['../../.env', '.env'] });

/**
 * FR-COM-02 — specs/p8a-commerce/spec.md, "Checkout".
 *
 * Three properties here would pass a casual reading while being wrong:
 *
 *  - **the refusal ladder has an order.** A product failing two conditions must
 *    report the EARLIER one, or the confirm page tells a learner the wrong reason.
 *  - **the term-cap boundary is exact.** Renewal opens once one term or less
 *    remains; §7.4's own two-months-early example must pass.
 *  - **a checkout writes no grant.** Only a verified webhook grants (FR-COM-03).
 */

const run = randomBytes(4).toString('hex');
const prisma = getPrismaClient();
const DAY = 86_400_000;

let app: INestApplication;
const api = () => request(app.getHttpServer());

const users: Record<string, { id: string; token: string }> = {};
const learnerCookie = (token: string) => `authjs.learner-session-token=${token}`;
const adminCookie = (token: string) => `authjs.session-token=${token}`;

const ids: Record<string, string> = {};

async function seedUser(key: string, userRole: string): Promise<void> {
  const user = await prisma.user.create({
    data: { email: `${key}-checkout-${run}@example.test`, userRole },
    select: { id: true },
  });
  const token = `tok-checkout-${run}-${randomBytes(6).toString('hex')}`;
  await prisma.session.create({
    data: { sessionToken: token, userId: user.id, expires: new Date(Date.now() + 3_600_000) },
  });
  users[key] = { id: user.id, token };
}

async function seedCourse(
  key: string,
  categoryId: string,
  levelOrder: number,
  publicationStatus: string,
  pricingType: string,
): Promise<void> {
  const course = await prisma.course.create({
    data: {
      categoryId,
      slug: `checkout-${run}-${key}`,
      levelLabel: key.toUpperCase(),
      levelOrder,
      title: `Course ${key} ${run}`,
      pricingType,
      publicationStatus,
    },
    select: { id: true },
  });
  ids[key] = course.id;
}

async function seedProduct(
  key: string,
  target: { courseId: string } | { categoryId: string },
  priceAmount: string,
  accessDurationDays = 365,
  isActive = true,
): Promise<void> {
  const product = await prisma.product.create({
    data: {
      productType: 'courseId' in target ? 'single_course' : 'category_bundle',
      ...target,
      displayName: `Product ${key}`,
      priceAmount,
      accessDurationDays,
      isActive,
      createdByUserId: users['owner']!.id,
    },
    select: { id: true },
  });
  ids[key] = product.id;
}

async function seedGrant(
  userKey: string,
  scope: { scopeCourseId: string } | { scopeCategoryId: string },
  expiresAt: Date | null,
): Promise<void> {
  await prisma.accessGrant.create({
    data: {
      userId: users[userKey]!.id,
      scopeType: 'scopeCourseId' in scope ? 'course' : 'category',
      ...scope,
      accessSource: expiresAt === null ? 'granted_by_owner' : 'purchase',
      expiresAt,
    },
  });
}

const quote = (userKey: string, productKey: string) =>
  api()
    .get('/api/checkout/quote')
    .query({ productId: ids[productKey]! })
    .set('Cookie', learnerCookie(users[userKey]!.token));

const checkout = (userKey: string, productId: string) =>
  api().post('/api/checkout').set('Cookie', learnerCookie(users[userKey]!.token)).send({ productId });

const within = (actual: string, expected: Date, toleranceMs = 10_000) =>
  expect(Math.abs(new Date(actual).getTime() - expected.getTime())).toBeLessThan(toleranceMs);

beforeAll(async () => {
  for (const [key, role] of [
    ['owner', 'admin_owner'],
    ['admin', 'admin'],
    ['buyer', 'learner'],
    ['other', 'learner'],
    ['perpetualCourse', 'learner'],
    ['perpetualCategory', 'learner'],
    ['early', 'learner'],
    ['banked', 'learner'],
    ['lapsed', 'learner'],
    ['bundleOwner', 'learner'],
    ['rate', 'learner'],
  ] as const) {
    await seedUser(key, role);
  }

  const k = await prisma.category.create({
    data: { slug: `checkout-${run}-k`, displayName: `K ${run}` },
    select: { id: true },
  });
  const empty = await prisma.category.create({
    data: { slug: `checkout-${run}-empty`, displayName: `Empty ${run}` },
    select: { id: true },
  });
  ids['k'] = k.id;
  ids['empty'] = empty.id;

  await seedCourse('x', k.id, 1, 'published', 'paid');
  await seedCourse('y', k.id, 2, 'published', 'paid');
  await seedCourse('draft', k.id, 3, 'draft', 'paid');
  await seedCourse('free', k.id, 4, 'published', 'free');
  await seedCourse('draftFree', k.id, 5, 'draft', 'free');
  await seedCourse('emptyDraft', empty.id, 1, 'draft', 'paid');

  await seedProduct('singleX', { courseId: ids['x']! }, '200000');
  await seedProduct('inactiveX', { courseId: ids['x']! }, '1', 365, false);
  await seedProduct('singleY', { courseId: ids['y']! }, '150000', 30);
  await seedProduct('singleDraft', { courseId: ids['draft']! }, '100000');
  await seedProduct('singleFree', { courseId: ids['free']! }, '100000');
  await seedProduct('singleDraftFree', { courseId: ids['draftFree']! }, '100000');
  await seedProduct('bundleK', { categoryId: k.id }, '300000');
  await seedProduct('bundleEmpty', { categoryId: empty.id }, '100000');

  const now = Date.now();
  await seedGrant('perpetualCourse', { scopeCourseId: ids['x']! }, null);
  await seedGrant('perpetualCategory', { scopeCategoryId: k.id }, null);
  // §7.4's example: sixty days left on a 365-day term.
  await seedGrant('early', { scopeCourseId: ids['x']! }, new Date(now + 60 * DAY));
  await seedGrant('banked', { scopeCourseId: ids['x']! }, new Date(now + 366 * DAY));
  await seedGrant('lapsed', { scopeCourseId: ids['x']! }, new Date(now - 10 * DAY));
  await seedGrant('bundleOwner', { scopeCategoryId: k.id }, new Date(now + 90 * DAY));

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api', { exclude: ['health'] });
  await app.init();
});

afterAll(async () => {
  const userIds = Object.values(users).map((user) => user.id);
  // Foreign-key order: payment_orders references products and users with NO ACTION.
  await prisma.paymentOrder.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.discountCode.deleteMany({ where: { createdByUserId: users['owner']!.id } });
  await prisma.accessGrant.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.product.deleteMany({ where: { createdByUserId: users['owner']!.id } });
  await prisma.course.deleteMany({ where: { slug: { startsWith: `checkout-${run}-` } } });
  await prisma.category.deleteMany({ where: { slug: { startsWith: `checkout-${run}-` } } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('FR-COM-02 — the quote', () => {
  it('previews a first purchase: list price, a term from now, no warnings, nothing blocking', async () => {
    const response = await quote('buyer', 'singleX').expect(200);

    expect(response.body).toMatchObject({
      product: {
        productId: ids['singleX'],
        productType: 'single_course',
        accessDurationDays: 365,
        currencyCode: 'VND',
      },
      target: { scopeType: 'course', courseSlug: `checkout-${run}-x`, categorySlug: `checkout-${run}-k` },
      listPriceAmount: '200000',
      amount: '200000',
      discount: null,
      currentExpiresAt: null,
      isRenewal: false,
      warnings: [],
      blockedBy: null,
      paymentAvailable: true,
    });
    within(response.body.resultingExpiresAt, new Date(Date.now() + 365 * DAY));
  });

  it("previews §7.4's early renewal as a full term added to the sixty days left", async () => {
    const response = await quote('early', 'singleX').expect(200);

    expect(response.body.blockedBy).toBeNull();
    expect(response.body.isRenewal).toBe(true);
    within(response.body.resultingExpiresAt, new Date(Date.now() + 425 * DAY));
  });

  it('stacks a lapsed grant from now, and does not trip the cap', async () => {
    const response = await quote('lapsed', 'singleX').expect(200);

    expect(response.body).toMatchObject({ blockedBy: null, isRenewal: true });
    within(response.body.resultingExpiresAt, new Date(Date.now() + 365 * DAY));
  });
});

describe('FR-COM-02 — creating an order', () => {
  let orderId = '';

  it('creates a pending order, then redirects to the provider with a minted reference', async () => {
    const response = await checkout('buyer', ids['singleX']!).expect(201);

    orderId = response.body.orderId;
    const order = await prisma.paymentOrder.findUniqueOrThrow({
      where: { id: orderId },
      select: {
        orderStatus: true,
        providerName: true,
        providerOrderReference: true,
        amount: true,
        listPriceAmount: true,
        currencyCode: true,
        discountCodeId: true,
      },
    });
    expect(order).toMatchObject({
      orderStatus: 'pending',
      providerName: 'fake',
      currencyCode: 'VND',
      discountCodeId: null,
    });
    expect(order.amount.toString()).toBe('200000');
    expect(order.listPriceAmount.toString()).toBe('200000');
    expect(order.providerOrderReference).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(response.body.redirectUrl).toBe(
      `http://api.checkout.test/api/payments/fake/checkout/${order.providerOrderReference}`,
    );
  });

  it('writes no grant — a redirect never grants access', async () => {
    expect(await prisma.accessGrant.count({ where: { userId: users['buyer']!.id } })).toBe(0);
  });

  it('mints a distinct reference for every order', async () => {
    const second = await checkout('buyer', ids['singleX']!).expect(201);
    const references = await prisma.paymentOrder.findMany({
      where: { id: { in: [orderId, second.body.orderId] } },
      select: { providerOrderReference: true },
    });
    expect(new Set(references.map((row) => row.providerOrderReference)).size).toBe(2);
  });

  it("lists the learner's own orders and serves one of them to the return page", async () => {
    const list = await api()
      .get('/api/me/orders')
      .set('Cookie', learnerCookie(users['buyer']!.token))
      .expect(200);
    expect(list.body.total).toBe(2);
    expect(list.body.items[0]).toMatchObject({
      productId: ids['singleX'],
      amount: '200000',
      listPriceAmount: '200000',
      orderStatus: 'pending',
      target: { courseSlug: `checkout-${run}-x` },
    });
    // No provider reference crosses to the learner.
    expect(JSON.stringify(list.body)).not.toContain('providerOrderReference');

    const one = await api()
      .get(`/api/me/orders/${orderId}`)
      .set('Cookie', learnerCookie(users['buyer']!.token))
      .expect(200);
    expect(one.body.orderStatus).toBe('pending');
  });

  it("404s another learner's order exactly as it 404s a missing one", async () => {
    for (const id of [orderId, '00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
      const response = await api()
        .get(`/api/me/orders/${id}`)
        .set('Cookie', learnerCookie(users['other']!.token))
        .expect(404);
      expect(response.body.errorCode).toBe('ORDER_NOT_FOUND');
    }
  });
});

describe('FR-COM-02 — the refusal ladder, in order', () => {
  it.each([
    ['an unknown product', 'unknown'],
    ['an inactive product', 'inactiveX'],
  ])('404s %s on both the quote and the POST', async (_label, key) => {
    const productId = ids[key] ?? '00000000-0000-4000-8000-000000000000';
    ids['unknown'] = '00000000-0000-4000-8000-000000000000';

    expect((await quote('buyer', key).expect(404)).body.errorCode).toBe('PRODUCT_NOT_FOUND');
    expect((await checkout('buyer', productId).expect(404)).body.errorCode).toBe('PRODUCT_NOT_FOUND');
  });

  it.each([
    ['a course that is not published', 'buyer', 'singleDraft', 'CHECKOUT_COURSE_NOT_PUBLISHED'],
    ['a free course', 'buyer', 'singleFree', 'CHECKOUT_COURSE_FREE'],
    ['a bundle with no published course', 'buyer', 'bundleEmpty', 'CHECKOUT_BUNDLE_EMPTY'],
    ['a draft free course, reporting the EARLIER refusal', 'buyer', 'singleDraftFree', 'CHECKOUT_COURSE_NOT_PUBLISHED'],
    ['a course held perpetually', 'perpetualCourse', 'singleX', 'CHECKOUT_ALREADY_PERPETUAL'],
    ['a course whose category is held perpetually', 'perpetualCategory', 'singleY', 'CHECKOUT_ALREADY_PERPETUAL'],
    ['a bundle whose category is held perpetually', 'perpetualCategory', 'bundleK', 'CHECKOUT_ALREADY_PERPETUAL'],
  ])('refuses %s: 409 on POST, blockedBy on the quote', async (_label, userKey, productKey, errorCode) => {
    const quoted = await quote(userKey, productKey).expect(200);
    expect(quoted.body.blockedBy).toEqual({ errorCode });

    const refused = await checkout(userKey, ids[productKey]!).expect(409);
    expect(refused.body.errorCode).toBe(errorCode);
  });

  it('refuses a renewal that would bank more than two terms, saying when renewal opens', async () => {
    const grant = await prisma.accessGrant.findFirstOrThrow({
      where: { userId: users['banked']!.id },
      select: { expiresAt: true },
    });
    const expected = {
      errorCode: 'CHECKOUT_TERM_TOO_LONG',
      currentExpiresAt: grant.expiresAt!.toISOString(),
      renewableFrom: new Date(grant.expiresAt!.getTime() - 365 * DAY).toISOString(),
    };

    expect((await quote('banked', 'singleX').expect(200)).body.blockedBy).toEqual(expected);
    expect((await checkout('banked', ids['singleX']!).expect(409)).body).toMatchObject(expected);
  });

  it('allows a renewal that lands just inside now + 2 × duration', async () => {
    await prisma.accessGrant.updateMany({
      where: { userId: users['banked']!.id },
      data: { expiresAt: new Date(Date.now() + 365 * DAY - 60_000) },
    });

    expect((await quote('banked', 'singleX').expect(200)).body.blockedBy).toBeNull();
  });
});

describe('FR-COM-02 — overlap warnings, never blocking', () => {
  it('warns that a bundle includes a course the learner already owns, and still allows it', async () => {
    const response = await quote('perpetualCourse', 'bundleK').expect(200);

    // A perpetual SINGLE grant does not refuse a bundle; it only overlaps.
    expect(response.body.blockedBy).toBeNull();
    expect(response.body.warnings).toEqual([
      {
        code: 'BUNDLE_OVERLAPS_OWNED_COURSES',
        courses: [{ courseSlug: `checkout-${run}-x`, courseTitle: `Course x ${run}` }],
      },
    ]);
  });

  it('warns that an active bundle already covers the course being bought', async () => {
    const response = await quote('bundleOwner', 'singleY').expect(200);

    expect(response.body.blockedBy).toBeNull();
    expect(response.body.warnings).toEqual([
      {
        code: 'COURSE_COVERED_BY_BUNDLE',
        categorySlug: `checkout-${run}-k`,
        categoryName: `K ${run}`,
      },
    ]);
  });
});

describe('#9 — the hourly order cap', () => {
  it('refuses the sixth order in an hour with 429, while the quote still answers', async () => {
    for (let index = 0; index < 5; index += 1) {
      await checkout('rate', ids['singleX']!).expect(201);
    }

    const refused = await checkout('rate', ids['singleX']!).expect(429);
    expect(refused.body).toMatchObject({ errorCode: 'CHECKOUT_RATE_LIMITED', cap: 5 });
    expect(refused.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(refused.body.retryAfterSeconds).toBeLessThanOrEqual(3600);

    await quote('rate', 'singleX').expect(200);
  });
});

describe('§3 — only a learner buys', () => {
  it('refuses an anonymous checkout with 401', async () => {
    await api().post('/api/checkout').send({ productId: ids['singleX'] }).expect(401);
  });

  it("refuses admin-web's cookie, which LearnerSessionGuard does not read, with 401", async () => {
    await api()
      .post('/api/checkout')
      .set('Cookie', adminCookie(users['owner']!.token))
      .send({ productId: ids['singleX'] })
      .expect(401);
  });

  it('refuses a staff account presenting a learner-named cookie with 403 FORBIDDEN_ROLE', async () => {
    const response = await api()
      .post('/api/checkout')
      .set('Cookie', learnerCookie(users['admin']!.token))
      .send({ productId: ids['singleX'] })
      .expect(403);
    expect(response.body.errorCode).toBe('FORBIDDEN_ROLE');
  });

  it('refuses a malformed body', async () => {
    await checkout('buyer', 'not-a-uuid').expect(400);
  });
});

describe("the owner's order list", () => {
  const listOrders = (token: string, query: Record<string, string>) =>
    api().get('/api/admin/orders').query(query).set('Cookie', adminCookie(token));

  it('lists orders with their list price and discount code, and never the webhook payload', async () => {
    const code = await prisma.discountCode.create({
      data: {
        code: `LIST-${run}`.toUpperCase(),
        percentOff: 10,
        appliesToAllProducts: true,
        createdByUserId: users['owner']!.id,
      },
      select: { id: true },
    });
    const order = await prisma.paymentOrder.create({
      data: {
        userId: users['buyer']!.id,
        productId: ids['singleX']!,
        providerName: 'fake',
        providerOrderReference: `list-${run}`,
        amount: '180000',
        listPriceAmount: '200000',
        currencyCode: 'VND',
        orderStatus: 'paid',
        completedAt: new Date(),
        discountCodeId: code.id,
        rawWebhookPayload: { providerSecretishField: 'must not be listed' },
      },
      select: { id: true },
    });

    const response = await listOrders(users['owner']!.token, {
      status: 'paid',
      learnerEmail: `buyer-checkout-${run}`,
    }).expect(200);

    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0]).toMatchObject({
      orderId: order.id,
      learnerEmail: `buyer-checkout-${run}@example.test`,
      amount: '180000',
      listPriceAmount: '200000',
      discountCode: `LIST-${run}`.toUpperCase(),
      orderStatus: 'paid',
      providerName: 'fake',
      providerOrderReference: `list-${run}`,
      target: { courseSlug: `checkout-${run}-x` },
    });
    expect(JSON.stringify(response.body)).not.toContain('rawWebhookPayload');
    expect(JSON.stringify(response.body)).not.toContain('must not be listed');
  });

  it('filters by status', async () => {
    const pending = await listOrders(users['owner']!.token, {
      status: 'pending',
      learnerEmail: `buyer-checkout-${run}`,
    }).expect(200);
    expect(pending.body.items.every((item: { orderStatus: string }) => item.orderStatus === 'pending')).toBe(true);
    expect(pending.body.total).toBe(2);
  });

  it('refuses an unknown status, and refuses a plain admin with 403 FORBIDDEN_ROLE', async () => {
    await listOrders(users['owner']!.token, { status: 'shipped' }).expect(400);
    const response = await listOrders(users['admin']!.token, {}).expect(403);
    expect(response.body.errorCode).toBe('FORBIDDEN_ROLE');
  });
});

describe('a provider that fails to create a checkout', () => {
  it('fails the pending order and answers 502', async () => {
    const failing: PaymentProvider = {
      providerName: 'fake',
      createCheckout: () => Promise.reject(new Error('gateway down')),
      verifyWebhook: () => Promise.resolve(null),
      getOrderStatus: () => Promise.resolve('pending'),
    };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PAYMENT_PROVIDER)
      .useValue(failing)
      .compile();
    const failingApp = moduleRef.createNestApplication();
    failingApp.setGlobalPrefix('api', { exclude: ['health'] });
    await failingApp.init();

    try {
      const response = await request(failingApp.getHttpServer())
        .post('/api/checkout')
        .set('Cookie', learnerCookie(users['other']!.token))
        .send({ productId: ids['singleX'] })
        .expect(502);
      expect(response.body.errorCode).toBe('PAYMENT_PROVIDER_ERROR');

      const orders = await prisma.paymentOrder.findMany({
        where: { userId: users['other']!.id },
        select: { orderStatus: true, completedAt: true },
      });
      expect(orders).toHaveLength(1);
      expect(orders[0]!.orderStatus).toBe('failed');
      expect(orders[0]!.completedAt).not.toBeNull();
    } finally {
      await failingApp.close();
    }
  });
});
