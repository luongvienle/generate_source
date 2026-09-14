import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { getPrismaClient } from '@knowledge-explorer/database';
import { AppModule } from '../src/app.module';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * FR-COM-01 — specs/p8a-commerce/spec.md, "Products".
 *
 * Two properties here would pass a casual reading while being wrong:
 *
 *  - **a second active product is a 409, not a 500.** §8's partial unique index
 *    is the real guard; a P2002 left unhandled looks fine until two owners save.
 *  - **the price-check sums only published courses that have a single product.**
 *    Counting a draft, or a course with no price as zero, produces a warning the
 *    owner cannot act on.
 */

const run = randomBytes(4).toString('hex');
const prisma = getPrismaClient();
const api = () => request(app.getHttpServer());

let app: INestApplication;
let ownerId = '';
let ownerToken = '';
let adminToken = '';
let learnerToken = '';

const adminCookie = (token: string) => `authjs.session-token=${token}`;
const learnerCookie = (token: string) => `authjs.learner-session-token=${token}`;

let categoryK = '';
let categoryL = '';
let courseA = '';
let courseB = '';
let courseC = '';
let courseD = '';
let courseE = '';
let bundleK = '';
let singleA = '';

async function seedUser(local: string, userRole: string): Promise<[string, string]> {
  const user = await prisma.user.create({
    data: { email: `${local}-products-${run}@example.test`, userRole },
    select: { id: true },
  });
  const sessionToken = `tok-products-${run}-${randomBytes(6).toString('hex')}`;
  await prisma.session.create({
    data: { sessionToken, userId: user.id, expires: new Date(Date.now() + 3_600_000) },
  });
  return [user.id, sessionToken];
}

async function seedCourse(
  categoryId: string,
  label: string,
  levelOrder: number,
  publicationStatus: string,
): Promise<string> {
  const course = await prisma.course.create({
    data: {
      categoryId,
      slug: `products-${run}-${label}`,
      levelLabel: label.toUpperCase(),
      levelOrder,
      title: `Course ${label} ${run}`,
      pricingType: 'paid',
      publicationStatus,
    },
    select: { id: true },
  });
  return course.id;
}

const create = (body: Record<string, unknown>, token = ownerToken) =>
  api().post('/api/admin/products').set('Cookie', adminCookie(token)).send(body);

/**
 * A stand-in for learner-web's `/api/revalidate`, so the hook a product write
 * fires is asserted rather than eyeballed. `revalidateLearnerPages` reads
 * LEARNER_WEB_URL at call time, so pointing it here before the first write is
 * enough.
 */
let learnerWebStandIn: Server;
const revalidations: Array<{ courseSlug: string | null; categorySlug: string | null }> = [];

beforeAll(async () => {
  learnerWebStandIn = createServer((incoming, outgoing) => {
    let body = '';
    incoming.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    incoming.on('end', () => {
      if (incoming.url === '/api/revalidate') revalidations.push(JSON.parse(body));
      outgoing.writeHead(200, { 'Content-Type': 'application/json' });
      outgoing.end('{}');
    });
  });
  await new Promise<void>((resolve) => learnerWebStandIn.listen(0, '127.0.0.1', resolve));
  const { port } = learnerWebStandIn.address() as AddressInfo;
  process.env['LEARNER_WEB_URL'] = `http://127.0.0.1:${port}`;
  process.env['REVALIDATE_SECRET'] ||= 'commerce-products-test-secret';

  [ownerId, ownerToken] = await seedUser('owner', 'admin_owner');
  [, adminToken] = await seedUser('admin', 'admin');
  [, learnerToken] = await seedUser('learner', 'learner');

  categoryK = (
    await prisma.category.create({
      data: { slug: `products-${run}-k`, displayName: `Category K ${run}` },
      select: { id: true },
    })
  ).id;
  categoryL = (
    await prisma.category.create({
      data: { slug: `products-${run}-l`, displayName: `Category L ${run}` },
      select: { id: true },
    })
  ).id;

  courseA = await seedCourse(categoryK, 'a', 1, 'published');
  courseB = await seedCourse(categoryK, 'b', 2, 'published');
  courseC = await seedCourse(categoryK, 'c', 3, 'draft');
  courseD = await seedCourse(categoryK, 'd', 4, 'published');
  courseE = await seedCourse(categoryL, 'e', 1, 'published');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api', { exclude: ['health'] });
  await app.init();
});

