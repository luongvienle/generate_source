import { createHash, randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import {
  API,
  FAKE_PAYMENT_SIGNATURE_HEADER,
  adminCookie,
  completeMagicLink,
  learnerCookie,
  prisma,
  seedLearner,
  seedStaff,
  signWebhook,
  waitForJob,
  type SeededUser,
} from './helpers';
import { seedCourse, type SeededCourse } from './seed';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * The browser scenario from specs/p8a-commerce/spec.md, "End-to-end verification".
 *
 * An owner prices, discounts and grants in admin-web; learners buy in learner-web
 * through the FAKE payment provider (opt-in; playwright.config.ts defaults it).
 * Four things here cannot be asserted in the api suites:
 *
 *  - **a product write shows up on the ISR course page without waiting out its
 *    300-second window** (step 3) — the revalidation hook, end to end.
 *  - **the sign-in page carries the confirm page as its callback** (step 4).
 *  - **a browser sitting on the provider's page holds no access** (step 6): the
 *    redirect grants nothing, only the webhook the Pay button delivers does.
 *  - **owner actions in one app change what a learner can do in the other**
 *    (steps 14–15).
 *
 * The magic link Auth.js mails is only logged to learner-web's stdout, which the
 * suite cannot read. Step 4 therefore asserts the callback the sign-in FORM
 * carries, and completes a real magic link to that path.
 */

const run = randomBytes(4).toString('hex');
const ADMIN_WEB = 'http://localhost:3000';
const DAY = 86_400_000;

let owner: SeededUser;
let admin: SeededUser;
let learnerA: SeededUser;
let learnerB: SeededUser;
let categoryId = '';
let categorySlug = '';
let courseX: SeededCourse;
let courseY: SeededCourse;
const products: Record<'singleX' | 'singleY' | 'bundleK', string> = {
  singleX: '',
  singleY: '',
  bundleK: '',
};
const discountCode = `WELCOME10-${run}`.toUpperCase();

let ownerContext: BrowserContext;
let learnerAContext: BrowserContext;
let learnerBContext: BrowserContext;
let ownerPage: Page;
let learnerAPage: Page;
let learnerBPage: Page;

test.describe.configure({ mode: 'serial' });

/** A real Auth.js magic link on admin-web's own origin, as its browser suite signs in. */
async function signInToAdmin(page: Page, email: string, callbackPath: string, landingTestId: string) {
  const raw = randomBytes(32).toString('hex');
  await prisma.verificationToken.create({
    data: {
      identifier: email,
      token: createHash('sha256').update(`${raw}${process.env['AUTH_SECRET'] ?? ''}`).digest('hex'),
      expires: new Date(Date.now() + 10 * 60_000),
    },
  });
  await page.goto(
    `${ADMIN_WEB}/api/auth/callback/email?token=${raw}&email=${encodeURIComponent(email)}` +
      `&callbackUrl=${encodeURIComponent(callbackPath)}`,
  );
  await expect(page.getByTestId(landingTestId)).toBeVisible();
}

/** Submit for review, pass the checklist, run the publish job — the owner's real path. */
async function publish(request: APIRequestContext, course: SeededCourse): Promise<void> {
  await request.post(`${API}/api/admin/courses/${course.courseId}/submit-review`, {
    headers: adminCookie(owner.token),
  });
  const checklist = await request.get(`${API}/api/admin/courses/${course.courseId}/publish-checklist`, {
    headers: adminCookie(owner.token),
  });
  const failing = ((await checklist.json()).items as { id: string; passed: boolean; reason: string }[])
    .filter((item) => !item.passed)
    .map((item) => `${item.id}: ${item.reason}`);
  expect(failing).toEqual([]);

  const response = await request.post(`${API}/api/admin/courses/${course.courseId}/publish`, {
    headers: adminCookie(owner.token),
  });
  expect(response.status()).toBe(202);
  const { generationJobId } = (await response.json()) as { generationJobId: string };
  expect(await waitForJob(generationJobId)).toBe('succeeded');
}

/** Creates a product through admin-web's Products screen, returning its id. */
async function createProductInUi(options: {
  type: 'single_course' | 'category_bundle';
  targetId: string;
  displayName: string;
  price: string;
}): Promise<string> {
  await ownerPage.goto(`${ADMIN_WEB}/products`);
  await ownerPage.getByTestId('products-target-search').fill(run);
  const form = ownerPage.getByTestId('product-create');
  await form.getByTestId(`product-type-${options.type}`).check();
  await expect(form.locator(`[data-testid="product-target"] option[value="${options.targetId}"]`)).toHaveCount(1);
  await form.getByTestId('product-target').selectOption(options.targetId);
  await form.getByTestId('product-display-name').fill(options.displayName);
  await form.getByTestId('product-price').fill(options.price);
  await form.getByTestId('product-create-save').click();

  const row = await expect
    .poll(async () =>
      prisma.product.findFirst({
        where: { displayName: options.displayName, isActive: true },
        select: { id: true },
      }),
    )
    .not.toBeNull()
    .then(() =>
      prisma.product.findFirstOrThrow({
        where: { displayName: options.displayName, isActive: true },
        select: { id: true },
      }),
    );
  return row.id;
}

const lessonStatus = async (request: APIRequestContext, lessonId: string, token: string) =>
  (await request.get(`${API}/api/lessons/${lessonId}`, { headers: learnerCookie(token) })).status();

const latestOrderOf = (userId: string) =>
  prisma.paymentOrder.findFirstOrThrow({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      providerOrderReference: true,
      orderStatus: true,
      amount: true,
      listPriceAmount: true,
      discountCode: { select: { code: true } },
    },
  });

