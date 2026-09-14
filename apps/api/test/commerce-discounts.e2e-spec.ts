import { randomBytes } from 'node:crypto';
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
  vietnamDayEnd,
  vietnamDayStart,
} from '@knowledge-explorer/commerce';
import { AppModule } from '../src/app.module';

// Set BEFORE loadEnv: dotenv never overrides a key that is already present.
process.env['PAYMENT_PROVIDER'] = 'fake';
process.env['PAYMENT_FAKE_WEBHOOK_SECRET'] = 'commerce-discounts-test-secret';
loadEnv({ path: ['../../.env', '.env'] });

/**
 * Discount codes — specs/p8a-commerce/spec.md, "Discount codes".
 *
 * Two properties here would pass a casual reading while being wrong:
 *
 *  - **a redemption is a PAID order.** Counting pending or failed orders would
 *    exhaust a capped code on abandoned checkouts.
 *  - **codes match case-insensitively by being stored uppercase.** `welcome10` and
 *    `WELCOME10` are one code, so the second is a 409, not a second row.
 */

const run = randomBytes(4).toString('hex');
const code = (label: string) => `${label}-${run}`.toUpperCase();
const prisma = getPrismaClient();

let app: INestApplication;
const api = () => request(app.getHttpServer());

const users: Record<string, { id: string; token: string }> = {};
const ids: Record<string, string> = {};
const adminCookie = (token: string) => `authjs.session-token=${token}`;

async function seedUser(key: string, userRole: string): Promise<void> {
  const user = await prisma.user.create({
    data: { email: `${key}-discounts-${run}@example.test`, userRole },
    select: { id: true },
  });
  const token = `tok-discounts-${run}-${randomBytes(6).toString('hex')}`;
  await prisma.session.create({
    data: { sessionToken: token, userId: user.id, expires: new Date(Date.now() + 3_600_000) },
  });
  users[key] = { id: user.id, token };
}

const post = (body: Record<string, unknown>, token = users['owner']!.token) =>
  api().post('/api/admin/discount-codes').set('Cookie', adminCookie(token)).send(body);

const patch = (codeId: string, body: Record<string, unknown>) =>
  api()
    .patch(`/api/admin/discount-codes/${codeId}`)
    .set('Cookie', adminCookie(users['owner']!.token))
    .send(body);

beforeAll(async () => {
  await seedUser('owner', 'admin_owner');
  await seedUser('admin', 'admin');
  for (const key of ['buyer', 'newbie', 'holder', 'lapsed', 'onceUser', 'inflight', 'free']) {
    await seedUser(key, 'learner');
  }

  const category = await prisma.category.create({
    data: { slug: `discounts-${run}`, displayName: `D ${run}` },
    select: { id: true },
  });
  for (const [key, order] of [
    ['a', 1],
    ['b', 2],
  ] as const) {
    const course = await prisma.course.create({
      data: {
        categoryId: category.id,
        slug: `discounts-${run}-${key}`,
        levelLabel: key.toUpperCase(),
        levelOrder: order,
        title: `Course ${key}`,
        pricingType: 'paid',
        publicationStatus: 'published',
      },
      select: { id: true },
    });
    ids[`course-${key}`] = course.id;
    ids[`product-${key}`] = (
      await prisma.product.create({
        data: {
          productType: 'single_course',
          courseId: course.id,
          displayName: `Product ${key}`,
          priceAmount: '200000',
          createdByUserId: users['owner']!.id,
        },
        select: { id: true },
      })
    ).id;
  }

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ rawBody: true });
  app.setGlobalPrefix('api', { exclude: ['health'] });
  await app.init();
});