afterAll(async () => {
  await new Promise<void>((resolve) => learnerWebStandIn.close(() => resolve()));
  await prisma.accessGrant.deleteMany({ where: { user: { email: { contains: `-products-${run}@` } } } });
  await prisma.product.deleteMany({ where: { createdByUserId: ownerId } });
  await prisma.course.deleteMany({ where: { slug: { startsWith: `products-${run}-` } } });
  await prisma.category.deleteMany({ where: { slug: { startsWith: `products-${run}-` } } });
  await prisma.user.deleteMany({ where: { email: { contains: `-products-${run}@` } } });
  await app.close();
});

describe('FR-COM-01 — creating products', () => {
  it('creates a single-course product with the locked defaults', async () => {
    const response = await create({
      productType: 'single_course',
      courseId: courseA,
      displayName: 'Course A',
      priceAmount: '200000',
    }).expect(201);

    singleA = response.body.product.productId;
    expect(response.body.warnings).toEqual([]);
    expect(response.body.product).toMatchObject({
      productType: 'single_course',
      displayName: 'Course A',
      // Money is a string on the wire, never a number.
      priceAmount: '200000',
      currencyCode: 'VND',
      accessDurationDays: 365,
      gracePeriodDays: 0,
      isActive: true,
      target: { scopeType: 'course', courseId: courseA, categoryId: categoryK },
    });

    const row = await prisma.product.findUniqueOrThrow({
      where: { id: singleA },
      select: { renewalType: true, bundleInclusionPolicy: true, createdByUserId: true },
    });
    expect(row).toEqual({
      renewalType: 'manual',
      bundleInclusionPolicy: 'all_current_and_future',
      createdByUserId: ownerId,
    });
  });

  it.each([
    ['a fractional price', { priceAmount: '1500.50' }],
    ['a numeric price', { priceAmount: 1500 }],
    ['a negative price', { priceAmount: '-1' }],
    ['an eleven-digit price', { priceAmount: '12345678901' }],
    ['a non-VND currency', { currencyCode: 'USD' }],
    ['a renewal type', { renewalType: 'auto' }],
    ['a bundle inclusion policy', { bundleInclusionPolicy: 'snapshot_at_purchase' }],
    ['an unknown field', { upvotes: 1 }],
    ['a zero-day duration', { accessDurationDays: 0 }],
    ['a negative grace period', { gracePeriodDays: -1 }],
    ['a category id on a single product', { categoryId: '00000000-0000-4000-8000-000000000000' }],
  ])('refuses %s', async (_label, override) => {
    const response = await create({
      productType: 'single_course',
      courseId: courseB,
      displayName: 'Refused',
      priceAmount: '1000',
      ...override,
    }).expect(400);
    expect(response.body.errorCode).toBe('INVALID_BODY');
  });

  it('accepts a zero price, which still goes through the provider', async () => {
    const response = await create({
      productType: 'single_course',
      courseId: courseE,
      displayName: 'Free-priced E',
      priceAmount: '0',
    }).expect(201);
    expect(response.body.product.priceAmount).toBe('0');
    await prisma.product.delete({ where: { id: response.body.product.productId } });
  });

  it('refuses an unknown course or category with 404', async () => {
    const unknown = '00000000-0000-4000-8000-000000000000';
    expect(
      (
        await create({
          productType: 'single_course',
          courseId: unknown,
          displayName: 'X',
          priceAmount: '1',
        }).expect(404)
      ).body.errorCode,
    ).toBe('COURSE_NOT_FOUND');
    expect(
      (
        await create({
          productType: 'category_bundle',
          categoryId: unknown,
          displayName: 'X',
          priceAmount: '1',
        }).expect(404)
      ).body.errorCode,
    ).toBe('CATEGORY_NOT_FOUND');
  });

  it('refuses a second active product for the same course with 409 and the existing id', async () => {
    const response = await create({
      productType: 'single_course',
      courseId: courseA,
      displayName: 'Course A again',
      priceAmount: '1',
    }).expect(409);

    expect(response.body).toMatchObject({
      errorCode: 'PRODUCT_ALREADY_ACTIVE',
      productId: singleA,
    });
  });
});