/** Pay on the fake provider's page and wait for learner-web's return page to report. */
async function payOnProviderPage(page: Page, outcome: 'pay' | 'fail'): Promise<void> {
  await expect(page.getByTestId('fake-pay')).toBeVisible();
  await page.getByTestId(outcome === 'pay' ? 'fake-pay' : 'fake-fail').click();
  await expect(page).toHaveURL(/\/checkout\/return\?orderId=/);
  await expect(page.getByTestId(outcome === 'pay' ? 'return-paid' : 'return-failed')).toBeVisible();
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);

  owner = await seedStaff('admin_owner', `p8a-${run}`);
  admin = await seedStaff('admin', `p8a-${run}`);
  learnerA = await seedLearner('p8a-a', run);
  learnerB = await seedLearner('p8a-b', run);

  const category = await prisma.category.create({
    data: { slug: `p8a-${run}-k`, displayName: `Tiếng Nhật trọn bộ ${run}`, displayOrder: 0 },
    select: { id: true, slug: true },
  });
  categoryId = category.id;
  categorySlug = category.slug;

  const overview = 'Khoá học cho kịch bản thương mại P8a.';
  courseX = await seedCourse({
    run,
    ownerId: owner.id,
    pricingType: 'paid',
    title: `Khoá X ${run}`,
    overview,
    categoryId,
    levelOrder: 1,
    slugSuffix: 'x',
  });
  courseY = await seedCourse({
    run,
    ownerId: owner.id,
    pricingType: 'paid',
    title: `Khoá Y ${run}`,
    overview,
    categoryId,
    levelOrder: 2,
    slugSuffix: 'y',
  });

  ownerContext = await browser.newContext();
  learnerAContext = await browser.newContext({ baseURL: 'http://localhost:3002' });
  learnerBContext = await browser.newContext({ baseURL: 'http://localhost:3002' });
  ownerPage = await ownerContext.newPage();
  learnerAPage = await learnerAContext.newPage();
  learnerBPage = await learnerBContext.newPage();
});

