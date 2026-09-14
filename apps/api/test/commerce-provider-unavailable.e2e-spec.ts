import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { getPrismaClient } from '@knowledge-explorer/database';
import { FAKE_PAYMENT_SIGNATURE_HEADER, signFakeWebhook } from '@knowledge-explorer/commerce';
import { AppModule } from '../src/app.module';
import { createPaymentProvider } from '../src/commerce/payment-provider.factory';

/**
 * An EMPTY STRING, not `delete`, and set BEFORE loadEnv.
 *
 * dotenv never overrides a key that is already present — and an empty string is
 * present. Deleting the key instead would let a developer's `.env` holding
 * `PAYMENT_PROVIDER="fake"` quietly re-enable the fake in the one suite that
 * asserts its absence, and every assertion below would then fail for a reason
 * that has nothing to do with the code.
 */
process.env['PAYMENT_PROVIDER'] = '';
loadEnv({ path: ['../../.env', '.env'] });

/**
 * A closed store — specs/p8a-commerce/spec.md, "PaymentProvider".
 *
 * The fake payment provider grants paid access to anyone who clicks a button, so
 * it is opt-in, never a default. With PAYMENT_PROVIDER unset, checkout and the
 * webhook answer 503, and the fake hosted page does not exist — asserted here
 * with the page's controller DELIBERATELY registered, to prove the handler-level
 * check stands on its own.
 */

const run = randomBytes(4).toString('hex');
const prisma = getPrismaClient();

let app: INestApplication;
const api = () => request(app.getHttpServer());

let learnerToken = '';
let ownerId = '';
let learnerId = '';
let productId = '';
const learnerCookie = (token: string) => `authjs.learner-session-token=${token}`;

beforeAll(async () => {
  const owner = await prisma.user.create({
    data: { email: `owner-closed-${run}@example.test`, userRole: 'admin_owner' },
    select: { id: true },
  });
  ownerId = owner.id;
  const learner = await prisma.user.create({
    data: { email: `learner-closed-${run}@example.test`, userRole: 'learner' },
    select: { id: true },
  });
  learnerId = learner.id;
  learnerToken = `tok-closed-${run}-${randomBytes(6).toString('hex')}`;
  await prisma.session.create({
    data: { sessionToken: learnerToken, userId: learner.id, expires: new Date(Date.now() + 3_600_000) },
  });

  const category = await prisma.category.create({
    data: { slug: `closed-${run}`, displayName: `Closed ${run}` },
    select: { id: true },
  });
  const course = await prisma.course.create({
    data: {
      categoryId: category.id,
      slug: `closed-${run}-course`,
      levelLabel: 'N5',
      levelOrder: 1,
      title: `Closed ${run}`,
      pricingType: 'paid',
      publicationStatus: 'published',
    },
    select: { id: true },
  });
  productId = (
    await prisma.product.create({
      data: {
        productType: 'single_course',
        courseId: course.id,
        displayName: 'Closed product',
        priceAmount: '200000',
        createdByUserId: owner.id,
      },
      select: { id: true },
    })
  ).id;

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.withFakePaymentPage()],
  }).compile();
  app = moduleRef.createNestApplication({ rawBody: true });
  app.setGlobalPrefix('api', { exclude: ['health'] });
  await app.init();
});

afterAll(async () => {
  await prisma.paymentOrder.deleteMany({ where: { userId: learnerId } });
  await prisma.product.deleteMany({ where: { createdByUserId: ownerId } });
  await prisma.course.deleteMany({ where: { slug: `closed-${run}-course` } });
  await prisma.category.deleteMany({ where: { slug: `closed-${run}` } });
  await prisma.session.deleteMany({ where: { userId: learnerId } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, learnerId] } } });
  await app.close();
});

describe('PAYMENT_PROVIDER unset — the store is closed, not faked', () => {
  it('answers checkout with 503 and creates no order', async () => {
    const response = await api()
      .post('/api/checkout')
      .set('Cookie', learnerCookie(learnerToken))
      .send({ productId })
      .expect(503);

    expect(response.body.errorCode).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
    expect(await prisma.paymentOrder.count({ where: { userId: learnerId } })).toBe(0);
  });

  it('answers the webhook with 503, even when correctly signed for the fake', async () => {
    const body = JSON.stringify({
      providerOrderReference: 'anything',
      outcome: 'paid',
      amount: '200000',
      currencyCode: 'VND',
    });
    const response = await api()
      .post('/api/webhooks/payment')
      .set('Content-Type', 'application/json')
      .set(FAKE_PAYMENT_SIGNATURE_HEADER, signFakeWebhook(body, 'any-secret'))
      .send(body)
      .expect(503);

    expect(response.body.errorCode).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
  });

  it('still quotes, so the confirm page can say the store is closed', async () => {
    const response = await api()
      .get('/api/checkout/quote')
      .query({ productId })
      .set('Cookie', learnerCookie(learnerToken))
      .expect(200);

    expect(response.body).toMatchObject({ paymentAvailable: false, blockedBy: null });
  });

  it('serves no fake hosted page, even with its controller registered', async () => {
    await api().get('/api/payments/fake/checkout/anything').expect(404);
    await api()
      .post('/api/payments/fake/checkout/anything')
      .type('form')
      .send({ outcome: 'paid' })
      .expect(404);
  });
});

describe('createPaymentProvider', () => {
  it('refuses to build the fake without a webhook secret', () => {
    expect(() => createPaymentProvider({ PAYMENT_PROVIDER: 'fake' })).toThrow(
      /PAYMENT_FAKE_WEBHOOK_SECRET/,
    );
  });

  it.each([
    ['unset', {}],
    ['empty', { PAYMENT_PROVIDER: '' }],
    ['a different case', { PAYMENT_PROVIDER: 'FAKE' }],
    ['a gateway that does not exist yet', { PAYMENT_PROVIDER: 'vnpay' }],
  ])('closes the store when PAYMENT_PROVIDER is %s', (_label, env) => {
    expect(createPaymentProvider(env).providerName).toBe('unavailable');
  });

  it('builds the fake only on the exact opt-in', () => {
    expect(
      createPaymentProvider({ PAYMENT_PROVIDER: 'fake', PAYMENT_FAKE_WEBHOOK_SECRET: 's' })
        .providerName,
    ).toBe('fake');
  });
});