describe('FR-COM-01 — the bundle price-check', () => {
  it('warns, without blocking, when a bundle is not below the sum of its published single prices', async () => {
    await create({
      productType: 'single_course',
      courseId: courseB,
      displayName: 'Course B',
      priceAmount: '250000',
    }).expect(201);
    // A DRAFT course's price must not enter the sum.
    await create({
      productType: 'single_course',
      courseId: courseC,
      displayName: 'Course C (draft)',
      priceAmount: '999000',
    }).expect(201);

    const response = await create({
      productType: 'category_bundle',
      categoryId: categoryK,
      displayName: 'Bundle K',
      priceAmount: '450000',
    }).expect(201);
    bundleK = response.body.product.productId;

    expect(response.body.product.target).toMatchObject({ scopeType: 'category', courseId: null });
    expect(response.body.warnings).toHaveLength(1);
    const [warning] = response.body.warnings;
    expect(warning.code).toBe('BUNDLE_PRICE_NOT_BELOW_SUM');
    expect(warning.priceCheck).toMatchObject({
      bundlePriceAmount: '450000',
      sumOfSinglePriceAmounts: '450000',
      isBelowSum: false,
    });
    expect(warning.priceCheck.includedCourses.map((c: { courseId: string }) => c.courseId)).toEqual([
      courseA,
      courseB,
    ]);
    // Published, but unpriced: listed rather than summed as zero.
    expect(warning.priceCheck.coursesWithoutSingleProduct).toEqual([
      { courseId: courseD, title: `Course d ${run}` },
    ]);
  });

  it('serves the same comparison from GET price-check', async () => {
    const response = await api()
      .get(`/api/admin/products/${bundleK}/price-check`)
      .set('Cookie', adminCookie(ownerToken))
      .expect(200);

    expect(response.body).toMatchObject({
      sumOfSinglePriceAmounts: '450000',
      isBelowSum: false,
    });
  });

  it('does not warn when the bundle is below the sum', async () => {
    await create({
      productType: 'single_course',
      courseId: courseE,
      displayName: 'Course E',
      priceAmount: '100000',
    }).expect(201);

    const response = await create({
      productType: 'category_bundle',
      categoryId: categoryL,
      displayName: 'Bundle L',
      priceAmount: '90000',
    }).expect(201);

    expect(response.body.warnings).toEqual([]);
    const check = await api()
      .get(`/api/admin/products/${response.body.product.productId}/price-check`)
      .set('Cookie', adminCookie(ownerToken))
      .expect(200);
    expect(check.body.isBelowSum).toBe(true);
  });

  it('refuses a second active bundle for the same category', async () => {
    const response = await create({
      productType: 'category_bundle',
      categoryId: categoryK,
      displayName: 'Bundle K again',
      priceAmount: '1',
    }).expect(409);
    expect(response.body).toMatchObject({ errorCode: 'PRODUCT_ALREADY_ACTIVE', productId: bundleK });
  });

  it('refuses a price-check on a single product, and 404s an unknown or malformed id', async () => {
    const single = await api()
      .get(`/api/admin/products/${singleA}/price-check`)
      .set('Cookie', adminCookie(ownerToken))
      .expect(400);
    expect(single.body.errorCode).toBe('PRICE_CHECK_NOT_BUNDLE');

    for (const id of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
      const missing = await api()
        .get(`/api/admin/products/${id}/price-check`)
        .set('Cookie', adminCookie(ownerToken))
        .expect(404);
      expect(missing.body.errorCode).toBe('PRODUCT_NOT_FOUND');
    }
  });
});

describe('listing products', () => {
  it("lists a category's bundle and its courses' single products, with picker options", async () => {
    const response = await api()
      .get('/api/admin/products')
      .query({ categoryId: categoryK, targetSearch: run })
      .set('Cookie', adminCookie(ownerToken))
      .expect(200);

    const ids = response.body.items.map((item: { productId: string }) => item.productId);
    expect(ids).toContain(singleA);
    expect(ids).toContain(bundleK);
    expect(response.body.total).toBe(4);

    const optionIds = response.body.courseOptions.map((option: { id: string }) => option.id);
    expect(optionIds).toEqual(expect.arrayContaining([courseA, courseB, courseC, courseD]));
    expect(response.body.categoryOptions.map((option: { id: string }) => option.id)).toEqual(
      expect.arrayContaining([categoryK, categoryL]),
    );
  });

  it('refuses an unknown query parameter', async () => {
    await api()
      .get('/api/admin/products')
      .query({ sort: 'price' })
      .set('Cookie', adminCookie(ownerToken))
      .expect(400);
  });
});

describe('§3 — only the owner sets prices', () => {
  it('refuses a plain admin with 403 FORBIDDEN_ROLE', async () => {
    const response = await create(
      { productType: 'single_course', courseId: courseD, displayName: 'D', priceAmount: '1' },
      adminToken,
    ).expect(403);
    expect(response.body.errorCode).toBe('FORBIDDEN_ROLE');

    await api().get('/api/admin/products').set('Cookie', adminCookie(adminToken)).expect(403);
  });

  it("refuses learner-web's cookie, which SessionGuard does not read, with 401", async () => {
    await api()
      .get('/api/admin/products')
      .set('Cookie', learnerCookie(learnerToken))
      .expect(401);
  });

  it('refuses an anonymous caller with 401', async () => {
    await api().get('/api/admin/products').expect(401);
  });
});