test.afterAll(async () => {
  await Promise.all([ownerContext?.close(), learnerAContext?.close(), learnerBContext?.close()]);
  const userIds = [owner, admin, learnerA, learnerB].filter(Boolean).map((user) => user.id);
  const courseIds = [courseX, courseY].filter(Boolean).map((course) => course.courseId);

  // Foreign-key order: payment_orders → products/users and discount_codes → users
  // are NO ACTION, so they go first.
  await prisma.paymentOrder.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.discountCode.deleteMany({ where: { createdByUserId: { in: userIds } } });
  await prisma.accessGrant.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.lessonProgress.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.product.deleteMany({ where: { createdByUserId: { in: userIds } } });
  await prisma.publishedCourseStructure.deleteMany({ where: { courseId: { in: courseIds } } });
  await prisma.course.deleteMany({ where: { id: { in: courseIds } } });
  await prisma.category.deleteMany({ where: { id: categoryId } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

test('1. a paid course publishes through the product, priced in admin-web', async ({ request, page }) => {
  test.setTimeout(300_000);
  await signInToAdmin(ownerPage, owner.email, '/products', 'product-create');

  products.singleX = await createProductInUi({
    type: 'single_course',
    targetId: courseX.courseId,
    displayName: `Khoá X ${run}`,
    price: '200000',
  });
  products.singleY = await createProductInUi({
    type: 'single_course',
    targetId: courseY.courseId,
    displayName: `Khoá Y ${run}`,
    price: '200000',
  });

  // Paid throughout: the checklist passes on the products, not on a pricing flip.
  await publish(request, courseX);
  await publish(request, courseY);
  const published = await prisma.course.findMany({
    where: { id: { in: [courseX.courseId, courseY.courseId] } },
    select: { publicationStatus: true, pricingType: true },
  });
  expect(published).toEqual([
    { publicationStatus: 'published', pricingType: 'paid' },
    { publicationStatus: 'published', pricingType: 'paid' },
  ]);

  // Render X's page anonymously now, so the next step's reload hits a cached page.
  await page.goto(`/courses/${courseX.courseSlug}`);
  await expect(page.getByTestId('price-block')).toBeVisible();
  await expect(page.getByTestId('buy-single')).toBeVisible();
  await expect(page.getByTestId('bundle-offer')).toHaveCount(0);
});

test('2. a bundle not below the sum of its courses warns, without blocking', async () => {
  products.bundleK = await createProductInUi({
    type: 'category_bundle',
    targetId: categoryId,
    displayName: `Trọn bộ K ${run}`,
    price: '400000',
  });

  const warning = ownerPage.locator('[data-testid="product-warning"][data-code="BUNDLE_PRICE_NOT_BELOW_SUM"]');
  await expect(warning).toBeVisible();

  const bundleRow = ownerPage.locator(`[data-testid="product-row"][data-product-id="${products.bundleK}"]`);
  await bundleRow.getByTestId('product-price-check-toggle').click();
  await expect(bundleRow.getByTestId('price-check-sum')).toContainText(/400\.000/);
});

test('3. the bundle offer appears on the course page well inside the ISR window', async ({ page }) => {
  const started = Date.now();
  await expect(async () => {
    await page.goto(`/courses/${courseX.courseSlug}`);
    await expect(page.getByTestId('bundle-offer')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await expect(page.getByTestId('buy-bundle')).toBeVisible();
  // The page revalidates every 300 s; seeing the offer this soon is the hook.
  expect(Date.now() - started).toBeLessThan(60_000);
});

test('4. signing in from checkout returns to the confirm page', async () => {
  const checkoutPath = `/checkout/${products.singleX}`;

  await learnerAPage.goto(`/courses/${courseX.courseSlug}`);
  await learnerAPage.getByTestId('buy-single').click();
  await expect(learnerAPage).toHaveURL(new RegExp(`${checkoutPath}$`));
  await learnerAPage.getByTestId('checkout-signin').click();

  await expect(learnerAPage).toHaveURL(/\/signin\?callbackUrl=/);
  await expect(learnerAPage.locator('input[name="callbackUrl"]')).toHaveValue(checkoutPath);

  // Not an open redirect: an absolute URL is dropped rather than carried.
  await learnerAPage.goto('/signin?callbackUrl=https%3A%2F%2Fexample.com%2Fsteal');
  await expect(learnerAPage.locator('input[name="callbackUrl"]')).toHaveCount(0);
  await learnerAPage.goto('/signin?callbackUrl=%2F%2Fexample.com');
  await expect(learnerAPage.locator('input[name="callbackUrl"]')).toHaveCount(0);

  await completeMagicLink(learnerAPage, learnerA.email, checkoutPath);
  await expect(learnerAPage).toHaveURL(new RegExp(`${checkoutPath}$`));
  await expect(learnerAPage.getByTestId('checkout-amount')).toContainText(/200\.000/);
  const resulting = await learnerAPage.getByTestId('checkout-resulting-expiry').getAttribute('data-iso');
  expect(Math.abs(new Date(resulting!).getTime() - (Date.now() + 365 * DAY))).toBeLessThan(120_000);
});

test('5. a discount code, entered in lowercase, lowers the amount', async () => {
  await ownerPage.goto(`${ADMIN_WEB}/discount-codes`);
  const form = ownerPage.getByTestId('code-create');
  await form.getByTestId('code-value').fill(discountCode.toLowerCase());
  await form.getByTestId('code-percent').fill('10');
  await form.getByTestId('code-cap').fill('1');
  await form.getByTestId('code-once').check();
  await form.getByTestId('code-new-only').check();
  await form.locator(`[data-testid="code-product"][data-product-id="${products.singleX}"]`).check();
  await form.getByTestId('code-create-save').click();
  await expect(ownerPage.locator(`[data-testid="code-row"][data-code="${discountCode}"]`)).toBeVisible();

  await learnerAPage.getByTestId('checkout-discount-input').fill(discountCode.toLowerCase());
  await learnerAPage.getByTestId('checkout-discount-apply').click();
  await expect(learnerAPage.getByTestId('checkout-discount-applied')).toBeVisible();
  await expect(learnerAPage.getByTestId('checkout-amount')).toContainText(/180\.000/);
  await expect(learnerAPage.getByTestId('checkout-list-price')).toContainText(/200\.000/);
});

test('6. a browser sitting on the provider page holds no access', async ({ request }) => {
  await learnerAPage.getByTestId('checkout-pay').click();
  await expect(learnerAPage).toHaveURL(/localhost:3001\/api\/payments\/fake\/checkout\//);
  await expect(learnerAPage.getByTestId('fake-pay')).toBeVisible();

  // Before anything is clicked on the provider page: pending, and still refused.
  const order = await latestOrderOf(learnerA.id);
  expect(order.orderStatus).toBe('pending');
  const refused = await request.get(`${API}/api/lessons/${courseX.lessons[1]!.id}`, {
    headers: learnerCookie(learnerA.token),
  });
  expect(refused.status()).toBe(403);
  expect((await refused.json()).errorCode).toBe('LESSON_NOT_ENTITLED');
});

test('7. paying on the provider page grants access through the webhook', async ({ request }) => {
  await payOnProviderPage(learnerAPage, 'pay');

  await learnerAPage.getByTestId('return-course-link').click();
  await learnerAPage.goto(`/lessons/${courseX.lessons[1]!.id}`);
  await expect(learnerAPage.getByTestId('lesson-body')).toBeVisible();
  expect(await lessonStatus(request, courseX.lessons[1]!.id, learnerA.token)).toBe(200);

  const order = await latestOrderOf(learnerA.id);
  expect(order.orderStatus).toBe('paid');
  expect(order.amount.toString()).toBe('180000');
  expect(order.listPriceAmount.toString()).toBe('200000');
  expect(order.discountCode?.code).toBe(discountCode);

  const grants = await prisma.accessGrant.findMany({
    where: { userId: learnerA.id, scopeCourseId: courseX.courseId },
  });
  expect(grants).toHaveLength(1);
  expect(grants[0]).toMatchObject({ accessSource: 'purchase', renewalCount: 0, paymentOrderId: order.id });
  expect(Math.abs(grants[0]!.expiresAt!.getTime() - (Date.now() + 365 * DAY))).toBeLessThan(120_000);
});

test('8. replay changes nothing, a tampered signature is refused, a wrong amount fails the order', async ({
  request,
}) => {
  const paid = await latestOrderOf(learnerA.id);
  const body = JSON.stringify({
    providerOrderReference: paid.providerOrderReference,
    outcome: 'paid',
    amount: '180000',
    currencyCode: 'VND',
  });
  const before = await prisma.accessGrant.findFirstOrThrow({
    where: { userId: learnerA.id, scopeCourseId: courseX.courseId },
  });

  const replay = await request.post(`${API}/api/webhooks/payment`, {
    headers: { 'Content-Type': 'application/json', [FAKE_PAYMENT_SIGNATURE_HEADER]: signWebhook(body) },
    data: body,
  });
  expect(replay.status()).toBe(200);
  expect(
    await prisma.accessGrant.findFirstOrThrow({ where: { userId: learnerA.id, scopeCourseId: courseX.courseId } }),
  ).toEqual(before);

  const signature = signWebhook(body);
  const tampered = await request.post(`${API}/api/webhooks/payment`, {
    headers: {
      'Content-Type': 'application/json',
      [FAKE_PAYMENT_SIGNATURE_HEADER]: `${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`,
    },
    data: body,
  });
  expect(tampered.status()).toBe(401);
  expect((await tampered.json()).errorCode).toBe('WEBHOOK_SIGNATURE_INVALID');

  // A fresh checkout for Y, then a correctly signed "paid" for the wrong amount.
  const placed = await request.post(`${API}/api/checkout`, {
    headers: learnerCookie(learnerA.token),
    data: { productId: products.singleY },
  });
  expect(placed.status()).toBe(201);
  const order = await latestOrderOf(learnerA.id);
  const wrong = JSON.stringify({
    providerOrderReference: order.providerOrderReference,
    outcome: 'paid',
    amount: '1',
    currencyCode: 'VND',
  });
  const mismatch = await request.post(`${API}/api/webhooks/payment`, {
    headers: { 'Content-Type': 'application/json', [FAKE_PAYMENT_SIGNATURE_HEADER]: signWebhook(wrong) },
    data: wrong,
  });
  expect(mismatch.status()).toBe(200);
  expect((await latestOrderOf(learnerA.id)).orderStatus).toBe('failed');
  expect(
    await prisma.accessGrant.count({ where: { userId: learnerA.id, scopeCourseId: courseY.courseId } }),
  ).toBe(0);
});

test("9. §7.4: renewing two months early stacks onto the remaining term", async () => {
  const grant = await prisma.accessGrant.findFirstOrThrow({
    where: { userId: learnerA.id, scopeCourseId: courseX.courseId },
    select: { id: true },
  });
  const oldExpiry = new Date(Date.now() + 60 * DAY);
  await prisma.accessGrant.update({
    where: { id: grant.id },
    data: { expiresAt: oldExpiry, sentReminderMilestones: ['day_30'] },
  });

  // The code's one redemption was step 7, and the cap is evaluated first.
  await learnerAPage.goto(`/checkout/${products.singleX}?code=${discountCode.toLowerCase()}`);
  await expect(learnerAPage.getByTestId('checkout-discount-error')).toHaveAttribute(
    'data-code',
    'DISCOUNT_CODE_EXHAUSTED',
  );

  await learnerAPage.goto(`/checkout/${products.singleX}`);
  const resulting = await learnerAPage.getByTestId('checkout-resulting-expiry').getAttribute('data-iso');
  expect(new Date(resulting!).getTime()).toBe(oldExpiry.getTime() + 365 * DAY);
  await learnerAPage.getByTestId('checkout-pay').click();
  await payOnProviderPage(learnerAPage, 'pay');

  const renewed = await prisma.accessGrant.findFirstOrThrow({
    where: { userId: learnerA.id, scopeCourseId: courseX.courseId },
  });
  // The same row, fourteen months out — never twelve.
  expect(renewed.id).toBe(grant.id);
  expect(renewed.expiresAt!.getTime()).toBe(oldExpiry.getTime() + 365 * DAY);
  expect(renewed.renewalCount).toBe(1);
  expect(renewed.sentReminderMilestones).toEqual([]);
});

test('10. renewing again, with more than a term banked, is refused with no pay button', async ({ request }) => {
  await learnerAPage.goto(`/checkout/${products.singleX}`);
  await expect(learnerAPage.getByTestId('checkout-blocked')).toHaveAttribute('data-code', 'CHECKOUT_TERM_TOO_LONG');
  await expect(learnerAPage.getByTestId('checkout-pay')).toHaveCount(0);

  const refused = await request.post(`${API}/api/checkout`, {
    headers: learnerCookie(learnerA.token),
    data: { productId: products.singleX },
  });
  expect(refused.status()).toBe(409);
  expect((await refused.json()).errorCode).toBe('CHECKOUT_TERM_TOO_LONG');
});

test('11. overlap warns in both directions and still sells', async ({ request }) => {
  await learnerAPage.goto(`/checkout/${products.bundleK}`);
  const overlap = learnerAPage.locator('[data-testid="checkout-warning"][data-code="BUNDLE_OVERLAPS_OWNED_COURSES"]');
  await expect(overlap).toContainText(`Khoá X ${run}`);
  await learnerAPage.getByTestId('checkout-pay').click();
  await payOnProviderPage(learnerAPage, 'pay');

  expect(
    await prisma.accessGrant.count({ where: { userId: learnerA.id, scopeCategoryId: categoryId, revokedAt: null } }),
  ).toBe(1);
  // Y was never bought singly; the bundle covers it.
  expect(await lessonStatus(request, courseY.lessons[1]!.id, learnerA.token)).toBe(200);

  await learnerAPage.goto(`/checkout/${products.singleY}`);
  await expect(
    learnerAPage.locator('[data-testid="checkout-warning"][data-code="COURSE_COVERED_BY_BUNDLE"]'),
  ).toBeVisible();
  await expect(learnerAPage.getByTestId('checkout-pay')).toBeVisible();
});

test('12. a failed payment grants nothing and is listed as failed', async () => {
  await completeMagicLink(learnerBPage, learnerB.email, `/checkout/${products.singleX}`);
  await expect(learnerBPage.getByTestId('checkout-page')).toBeVisible();
  await learnerBPage.getByTestId('checkout-pay').click();
  await payOnProviderPage(learnerBPage, 'fail');

  expect(await prisma.accessGrant.count({ where: { userId: learnerB.id } })).toBe(0);
  await learnerBPage.goto('/me/orders');
  await expect(learnerBPage.locator('[data-testid="my-order"][data-status="failed"]')).toHaveCount(1);
});

test('13. the sixth order in an hour is refused with 429', async ({ request }) => {
  // B placed one order in step 12.
  for (let index = 0; index < 4; index += 1) {
    const placed = await request.post(`${API}/api/checkout`, {
      headers: learnerCookie(learnerB.token),
      data: { productId: products.singleX },
    });
    expect(placed.status()).toBe(201);
  }
  const refused = await request.post(`${API}/api/checkout`, {
    headers: learnerCookie(learnerB.token),
    data: { productId: products.singleX },
  });
  expect(refused.status()).toBe(429);
  const body = await refused.json();
  expect(body.errorCode).toBe('CHECKOUT_RATE_LIMITED');
  expect(body.retryAfterSeconds).toBeGreaterThan(0);
});

test('14. an owner grant in admin-web blocks checkout; revoking it blocks reading', async ({ request }) => {
  await ownerPage.goto(`${ADMIN_WEB}/grants`);
  const grantForm = async () => {
    const form = ownerPage.getByTestId('grant-create');
    await form.getByTestId('grant-learner-email').fill(learnerB.email);
    await form.getByTestId('grant-scope-category').check();
    await form.getByTestId('grant-target-search').fill(run);
    await expect(form.locator(`[data-testid="grant-target"] option[value="${categoryId}"]`)).toHaveCount(1);
    await form.getByTestId('grant-target').selectOption(categoryId);
    await form.getByTestId('grant-perpetual').check();
    await form.getByTestId('grant-create-save').click();
  };

  await grantForm();
  await ownerPage.getByTestId('grants-learner-filter').fill(learnerB.email);
  const row = ownerPage.locator('[data-testid="grant-row"]').filter({ hasText: learnerB.email });
  await expect(row).toHaveAttribute('data-state', 'active');

  await learnerBPage.goto(`/checkout/${products.singleX}`);
  await expect(learnerBPage.getByTestId('checkout-blocked')).toHaveAttribute('data-code', 'CHECKOUT_ALREADY_PERPETUAL');
  await learnerBPage.goto(`/checkout/${products.bundleK}`);
  await expect(learnerBPage.getByTestId('checkout-blocked')).toHaveAttribute('data-code', 'CHECKOUT_ALREADY_PERPETUAL');
  expect(await lessonStatus(request, courseX.lessons[1]!.id, learnerB.token)).toBe(200);

  // Granting the same scope again is refused, with the existing grant described.
  await grantForm();
  await expect(ownerPage.getByTestId('grant-create-error')).toContainText('already holds a live grant');

  await row.getByTestId('grant-revoke').click();
  await row.getByTestId('grant-revoke-confirm').click();
  // The revoked grant leaves the live list — what the owner sees — before the
  // filter changes. (Switching straight away once exposed a stale-reload race in
  // the page, fixed there; this waits on the user-visible outcome either way.)
  await expect(row).toHaveCount(0);
  await ownerPage.getByTestId('grants-status').selectOption('revoked');
  await expect(
    ownerPage.locator('[data-testid="grant-row"][data-state="revoked"]').filter({ hasText: learnerB.email }),
  ).toBeVisible();

  // "Revocation takes effect on the next request."
  expect(await lessonStatus(request, courseX.lessons[1]!.id, learnerB.token)).toBe(403);
});

test('15. deactivating products warns about exactly the courses left unsellable', async ({ page, request }) => {
  const deactivate = async (productId: string) => {
    await ownerPage.goto(`${ADMIN_WEB}/products`);
    const row = ownerPage.locator(`[data-testid="product-row"][data-product-id="${productId}"]`);
    await row.getByTestId('product-edit-toggle').click();
    await row.getByTestId('product-edit-active').uncheck();
    await row.getByTestId('product-edit-save').click();
  };

  // The bundle still covers X, so this leaves nothing unsellable.
  await deactivate(products.singleX);
  await expect(ownerPage.locator(`[data-testid="product-row"][data-product-id="${products.singleX}"]`)).toHaveCount(0);
  await expect(ownerPage.getByTestId('product-warnings')).toHaveCount(0);

  await deactivate(products.bundleK);
  const notForSale = ownerPage.locator('[data-testid="product-warning"][data-code="COURSE_NOT_FOR_SALE"]');
  await expect(notForSale).toContainText(`Khoá X ${run}`);
  // Y keeps its own single product.
  await expect(notForSale).not.toContainText(`Khoá Y ${run}`);

  await expect(async () => {
    await page.goto(`/courses/${courseX.courseSlug}`);
    await expect(page.getByTestId('not-for-sale')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });

  const checkout = await request.post(`${API}/api/checkout`, {
    headers: learnerCookie(learnerA.token),
    data: { productId: products.singleX },
  });
  expect(checkout.status()).toBe(404);
  expect((await checkout.json()).errorCode).toBe('PRODUCT_NOT_FOUND');
  // A's grants are untouched by products going off sale.
  expect(await lessonStatus(request, courseX.lessons[1]!.id, learnerA.token)).toBe(200);
});

test('16. §3 — who may buy, who may grant, and what the webhook answers', async ({ request }) => {
  // The owner's admin-web cookie is not a learner session.
  const ownerBuys = await request.post(`${API}/api/checkout`, {
    headers: adminCookie(owner.token),
    data: { productId: products.singleY },
  });
  expect(ownerBuys.status()).toBe(401);

  const adminGrants = await request.get(`${API}/api/admin/grants`, { headers: adminCookie(admin.token) });
  expect(adminGrants.status()).toBe(403);
  expect((await adminGrants.json()).errorCode).toBe('FORBIDDEN_ROLE');

  const learnerGrants = await request.get(`${API}/api/admin/grants`, { headers: adminCookie(learnerA.token) });
  expect(learnerGrants.status()).toBe(403);

  // No guard on the webhook: an unsigned caller meets the signature check, not RolesGuard.
  const unsigned = await request.post(`${API}/api/webhooks/payment`, {
    headers: { 'Content-Type': 'application/json' },
    data: JSON.stringify({ providerOrderReference: 'x', outcome: 'paid', amount: '1', currencyCode: 'VND' }),
  });
  expect(unsigned.status()).toBe(401);
});

test("17. the owner sees every order; a learner sees only their own", async () => {
  await ownerPage.goto(`${ADMIN_WEB}/orders`);
  await ownerPage.getByTestId('orders-learner-filter').fill(`-e2e-${run}@`);
  const rows = ownerPage.getByTestId('order-row');
  await expect(rows.filter({ hasText: learnerA.email }).filter({ hasText: discountCode })).toHaveCount(1);
  await expect(
    ownerPage.locator('[data-testid="order-row"][data-status="failed"]').filter({ hasText: learnerB.email }),
  ).not.toHaveCount(0);

  const ownOrders = await prisma.paymentOrder.count({ where: { userId: learnerA.id } });
  await learnerAPage.goto('/me/orders');
  await expect(learnerAPage.getByTestId('my-order')).toHaveCount(ownOrders);
  expect(await learnerAPage.content()).not.toContain(learnerB.email);
  // No provider reference crosses to the learner.
  const paid = await latestOrderOf(learnerA.id);
  expect(await learnerAPage.content()).not.toContain(paid.providerOrderReference);
});