afterAll(async () => {
  const userIds = Object.values(users).map((user) => user.id);
  await prisma.paymentOrder.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.accessGrant.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.discountCode.deleteMany({ where: { createdByUserId: users['owner']!.id } });
  await prisma.product.deleteMany({ where: { createdByUserId: users['owner']!.id } });
  await prisma.course.deleteMany({ where: { slug: { startsWith: `discounts-${run}-` } } });
  await prisma.category.deleteMany({ where: { slug: `discounts-${run}` } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

let welcomeId = '';

describe('creating discount codes', () => {
  it('stores a lowercase code uppercase, with its products and no limits by default', async () => {
    const response = await post({
      code: `  welcome-${run} `,
      percentOff: 10,
      productIds: [ids['product-a']],
    }).expect(201);

    welcomeId = response.body.codeId;
    expect(response.body).toMatchObject({
      code: code('welcome'),
      percentOff: 10,
      appliesToAllProducts: false,
      products: [{ productId: ids['product-a'], displayName: 'Product a' }],
      startsAt: null,
      endsAt: null,
      maxRedemptions: null,
      oncePerLearner: false,
      newPurchasesOnly: false,
      isActive: true,
      redemptionCount: 0,
    });
  });

  it('refuses the same code in another casing with 409', async () => {
    const response = await post({
      code: `Welcome-${run}`,
      percentOff: 20,
      appliesToAllProducts: true,
    }).expect(409);
    expect(response.body).toMatchObject({ errorCode: 'DISCOUNT_CODE_ALREADY_EXISTS', codeId: welcomeId });
  });

  it('turns picked dates into Vietnam day boundaries', async () => {
    const response = await post({
      code: `october-${run}`,
      percentOff: 15,
      appliesToAllProducts: true,
      startsOn: '2026-10-01',
      endsOn: '2026-10-31',
      maxRedemptions: 3,
      oncePerLearner: true,
      newPurchasesOnly: true,
    }).expect(201);

    expect(response.body).toMatchObject({
      startsAt: vietnamDayStart('2026-10-01').toISOString(),
      endsAt: vietnamDayEnd('2026-10-31').toISOString(),
      maxRedemptions: 3,
      oncePerLearner: true,
      newPurchasesOnly: true,
      appliesToAllProducts: true,
      products: [],
    });
  });

  it.each([
    ['0 percent', { percentOff: 0 }],
    ['101 percent', { percentOff: 101 }],
    ['a fractional percent', { percentOff: 10.5 }],
    ['a two-character code', { code: 'ab' }],
    ['a code with a space', { code: 'HELLO WORLD' }],
    ['a code with a diacritic', { code: 'GIẢM10' }],
    ['all products AND a list', { appliesToAllProducts: true, productIds: [] as string[] }],
    ['neither all products nor a list', { productIds: undefined }],
    ['an impossible start date', { startsOn: '2026-02-30' }],
    ['a window that ends before it starts', { startsOn: '2026-10-31', endsOn: '2026-10-01' }],
    ['a zero cap', { maxRedemptions: 0 }],
    ['an unknown field', { amountOff: 5000 }],
  ])('refuses %s with 400', async (_label, override) => {
    const body: Record<string, unknown> = {
      code: `refused-${run}`,
      percentOff: 10,
      productIds: [ids['product-b']],
      ...override,
    };
    if ('appliesToAllProducts' in override) body['productIds'] = [ids['product-b']];
    if ('productIds' in override && override.productIds === undefined) delete body['productIds'];

    const response = await post(body).expect(400);
    expect(response.body.errorCode).toBe('INVALID_BODY');
  });

  it('404s a product that does not exist', async () => {
    const response = await post({
      code: `ghost-${run}`,
      percentOff: 10,
      productIds: ['00000000-0000-4000-8000-000000000000'],
    }).expect(404);
    expect(response.body.errorCode).toBe('PRODUCT_NOT_FOUND');
  });
});

describe('editing discount codes', () => {
  it.each([
    ['the code', { code: 'RENAMED' }],
    ['the percentage', { percentOff: 50 }],
    ['the product list', { productIds: [] as string[] }],
    ['the all-products flag', { appliesToAllProducts: true }],
    ['nothing at all', {}],
  ])('refuses to change %s', async (_label, body) => {
    const response = await patch(welcomeId, body).expect(400);
    expect(response.body.errorCode).toBe('INVALID_BODY');
  });

  it('changes limits and the active flag', async () => {
    const response = await patch(welcomeId, {
      maxRedemptions: 1,
      oncePerLearner: true,
      newPurchasesOnly: true,
      endsOn: '2099-12-31',
    }).expect(200);

    expect(response.body).toMatchObject({
      maxRedemptions: 1,
      oncePerLearner: true,
      newPurchasesOnly: true,
      endsAt: vietnamDayEnd('2099-12-31').toISOString(),
      // Fixed fields are exactly as created.
      code: code('welcome'),
      percentOff: 10,
    });

    const cleared = await patch(welcomeId, { endsOn: null }).expect(200);
    expect(cleared.body.endsAt).toBeNull();
  });

  it('refuses an edit that would end the window before it starts', async () => {
    await patch(welcomeId, { startsOn: '2027-01-10' }).expect(200);
    const response = await patch(welcomeId, { endsOn: '2027-01-01' }).expect(400);
    expect(response.body.errorCode).toBe('INVALID_BODY');
    await patch(welcomeId, { startsOn: null }).expect(200);
  });

  it('404s an unknown or malformed code', async () => {
    for (const id of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
      const response = await patch(id, { isActive: false }).expect(404);
      expect(response.body.errorCode).toBe('DISCOUNT_CODE_NOT_FOUND');
    }
  });
});

describe('redemption counts', () => {
  it('counts paid orders only — never pending or failed ones', async () => {
    for (const orderStatus of ['pending', 'failed', 'paid', 'paid']) {
      await prisma.paymentOrder.create({
        data: {
          userId: users['buyer']!.id,
          productId: ids['product-a']!,
          providerName: 'fake',
          providerOrderReference: mintProviderOrderReference(),
          amount: '180000',
          listPriceAmount: '200000',
          currencyCode: 'VND',
          orderStatus,
          discountCodeId: welcomeId,
        },
      });
    }

    const response = await api()
      .get('/api/admin/discount-codes')
      .query({ pageSize: 50 })
      .set('Cookie', adminCookie(users['owner']!.token))
      .expect(200);

    const welcome = response.body.items.find((item: { codeId: string }) => item.codeId === welcomeId);
    expect(welcome.redemptionCount).toBe(2);
  });

  it('lets the owner lower the cap below the current count, exhausting the code', async () => {
    const response = await patch(welcomeId, { maxRedemptions: 1 }).expect(200);
    expect(response.body).toMatchObject({ maxRedemptions: 1, redemptionCount: 2 });
  });
});

describe('#8 — discount codes at checkout', () => {
  const DAY = 86_400_000;
  const learnerCookie = (key: string) => `authjs.learner-session-token=${users[key]!.token}`;

  const quote = (userKey: string, productKey: string, discountCode: string) =>
    api()
      .get('/api/checkout/quote')
      .query({ productId: ids[productKey]!, discountCode })
      .set('Cookie', learnerCookie(userKey));

  const checkout = (userKey: string, productKey: string, discountCode?: string) =>
    api()
      .post('/api/checkout')
      .set('Cookie', learnerCookie(userKey))
      .send({ productId: ids[productKey]!, ...(discountCode ? { discountCode } : {}) });

  async function seedCode(
    label: string,
    overrides: {
      percentOff?: number;
      products?: string[];
      startsAt?: Date;
      endsAt?: Date;
      maxRedemptions?: number;
      oncePerLearner?: boolean;
      newPurchasesOnly?: boolean;
      isActive?: boolean;
    } = {},
  ): Promise<{ id: string; code: string }> {
    const row = await prisma.discountCode.create({
      data: {
        code: code(label),
        percentOff: overrides.percentOff ?? 25,
        appliesToAllProducts: !overrides.products,
        startsAt: overrides.startsAt ?? null,
        endsAt: overrides.endsAt ?? null,
        maxRedemptions: overrides.maxRedemptions ?? null,
        oncePerLearner: overrides.oncePerLearner ?? false,
        newPurchasesOnly: overrides.newPurchasesOnly ?? false,
        isActive: overrides.isActive ?? true,
        createdByUserId: users['owner']!.id,
        products: { create: (overrides.products ?? []).map((productId) => ({ productId })) },
      },
      select: { id: true, code: true },
    });
    return row;
  }

  it('applies a code, lowercase, on the quote and records it on the order', async () => {
    await seedCode('quarter');

    const quoted = await quote('newbie', 'product-a', `quarter-${run}`).expect(200);
    expect(quoted.body).toMatchObject({
      listPriceAmount: '200000',
      amount: '150000',
      discount: { code: code('quarter'), percentOff: 25 },
      discountError: null,
      blockedBy: null,
    });

    const placed = await checkout('newbie', 'product-a', `quarter-${run}`).expect(201);
    const order = await prisma.paymentOrder.findUniqueOrThrow({
      where: { id: placed.body.orderId },
      select: { amount: true, listPriceAmount: true, discountCode: { select: { code: true } } },
    });
    expect(order.amount.toString()).toBe('150000');
    expect(order.listPriceAmount.toString()).toBe('200000');
    expect(order.discountCode?.code).toBe(code('quarter'));
  });

  it.each([
    ['an unknown code', 'nope', {}, 'DISCOUNT_CODE_NOT_FOUND'],
    ['a deactivated code', 'retired', { isActive: false }, 'DISCOUNT_CODE_NOT_FOUND'],
    ['a code whose window has not started', 'soon', { startsAt: new Date(Date.now() + DAY) }, 'DISCOUNT_CODE_OUTSIDE_WINDOW'],
    ['a code whose window has ended', 'gone', { endsAt: new Date(Date.now() - DAY) }, 'DISCOUNT_CODE_OUTSIDE_WINDOW'],
    ['a code for another product', 'other', { products: ['product-b'] }, 'DISCOUNT_CODE_NOT_APPLICABLE'],
  ])('reports %s on the quote at list price, and refuses it on POST with 422', async (_label, label, overrides, errorCode) => {
    if (label !== 'nope') {
      const { products, ...rest } = overrides as { products?: string[] };
      await seedCode(label, { ...rest, ...(products ? { products: products.map((key) => ids[key]!) } : {}) });
    }

    const quoted = await quote('newbie', 'product-a', `${label}-${run}`).expect(200);
    expect(quoted.body).toMatchObject({
      discount: null,
      discountError: { errorCode },
      amount: '200000',
      // A bad code is not a reason the purchase itself is blocked.
      blockedBy: null,
    });

    const refused = await checkout('newbie', 'product-a', `${label}-${run}`).expect(422);
    expect(refused.body.errorCode).toBe(errorCode);
  });

  it('refuses an exhausted code: paid redemptions have reached the cap', async () => {
    // WELCOME was capped at 1 above, and holds two paid orders.
    const quoted = await quote('newbie', 'product-a', `welcome-${run}`).expect(200);
    expect(quoted.body.discountError).toEqual({ errorCode: 'DISCOUNT_CODE_EXHAUSTED' });
  });

  it('refuses a once-per-learner code this learner already paid with, but not for another learner', async () => {
    const once = await seedCode('once', { oncePerLearner: true });
    await prisma.paymentOrder.create({
      data: {
        userId: users['onceUser']!.id,
        productId: ids['product-b']!,
        providerName: 'fake',
        providerOrderReference: mintProviderOrderReference(),
        amount: '150000',
        listPriceAmount: '200000',
        currencyCode: 'VND',
        orderStatus: 'paid',
        discountCodeId: once.id,
      },
    });

    expect((await quote('onceUser', 'product-a', `once-${run}`).expect(200)).body.discountError).toEqual({
      errorCode: 'DISCOUNT_CODE_ALREADY_USED',
    });
    expect((await quote('newbie', 'product-a', `once-${run}`).expect(200)).body.discountError).toBeNull();
  });

  it('refuses a new-purchases-only code while the same-scope grant is active, but lets a lapsed learner back in', async () => {
    await seedCode('fresh', { newPurchasesOnly: true });
    for (const [key, expiresAt] of [
      ['holder', new Date(Date.now() + 30 * DAY)],
      ['lapsed', new Date(Date.now() - 30 * DAY)],
    ] as const) {
      await prisma.accessGrant.create({
        data: {
          userId: users[key]!.id,
          scopeType: 'course',
          scopeCourseId: ids['course-a']!,
          accessSource: 'purchase',
          expiresAt,
        },
      });
    }

    expect((await quote('holder', 'product-a', `fresh-${run}`).expect(200)).body.discountError).toEqual({
      errorCode: 'DISCOUNT_CODE_NEW_PURCHASES_ONLY',
    });
    const lapsed = await quote('lapsed', 'product-a', `fresh-${run}`).expect(200);
    expect(lapsed.body).toMatchObject({ discountError: null, amount: '150000', isRenewal: true });
  });

  it('turns a 100% code into a zero-amount order that still goes to the provider', async () => {
    await seedCode('gratis', { percentOff: 100 });

    const placed = await checkout('free', 'product-a', `gratis-${run}`).expect(201);

    expect(placed.body.redirectUrl).toContain('/api/payments/fake/checkout/');
    const order = await prisma.paymentOrder.findUniqueOrThrow({
      where: { id: placed.body.orderId },
      select: { amount: true, orderStatus: true },
    });
    expect(order.amount.toString()).toBe('0');
    expect(order.orderStatus).toBe('pending');
  });

  it('grants at webhook time even after the code was deactivated — limits bind checkout only', async () => {
    const capped = await seedCode('inflight', { maxRedemptions: 1, oncePerLearner: true });
    const placed = await checkout('inflight', 'product-a', `inflight-${run}`).expect(201);

    await patch(capped.id, { isActive: false }).expect(200);

    const order = await prisma.paymentOrder.findUniqueOrThrow({
      where: { id: placed.body.orderId },
      select: { providerOrderReference: true, amount: true },
    });
    const body = JSON.stringify({
      providerOrderReference: order.providerOrderReference,
      outcome: 'paid',
      amount: order.amount.toString(),
      currencyCode: 'VND',
    });
    await api()
      .post('/api/webhooks/payment')
      .set('Content-Type', 'application/json')
      .set(FAKE_PAYMENT_SIGNATURE_HEADER, signFakeWebhook(body, 'commerce-discounts-test-secret'))
      .send(body)
      .expect(200);

    const settled = await prisma.paymentOrder.findUniqueOrThrow({
      where: { id: placed.body.orderId },
      select: { orderStatus: true },
    });
    expect(settled.orderStatus).toBe('paid');
    expect(
      await prisma.accessGrant.count({ where: { userId: users['inflight']!.id, paymentOrderId: placed.body.orderId } }),
    ).toBe(1);
  });
});

describe('§3 — only the owner sets prices', () => {
  it('refuses a plain admin with 403 FORBIDDEN_ROLE', async () => {
    const response = await post(
      { code: `admin-${run}`, percentOff: 5, appliesToAllProducts: true },
      users['admin']!.token,
    ).expect(403);
    expect(response.body.errorCode).toBe('FORBIDDEN_ROLE');

    await api()
      .get('/api/admin/discount-codes')
      .set('Cookie', adminCookie(users['admin']!.token))
      .expect(403);
  });
});