describe('§9.2 PATCH — price, duration, grace period, active flag', () => {
  const patch = (productId: string, body: unknown, token = ownerToken) =>
    api()
      .patch(`/api/admin/products/${productId}`)
      .set('Cookie', adminCookie(token))
      .send(body as object);

  it.each([
    ['a display name', { displayName: 'Renamed' }],
    ['a product type', { productType: 'category_bundle' }],
    ['a course id', { courseId: courseB }],
    ['a renewal type', { renewalType: 'auto' }],
    ['a fractional price', { priceAmount: '10.5' }],
    ['nothing at all', {}],
  ])('refuses %s', async (_label, body) => {
    const response = await patch(singleA, body).expect(400);
    expect(response.body.errorCode).toBe('INVALID_BODY');
  });

  it('404s an unknown or malformed product, and refuses a plain admin', async () => {
    await patch('00000000-0000-4000-8000-000000000000', { priceAmount: '1' }).expect(404);
    await patch('not-a-uuid', { priceAmount: '1' }).expect(404);
    const admin = await patch(singleA, { priceAmount: '1' }, adminToken).expect(403);
    expect(admin.body.errorCode).toBe('FORBIDDEN_ROLE');
  });

  it("changes the price and revalidates the course page and its category page", async () => {
    revalidations.length = 0;

    const response = await patch(singleA, { priceAmount: '210000' }).expect(200);

    expect(response.body.product.priceAmount).toBe('210000');
    expect(response.body.warnings).toEqual([]);
    expect(revalidations).toContainEqual({
      courseSlug: `products-${run}-a`,
      categorySlug: `products-${run}-k`,
    });
  });

  it("leaves an existing grant's own grace period untouched", async () => {
    const [learnerId] = await seedUser('grace-learner', 'learner');
    const grant = await prisma.accessGrant.create({
      data: {
        userId: learnerId,
        scopeType: 'course',
        scopeCourseId: courseA,
        accessSource: 'purchase',
        sourceProductId: singleA,
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
        gracePeriodDays: 0,
      },
      select: { id: true },
    });

    await patch(singleA, { gracePeriodDays: 7, accessDurationDays: 30 }).expect(200);

    const row = await prisma.accessGrant.findUniqueOrThrow({
      where: { id: grant.id },
      select: { gracePeriodDays: true },
    });
    expect(row.gracePeriodDays).toBe(0);
  });

  it('does not warn when a deactivated single product is still covered by the bundle', async () => {
    const response = await patch(singleA, { isActive: false }).expect(200);

    expect(response.body.product.isActive).toBe(false);
    expect(response.body.warnings).toEqual([]);
  });

  it('names every published paid course a bundle deactivation leaves unsellable, and revalidates them', async () => {
    revalidations.length = 0;

    const response = await patch(bundleK, { isActive: false }).expect(200);

    const notForSale = response.body.warnings.find(
      (warning: { code: string }) => warning.code === 'COURSE_NOT_FOR_SALE',
    );
    // A lost its single product earlier; D never had one. B keeps its own, and
    // C is a draft that nothing needs to sell.
    expect(notForSale.courses.map((course: { courseId: string }) => course.courseId)).toEqual([
      courseA,
      courseD,
    ]);

    // A bundle shows on its category page and on every PUBLISHED course page.
    expect(revalidations).toContainEqual({ courseSlug: null, categorySlug: `products-${run}-k` });
    const courseSlugs = revalidations.map((call) => call.courseSlug).filter(Boolean);
    expect(courseSlugs).toEqual(
      expect.arrayContaining([`products-${run}-a`, `products-${run}-b`, `products-${run}-d`]),
    );
    expect(courseSlugs).not.toContain(`products-${run}-c`);
  });

  it('does not re-warn about a course that was already unsellable before the save', async () => {
    const response = await patch(bundleK, { priceAmount: '400000' }).expect(200);

    expect(
      response.body.warnings.some((warning: { code: string }) => warning.code === 'COURSE_NOT_FOR_SALE'),
    ).toBe(false);
  });

  it('refuses to reactivate a product while another is active for the same target', async () => {
    const replacement = await create({
      productType: 'category_bundle',
      categoryId: categoryK,
      displayName: 'Bundle K2',
      priceAmount: '300000',
    }).expect(201);
    const replacementId = replacement.body.product.productId;

    const response = await patch(bundleK, { isActive: true }).expect(409);
    expect(response.body).toMatchObject({
      errorCode: 'PRODUCT_ALREADY_ACTIVE',
      productId: replacementId,
    });

    await patch(replacementId, { isActive: false }).expect(200);
    const reactivated = await patch(bundleK, { isActive: true }).expect(200);
    expect(reactivated.body.product.isActive).toBe(true);
  });
});
