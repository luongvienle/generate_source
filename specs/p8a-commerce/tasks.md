# Tasks: P8a — Commerce: products, checkout, webhook, grants

**Plan:** specs/p8a-commerce/plan.md

Tick boxes as work completes, not at the end — this file is the durable progress
state and is what survives a lost session.

Seven rules for this phase specifically:

- **Never run `prisma migrate dev`, `migrate reset` or `db push`.** Task 1 writes
  its migration by hand and applies it with `pnpm db:migrate`. The initial
  migration's nine hand-appended objects are what a diff-based generator drops,
  with no symptom (CLAUDE.md invariant 1).
- **§7.4's formula exists once.** Every expiry computation calls `stackExpiry`
  from `packages/commerce/src/renewal.ts`. A `new Date(now + days)` anywhere in
  `apps/api/src/commerce/` is the bug §7.4 names.
- **`isGrantActive` is the only activity predicate.** No SQL or Prisma `where`
  compares `expires_at` against now. Queries filter on `revoked_at` and identity;
  activity is decided in TypeScript by the P7 function.
- **The webhook verifies `request.rawBody` and never the parsed body.** If
  `rawBody` is missing, it is a 500, never a `JSON.stringify` fallback.
- **The fake provider is opt-in.** Unset `PAYMENT_PROVIDER` means checkout is
  closed. Never make `fake` the default in code, matching the image, LLM and TTS
  providers — the plan's approach 1 and 3 explain why this one differs.
- **Money crosses the wire as a digit string.** No `Number(priceAmount)` outside
  display formatting.
- **Earlier phases' suites keep passing unedited, with four named exceptions:**
  - `schema-fidelity.spec.ts` (task 1);
  - `learner.spec.ts` test 1 (task 7);
  - `seed.ts` (task 20);
  - `helpers.ts` (task 20).

  Any other P0–P9 test edit is a finding to report, not a fix to make quietly.

Before starting:
- `nvm use` (Node 22); ffmpeg and ffprobe present.
- `docker compose up -d --wait`, then `pnpm db:migrate`.
- **Copy the four new variables from `.env.example` into `.env`** once task 10 adds
  them.
- Stop any running api, admin-web or learner-web dev server before `pnpm test`
  (P7's finding: api suites flake under concurrent load and the failures lie).
- Confirm `pnpm --filter @knowledge-explorer/database test` is green — the
  baseline task 1 must not break.

---

## Slice A — The schema, before anything that reads it

- [x] **Task 1: the discount tables and the order columns, by hand**
  Write `packages/database/prisma/migrations/<timestamp>_add_discount_codes/migration.sql`
  exactly as the spec's schema section, with a header comment in the style of
  `20260913185000_add_topic_request_duplicate_of`: why hand-written, invariant 1,
  and why `list_price_amount` has no default. Mirror it in `schema.prisma`:
  - `DiscountCode` and `DiscountCodeProduct` (`@@id`, `onDelete: Cascade` on both
    sides);
  - `PaymentOrder.listPriceAmount @db.Decimal(12, 2)`, `discountCodeId`, and the
    relation with `onDelete: NoAction, onUpdate: NoAction`;
  - back-relations on `User` and `Product`;
  - `@@index` with `map:` for `idx_payment_orders_user_created`;
  - a comment naming the SQL-only objects (four CHECKs, the partial index).

  Extend `constraints.spec.ts` with a P8a describe block:
  - the four CHECKs exist;
  - inserting `percent_off = 0` and a lowercase `code` both raise;
  - the two FKs exist with `confdeltype` `a` (payment_orders → discount_codes) and
    `c` (discount_code_products → both);
  - both indexes exist;
  - `idx_payment_orders_discount_paid` has a predicate mentioning `order_status`.

  In `schema-fidelity.spec.ts`, add a commented `tablesAddedAfterSpec8 =
  ['discount_codes', 'discount_code_products']` to the allowed set, and add
  `('payment_orders','list_price_amount')` to the money test (expected count 3).
  - done when:
    - `pnpm db:migrate` applies cleanly;
    - `pnpm --filter @knowledge-explorer/database exec prisma migrate status`
      reports no pending migration and no drift;
    - `pnpm --filter @knowledge-explorer/database test` is green, including every
      pre-existing hand-written-DDL assertion **and** the new ones;
    - `pnpm --filter @knowledge-explorer/database exec prisma generate` then
      `pnpm typecheck` are green.

## Slice B — The pure rules, before any caller

- [x] **Task 2: renewal, discount and calendar rules**
  - **`packages/shared/src/commerce.ts`:** warning codes, `DISCOUNT_CODE_PATTERN`
    (`^[A-Z0-9-]{3,32}$`), `CHECKOUT_TERM_CAP_MULTIPLIER = 2`,
    `DEFAULT_CHECKOUT_HOURLY_CAP = 5`; exported from the barrel.
  - **`packages/commerce/src/renewal.ts`:**
    - `stackExpiry(currentExpiresAt: Date | null, now: Date, days: number)` —
      §7.4 verbatim, with the comment quoting it;
    - `exceedsTermCap(currentExpiresAt, now, days)`;
    - `renewableFrom(currentExpiresAt, days)`.
  - **`discount.ts`:** `applyPercentDiscount(listPrice: string, percentOff:
    number): string` in `BigInt` or integer arithmetic, half-up;
    `normalizeDiscountCode(input)` → trimmed uppercase.
  - **`calendar.ts`:** `vietnamDayStart(date: string)`, `vietnamDayEnd(date:
    string)`, `isBeforeTodayInVietnam(date: string, now: Date)`, with a comment on
    the fixed +07:00 offset.
  - Unit tests in `packages/commerce/test/`, no database.
  - **§7.4's dedicated test:** 60 days remaining + 365 → expiry 425 days from now,
    named for the early-renewal case.
  - The other cases: expired base stacks from now; cap exactly at `now + d` passes
    and one millisecond over fails; `"99999"` at 33% rounds half up; 100% → `"0"`;
    day boundaries for `2026-09-13`.
  - done when:
    - `pnpm --filter @knowledge-explorer/commerce test` is green;
    - **mutation check:** temporarily change `stackExpiry`'s base to `now`, watch
      the early-renewal test fail, then revert.

- [x] **Task 3: the `PaymentProvider` port and its two implementations**
  - `payment-provider.ts`: the interface and `VerifiedPaymentEvent` from the spec,
    the `PAYMENT_PROVIDER` Symbol, and `mintProviderOrderReference()` (128 random
    bits, base64url).
  - The comment records the real-adapter constraints: round-trip the reference,
    verify raw bytes, report whole VND.
  - `fake-payment-provider.ts`:
    - `providerName = 'fake'`;
    - `createCheckout` → `${apiPublicUrl}/api/payments/fake/checkout/${reference}`;
    - `verifyWebhook` → HMAC-SHA256 hex of `rawBody` against
      `x-fake-payment-signature` with `timingSafeEqual` (a length check first),
      returning `null` on any failure;
    - exported `signFakeWebhook(rawBody, secret)`;
    - `recordDeliveredOutcome` / `getOrderStatus` over an in-process map.
  - `unavailable-payment-provider.ts`: `providerName = 'unavailable'`; every
    method throws `PaymentProviderUnavailableError`.
  - Tests:
    - valid signature;
    - one flipped byte;
    - the same object re-serialized with different whitespace under the original
      signature → `null`;
    - missing header;
    - wrong secret;
    - signature of the wrong length (must not throw).
  - done when: `pnpm --filter @knowledge-explorer/commerce test` is green and
    `pnpm --filter @knowledge-explorer/commerce typecheck` passes.

## Slice C — Products, end to end

- [x] **Task 4: create, list and price-check**
  Add every error code the spec lists, plus `COURSE_NOT_FOUND` and
  `CATEGORY_NOT_FOUND`, to `errors.ts` with the existing comment convention.

  `apps/api/src/commerce/products.{controller,service}.ts`:
  - **Controller:** `@Controller('admin/products')`,
    `@UseGuards(SessionGuard, RolesGuard)`,
    `@RequirePermission('createProductsAndSetPrices')` per method.
  - **`POST`** is the discriminated union from the spec. `priceAmount` matches
    `^\d{1,10}$`; `currencyCode` is optional and literal `'VND'`. P2002 →
    `409 PRODUCT_ALREADY_ACTIVE` carrying the existing id; unknown target → 404.
  - **`GET`** takes `courseId`, `categoryId`, `includeInactive` and
    `targetSearch`, and returns `courseOptions` / `categoryOptions` bounded at 50,
    newest first.
  - **`GET /:productId/price-check`**, over published courses with active single
    products, listing the published courses without one.
  - **`POST` of a bundle** returns `warnings: [BUNDLE_PRICE_NOT_BELOW_SUM]` when
    applicable.

  Register in `app.module.ts`. Start `apps/api/test/commerce-products.e2e-spec.ts`:
  - validation refusals: fractional price, non-VND, `renewalType` present,
    unknown field;
  - both creates;
  - the 409;
  - price-check sums including a course with no single product and a draft course
    excluded;
  - the bundle warning;
  - an admin → `403 FORBIDDEN_ROLE`;
  - a learner cookie → `401`.
  - done when: `pnpm --filter @knowledge-explorer/api test commerce-products` is
    green.

- [x] **Task 5: patch, the not-for-sale warning, and revalidation**
  `PATCH /admin/products/:productId` with exactly `priceAmount`,
  `accessDurationDays`, `gracePeriodDays` and `isActive`. `displayName`,
  `productType` and target → `400 INVALID_BODY`. Reactivation conflict → 409.

  `COURSE_NOT_FOR_SALE`:
  - compute the set of published paid courses covered by an active product
    **before** and **after** the write, in the same transaction;
  - warn only on courses that moved from covered to uncovered.

  After commit, call `revalidateLearnerPages` for:
  - a single product → its course slug and category slug;
  - a bundle → its category slug and each published course slug in it, one call
    each.

  Tests:
  - fixed-field refusal;
  - deactivating a single product while a bundle covers the course → no warning;
  - deactivating the bundle → warning naming the course;
  - a second save over an already-uncovered course → no re-warning;
  - an existing grant's `grace_period_days` is unchanged after a grace edit.
  - done when:
    - `pnpm --filter @knowledge-explorer/api test commerce-products` is green;
    - with api and learner-web running locally, changing a single product's price
      is reflected on `localhost:3002/courses/<slug>` on the next reload, not
      after 300 s.

- [x] **Task 6: the admin products screen**
  - `apps/admin-web/lib/commerce-types.ts` (product views) and
    `app/(portal)/products/page.tsx`:
    - list with course/category filter and inactive toggle;
    - create form with type radio and a searchable target picker over the options;
    - in-place edit of the four PATCH fields;
    - save warnings inline, never blocking;
    - a price-check panel on bundle rows.
  - Nav link "Products" in `app/(portal)/layout.tsx`. English copy; 1280 px and
    wider.
  - done when:
    - in a browser an owner creates a single product and a bundle, sees the bundle
      warning, deactivates the bundle and sees `COURSE_NOT_FOR_SALE` with the
      course named;
    - `pnpm --filter @knowledge-explorer/admin-web typecheck` is green;
    - `pnpm --filter @knowledge-explorer/admin-web test:e2e` is still green.

- [x] **Task 7: publish a paid course through the product**
  In `apps/learner-web/e2e/learner.spec.ts` test 1:
  - delete the free-then-paid workaround (the `active_product_for_paid` branch and
    the Prisma flip back to `paid`);
  - create a single-course product through `POST /api/admin/products` before
    reading the checklist.

  Update the `grantAccess` comment in `helpers.ts` to say it seeds a grant for P7's
  scenario, which predates the grant endpoint.
  - done when: `pnpm --filter @knowledge-explorer/learner-web test:e2e` is green,
    with test 1 publishing a course whose `pricing_type` is `paid` throughout —
    assert it in the test.

## Slice D — Manual grants

- [x] **Task 8: grant, revoke and list**
  `apps/api/src/commerce/grants-admin.{controller,service}.ts`,
  `@RequirePermission('grantOrRevokeAccessManually')`.

  **`POST`** is the discriminated union on `scopeType`:
  - `learnerEmail` case-insensitive → `404 USER_NOT_FOUND`;
  - a non-learner role → `422 GRANT_TARGET_NOT_LEARNER`;
  - `expiresOn` of `YYYY-MM-DD` → `vietnamDayEnd`, or `null` for perpetual;
    before today → `400 GRANT_EXPIRY_IN_PAST`;
  - `gracePeriodDays` ≥ 0;
  - a same-scope un-revoked row → `409 GRANT_ALREADY_EXISTS` carrying id, source
    and expiry, including the P2002 path.

  **`DELETE`** sets `revoked_at` if null and returns 204 either way; unknown → 404.

  **`GET`** takes `status=live|revoked|all` filtered on `revoked_at` only, plus
  `learnerEmail`, `courseId`, `categoryId` and paging from `catalog.service.ts`.
  Each row carries `isActive` from **`isGrantActive`**.

  `apps/api/test/commerce-grants.e2e-spec.ts` covers every refusal and both
  scopes, plus:
  - perpetual stored as `NULL`;
  - an expired-but-live row listed with `isActive: false` under `status=live`;
  - revoke idempotency with `revoked_at` unchanged on the second call;
  - **after revoking, the same learner's `GET /api/lessons/:lessonId` on a paid
    lesson is refused on the very next request.**
  - done when:
    - `pnpm --filter @knowledge-explorer/api test commerce-grants` is green;
    - `grep -rn "expiresAt\|expires_at" apps/api/src/commerce/grants-admin.service.ts`
      shows no comparison against the current time.

- [x] **Task 9: the admin grants screen**
  `app/(portal)/grants/page.tsx`:
  - filters;
  - a create form with an expiry date picker labelled "Asia/Ho_Chi_Minh", a "no
    expiry" checkbox and a grace field;
  - a revoke action per live row;
  - active, expired and revoked visually distinct, using `isActive` and
    `revokedAt`;
  - the 409 rendered with the existing grant's details.

  Nav link "Grants".
  - done when: in a browser an owner grants a learner perpetual category access,
    sees the duplicate refused with details, revokes it, and sees the row under
    `status=revoked`; admin-web typecheck is green.

## Slice E — The money path

- [x] **Task 10: provider wiring, the checkout happy path, and the learner's orders**
  - **`apps/api/src/commerce/payment-provider.factory.ts`:**
    - `createPaymentProvider()`: `fake` → `FakePaymentProvider`, **throwing**
      when `PAYMENT_FAKE_WEBHOOK_SECRET` is empty;
    - anything else → `UnavailablePaymentProvider`;
    - `isFakePaymentEnabled()`.
  - **`app.module.ts`:** `{ provide: PAYMENT_PROVIDER, useFactory: () =>
    createPaymentProvider() }` with a comment on why this provider does not default
    to its fake.
  - **`checkout.{controller,service}.ts`:** class-level `LearnerSessionGuard,
    RolesGuard`, `@RequirePermission('buyAccessReadListenTrackProgress')`.
  - **`GET /checkout/quote`** for a valid product: product, target, list price,
    amount, `currentExpiresAt`, `resultingExpiresAt` via `stackExpiry`,
    `isRenewal`, `paymentAvailable`.
  - **`POST /checkout`:**
    - unavailable → `503 PAYMENT_PROVIDER_UNAVAILABLE`;
    - otherwise insert a `pending` order with the minted reference,
      `provider_name`, `amount`, `list_price_amount` and `VND`;
    - then `createCheckout` → `201 { orderId, redirectUrl }`;
    - a thrown `createCheckout` → order `failed`, `502 PAYMENT_PROVIDER_ERROR`.
  - **`GET /me/orders`** paginated, and **`GET /me/orders/:orderId`** — another
    learner's order → `404 ORDER_NOT_FOUND`.
  - **`.env.example`:** the four variables with comments, `PAYMENT_PROVIDER="fake"`
    commented "unset means checkout is closed".
  - **`.github/workflows/ci.yml`:** `PAYMENT_PROVIDER: fake` and a CI-only secret.

  Start `apps/api/test/commerce-checkout.e2e-spec.ts`, setting both env vars
  before `loadEnv`:
  - happy path: the row is pending, the reference is unique, and `redirectUrl`
    points at the fake page;
  - quote shape;
  - the owner's admin-web cookie → 401;
  - a staff user with a learner-named cookie → `403 FORBIDDEN_ROLE`;
  - order isolation;
  - `createCheckout` throwing, via an overridden provider in the testing module →
    502 and the order `failed`.
  - done when: `pnpm --filter @knowledge-explorer/api test commerce-checkout` is
    green and `pnpm typecheck` is green.

- [x] **Task 11: the refusal ladder and the warnings**
  In `checkout.service.ts`, one `evaluateCheckout(userId, productId, now)` used by
  both quote and POST, in the spec's order:

  | # | Condition | Response |
  |---|---|---|
  | 2 | unknown or inactive product | 404 |
  | 3 | course not published | 409 |
  | 4 | free course | 409 |
  | 5 | empty bundle | 409 |
  | 6 | perpetual, same scope or category-over-single | 409 |
  | 7 | term cap, via `exceedsTermCap` | 409 carrying `currentExpiresAt` and `renewableFrom` |

  Then **#9**, POST only: `CHECKOUT_HOURLY_CAP` counting the caller's
  `payment_orders` of any status created in the trailing hour → 429 with the cap
  and `retryAfterSeconds`. Quote reports #2–#7 in `blockedBy` (#2 is still a 404
  on the quote).

  Warnings, computed with `isGrantActive` over the caller's live grants:
  `BUNDLE_OVERLAPS_OWNED_COURSES` naming courses, and `COURSE_COVERED_BY_BUNDLE`.

  Tests:
  - one per refusal, plus a product failing two conditions returns the
    **earlier** one;
  - cap exactly at `now + d` allowed and one day over refused;
  - a lapsed same-scope grant does not trip the cap;
  - a perpetual single grant does not refuse a bundle but does warn;
  - the sixth order in an hour is 429 while quote still returns 200.
  - done when: `pnpm --filter @knowledge-explorer/api test commerce-checkout` is
    green.

- [x] **Task 12: the webhook**
  - **`main.ts`:** `NestFactory.create(AppModule, { rawBody: true })`.
  - **`webhook.controller.ts`:** `@Controller('webhooks')`, **no `@UseGuards`, no
    `@RequirePermission`**, with a comment pointing at the test that asserts it.
    `POST payment` reads `request.rawBody` (500 if absent) and calls
    `purchase.service.ts`.
  - **`purchase.service.ts`**, in one interactive transaction:
    1. `verifyWebhook` → `null` → 401, nothing written;
    2. find by `(provider_name, reference)` → unknown → 200 plus a warn log;
    3. `SELECT … FOR UPDATE` on the order → non-pending → 200 no-op;
    4. `failed` → failed plus `completed_at` plus payload;
    5. amount or currency mismatch → failed plus an error log with `reason:
       'PAYMENT_AMOUNT_MISMATCH'`;
    6. paid → order paid, then `applyPurchaseToGrant(tx, order)`.
  - **`applyPurchaseToGrant`:**
    - `pg_advisory_xact_lock(hashtextextended($1, 0))` on
      `userId:scopeType:scopeId`;
    - read the product now;
    - a same-scope un-revoked row → extend it: `stackExpiry`, `renewal_count + 1`,
      grace, product and order from this purchase, `access_source = 'purchase'`,
      `sent_reminder_milestones = []`, `granted_by_user_id` untouched;
    - that row perpetual → leave it, plus an info log;
    - no row → insert.
  - Register the controller and service.

  `apps/api/test/commerce-webhook.e2e-spec.ts` builds its app with
  `createNestApplication({ rawBody: true })` and posts bodies signed with
  `signFakeWebhook`. Tests:
  - **`serves an unsigned caller with 401, not 403 — no guard, deliberately`**;
  - flipped signature;
  - re-serialized body under the original signature → 401;
  - unknown reference → 200 and nothing written;
  - paid → grant inserted with `now + d`;
  - replay → the grant row deep-equals its previous state;
  - `failed` after `paid` → no change;
  - mismatch → failed, no grant;
  - extension of an owner-granted dated row (`access_source` flips,
    `granted_by_user_id` kept, milestones reset);
  - perpetual row untouched;
  - revoked row not extended (a new row is inserted);
  - **two different pending orders for one learner and scope delivered
    concurrently** → one row, `renewal_count = 1`, expiry `now + 2d` within a
    tolerance;
  - a bundle purchase does not modify an existing single-course grant.
  - done when:
    - `pnpm --filter @knowledge-explorer/api test commerce-webhook` is green;
    - **mutation check:** comment out the advisory lock, watch the concurrent test
      fail (run it several times if it passes once), then restore.

- [x] **Task 13: the fake hosted page, and a closed store**
  - First, confirm `AppModule.withFakePaymentPage()` —
    `{ module: AppModule, controllers: [FakePaymentPageController] }` — boots with
    the providers resolvable. If not, switch to the plan's fallback before going
    further.
  - **`fake-payment-page.controller.ts`:**
    - `GET payments/fake/checkout/:reference` → minimal HTML with the escaped
      display name, amount, and Pay / Fail forms;
    - `POST` → build the body, `signFakeWebhook`, `fetch` it to
      `${API_PUBLIC_URL}/api/webhooks/payment`, `recordDeliveredOutcome`, then
      `303` to `${LEARNER_WEB_URL}/checkout/return?orderId=…`;
    - both 404 unless the bound provider is `fake`;
    - unknown reference → 404.
  - **`main.ts`:** after `loadEnv`, `isFakePaymentEnabled() ?
    AppModule.withFakePaymentPage() : AppModule`.
  - **`apps/api/test/commerce-provider-unavailable.e2e-spec.ts`** sets
    `PAYMENT_PROVIDER = ''` **before** `loadEnv`, with a comment on dotenv's
    no-override rule, and imports `AppModule.withFakePaymentPage()` deliberately to
    prove the handler-level check. It asserts:
    - `POST /checkout` → 503;
    - `POST /webhooks/payment` → 503;
    - quote → 200 with `paymentAvailable: false`;
    - `GET /payments/fake/checkout/x` → 404.
  - A unit-level test that `createPaymentProvider()` throws for `fake` with no
    secret.
  - Extend `commerce-webhook.e2e-spec.ts` with the page's POST delivering over
    HTTP on a listening server (`app.listen(0)` and `API_PUBLIC_URL` set to it) and
    turning the order `paid`.
  - done when:
    - `pnpm --filter @knowledge-explorer/api test commerce` is green;
    - with `.env` holding `PAYMENT_PROVIDER=fake`, `pnpm --filter
      @knowledge-explorer/api start` serves the page for a real pending order, and
      clicking Pay turns the order `paid` — proving bootstrap-time registration;
    - with `PAYMENT_PROVIDER` unset, the same URL 404s.

## Slice F — The learner buys

- [x] **Task 14: sign-in return, buy links, and the confirm page**
  - **`app/signin/page.tsx`:** read `callbackUrl`; pass `redirectTo` only when it
    matches `^/(?!/)`.
  - **Price blocks:** buy links in `courses/[slug]/page.tsx` (`buy-single`,
    `buy-bundle`) and `categories/[slug]/page.tsx` (`buy-bundle`).
  - **`lib/commerce-types.ts`.**
  - **`app/checkout/[productId]/page.tsx`**, `force-dynamic` via `serverApiFetch`:
    - signed out → a sign-in link with `callbackUrl`;
    - signed in → the quote rendered in Vietnamese: warnings in words, and
      `blockedBy` in words with no pay button;
    - `paymentAvailable: false` → "cửa hàng tạm đóng".
  - **`components/checkout/pay-button.tsx`:** `apiFetch` POST, then
    `window.location.assign(redirectUrl)`, surfacing refusals.
  - **`paywall.tsx`:** correct the comment.
  - done when:
    - in a browser, an anonymous visitor clicks a buy link, signs in through the
      magic link, lands back on the confirm page, pays through the fake page, and
      the paid lesson renders;
    - `/signin?callbackUrl=https://example.com` followed through a magic link
      lands on learner-web, not example.com;
    - `./scripts/verify-magic-link.sh` passes;
    - learner-web typecheck is green;
    - no horizontal scroll at 360 px.

- [x] **Task 15: the return page and order history**
  - **`app/checkout/return/page.tsx`** plus `components/checkout/return-poller.tsx`:
    - poll `GET /me/orders/:orderId` every 2 s for up to 60 s;
    - paid → success and a course link;
    - failed → failure and a link back to the confirm page;
    - still pending → "đang xử lý" and `/me/orders`;
    - writes nothing.
  - **`app/me/orders/page.tsx`**, `force-dynamic`.
  - Nav link to `/me/orders` in `app/layout.tsx`.
  - done when:
    - in a browser, Pay shows success and Fail shows failure on the return page;
    - `/me/orders` lists both with their statuses and no provider reference in the
      page source;
    - learner-web typecheck is green.

## Slice G — Discount codes

- [x] **Task 16: owner discount-code endpoints**
  `discount-codes.{controller,service}.ts`,
  `@RequirePermission('createProductsAndSetPrices')`.
  - **`POST`:**
    - `code` normalized and matched against `DISCOUNT_CODE_PATTERN`;
    - `percentOff` 1–100;
    - exactly one of `appliesToAllProducts: true` or non-empty `productIds` (all
      existing);
    - `startsOn` / `endsOn` via `calendar.ts`;
    - `maxRedemptions` ≥ 1; the two flags;
    - duplicate → `409 DISCOUNT_CODE_ALREADY_EXISTS`.
  - **`PATCH`:** only the editable fields; `code`, `percentOff`, `productIds` and
    `appliesToAllProducts` → `400 INVALID_BODY`; lowering the cap below the count
    is allowed.
  - **`GET`:** each code with `redemptionCount` = paid orders carrying it.

  Start `apps/api/test/commerce-discounts.e2e-spec.ts`:
  - lowercase input stored uppercase;
  - each validation refusal;
  - the duplicate 409 when the case differs;
  - fixed-field PATCH refusal;
  - redemption count ignores pending and failed orders;
  - admin 403.
  - done when: `pnpm --filter @knowledge-explorer/api test commerce-discounts` is
    green.

- [x] **Task 17: discounts at checkout**
  `evaluateDiscount(code, product, userId, now)` in `discount-codes.service.ts`,
  returning the first failing row of the spec's table or `{ percentOff,
  discountCodeId }`:
  1. not found or inactive;
  2. outside window;
  3. not applicable;
  4. exhausted;
  5. already used;
  6. new-purchases-only — the **same-scope** row active per `isGrantActive`.

  Wire it into `evaluateCheckout`:
  - **quote:** `discountError` and list-price fallback, with `blockedBy`
    unaffected;
  - **POST:** 422 as refusal #8, before the rate cap; on success the order carries
    `amount` from `applyPercentDiscount`, `list_price_amount` and
    `discount_code_id`.

  Tests:
  - one per row;
  - a lapsed same-scope grant **passes** new-purchases-only;
  - a 100% code yields `amount = "0"` and still returns a `redirectUrl`;
  - **the in-flight bound:** create the order with a code, deactivate the code,
    deliver the paid webhook → grant written, order paid.
  - done when: `pnpm --filter @knowledge-explorer/api test commerce` is green.

- [x] **Task 18: discount screens**
  - admin-web `app/(portal)/discount-codes/page.tsx`: list with redemption counts;
    create form (code, percent, all-or-selected products from the products list,
    dates, cap, flags); row edit limited to the editable fields. Nav link
    "Discount codes".
  - learner-web `components/checkout/discount-field.tsx` on the confirm page:
    re-quote with the code; show the discounted amount or the error in words;
    carry the code into the POST.
  - done when: in a browser an owner creates a 10% code, a learner enters it in
    lowercase and sees the amount drop and pays, and the code's redemption count
    reads 1; both apps typecheck.

## Slice H — The owner's view of orders

- [x] **Task 19: the orders list**
  - `orders-admin.controller.ts`: `GET /admin/orders?status=&learnerEmail=&page=&pageSize=`,
    `@RequirePermission('grantOrRevokeAccessManually')`, newest first, no
    `raw_webhook_payload`.
  - admin-web `app/(portal)/orders/page.tsx` with status and learner filters.
    Nav link "Orders".
  - Add assertions to `commerce-checkout.e2e-spec.ts`: the list carries the
    discount code and list price; the payload has no `rawWebhookPayload`; admin
    403.
  - done when: `pnpm --filter @knowledge-explorer/api test commerce-checkout` is
    green, and in a browser the owner sees one paid and one failed order with the
    right amounts.

## Slice I — Proof

- [x] **Task 20: the browser scenario**
  - **`playwright.config.ts`:** after `loadEnv`, `process.env['PAYMENT_PROVIDER']
    ??= 'fake'` and an e2e-only `PAYMENT_FAKE_WEBHOOK_SECRET` default, with a
    comment that child web servers inherit them.
  - **`seed.ts`:** optional `categoryId`, `levelOrder` and slug suffix on
    `seedCourse`, defaulting to today's behaviour.
  - **`helpers.ts`:** `signWebhook(body)` over `signFakeWebhook` and the same
    secret.
  - **`e2e/commerce.spec.ts`:** the spec's seventeen steps, serial, with cleanup in
    the plan's foreign-key order (orders → codes → grants → products → courses →
    category → sessions → users).
  - Step 3 asserts the bundle offer appears on a reload inside the ISR window.
  - Step 6 asserts the paid lesson is refused **while** the browser sits on the
    fake page.
  - done when: `pnpm --filter @knowledge-explorer/learner-web test:e2e` is green
    with `learner.spec.ts`, `topic-requests.spec.ts` and `commerce.spec.ts` all
    running.

- [x] **Task 21: full verification and notes**
  - `pnpm verify` across the monorepo;
  - both browser suites;
  - `./scripts/verify-magic-link.sh`;
  - `pnpm --filter @knowledge-explorer/database exec prisma migrate status`;
  - re-run `packages/database` to confirm task 1's DDL survived.

  Update `CLAUDE.md` ("`PaymentProvider` (P8) do not exist yet" → exists, fake
  only; P8a done; P8b pending) and `.claude/harness/architecture.md` / `INDEX.md`.
  Record implementation notes at the foot of this file, as P7 and P9 did: what the
  plan did not predict, decisions taken, and what P8b inherits.
  - done when: every command above is green, and this file's boxes are all ticked
    with notes written.

---

## Implementation notes

Written at completion, as P7's and P9's were: what the plan did not predict, what
was decided while building, and what P8b inherits.

### The environment this ran in

- **Node 24.14.1, not 22.** No Node 22 exists on the machine: there is no nvm or
  fnm, and the running dev API was already on 24. pnpm printed its engines
  warning on every call. Vitest did NOT hit the rolldown native-binding error
  CLAUDE.md describes for Node 20, and every suite ran.
- **pnpm existed only through corepack.** `turbo` refuses to run without a `pnpm`
  binary on PATH ("Unable to find package manager binary"), so a shim was
  installed with `corepack enable --install-directory <scratch>/bin pnpm`. Root
  scripts that shell out to `pnpm` (`db:migrate`, `verify`) need the same.
- **Playwright's Chromium headless shell (build 1243) was not installed.** The
  first admin-web browser run failed all 17 tests on `browserType.launch` before
  touching the app. `playwright install chromium` fixed it. If a whole browser
  suite fails in under a minute, read the first error before the code.
- **The host has no `psql`**, which `scripts/verify-magic-link.sh` calls directly.
  A scratchpad shim forwards to `docker exec knowledge-explorer-postgres psql`,
  dropping the URL argument, because the URL names the host's mapped port 5433,
  which the container cannot reach.

### Findings the plan did not predict

**The two-order concurrency test had no teeth.** The plan's test delivered two
different paid orders at once. With the advisory lock deleted, it still passed 3
of 3 runs: two transactions over two HTTP requests simply never overlapped. The
test that bites delivers EIGHT orders for one learner and scope. With the lock
removed it failed 3 of 3, with 500s from collisions on the partial unique index.
With the lock restored it passed. This is P9's lesson exactly: a concurrency test
with too few actors passes against a broken implementation. The task 12 mutation
check is the only reason this was caught.

**The stacking mutation check did bite first time.** Forcing `stackExpiry`'s base
to `now` failed 3 of the 11 renewal tests, including the named early-renewal case.

**Bootstrap-time registration of the fake page was proven on a real boot, not only
in a test module.** Plain `pnpm --filter @knowledge-explorer/api start`, reading
`.env`:
- With `PAYMENT_PROVIDER=fake`, a pending order seeded by SQL got its page (200),
  and Pay answered 303 to learner-web's return page, leaving the order paid with
  one grant.
- Rebooted with `PAYMENT_PROVIDER` empty, the same URL gave Express's
  `Cannot GET …` 404, byte-for-byte the same response as a route that does not
  exist.

`AppModule.withFakePaymentPage()` returning `{ module: AppModule, controllers: [...] }`
merges with the static metadata in Nest 12, so the plan's fallback module was not
needed.

**The browser scenario found a real race in the admin Grants page.** Step 14
revoked a grant and switched the status filter to "Revoked" straight away. The
page showed "0 grant(s)" under the Revoked label:
- The row's `onRevoked` held the `load` from the render it was created in, when
  the filter was still "live".
- The DELETE finished after the filter changed, and that stale `load` re-queried
  live grants.
- Its response landed last and replaced the revoked list.

Fixed in the page rather than papered over in the test:
- reloads go through a counter, so they always use the current filters;
- a request ticket drops any response that is not the latest.

The Products page had the identical pattern and got the identical fix. The test
now also waits for the revoked row to leave the live list, which is what a person
sees. Nothing in the api suites could have found this.

**P7's `learner.spec.ts` test 3 had to change too, not only test 1.** It asserted
"no products exist until P8, so the price block is absent". Creating a product in
test 1 inverted that, so test 3 now asserts the price block is present and the
not-for-sale state absent. That goes beyond this file's named exceptions list,
which named test 1 only, and is recorded here for that reason.

**Revalidation is asserted, not eyeballed.** Task 5's done-when was a manual
reload against a running learner-web. `commerce-products.e2e-spec.ts` instead
points `LEARNER_WEB_URL` at a local stand-in server and asserts every call:
- a single product fires its course and its category;
- a bundle fires its category and every PUBLISHED course in it, never the draft.

Browser step 3 adds the end-to-end half: the bundle offer appears on a reload well
inside the 300-second ISR window.

**The magic link cannot be read by the browser suite.** learner-web logs it to its
own server's stdout. Step 4 therefore asserts two things:
- the sign-in form's hidden `callbackUrl` carries the confirm page, and is absent
  for `https://example.com/…` and `//example.com`;
- a real magic link completed to that path lands back on the confirm page.

**A supertest request built long before it is awaited can find its listener
gone** (ECONNREFUSED). The grants suite built three requests in an array and
awaited them in turn; they are now built lazily, one at a time.

### Decisions taken during implementation

- **`WEBHOOK_RAW_BODY_MISSING` joined `errors.ts`.** It is not in the spec's list.
  A missing raw body is a wiring fault answered with 500, and the convention that
  every error carries an `errorCode` still applies.
- **The fake page's 404 when the fake is not bound is a bare `NotFoundException`**
  with no `errorCode`, on purpose: it must be indistinguishable from an
  unregistered route. An unknown reference while the fake IS bound answers
  `ORDER_NOT_FOUND`.
- **`completed_at` is written for both terminal statuses**, as the spec says. It
  records when an order settled.
- **The confirm page's discount field is a GET form** (`?code=`) that the server
  re-quotes, not a client component holding a price. No browser state carries an
  amount the server did not compute, and the POST re-evaluates the code anyway.
- **An ill-formed code is simply `DISCOUNT_CODE_NOT_FOUND`.** A shape error is not
  worth a separate code a learner would have to understand.
- **The webhook compares amounts in integer hundredths**, and treats an unparsable
  reported amount as a mismatch, which fails the order rather than throwing.
- **`signWebhook` in `e2e/helpers.ts` reimplements the HMAC with `node:crypto`**
  instead of importing `packages/commerce`, so learner-web gains no dependency on
  server-only code for five lines.
- **`playwright.config.ts` defaults `PAYMENT_PROVIDER` with `??=`**, so an explicit
  value still wins, and the webhook secret and `API_PUBLIC_URL` with `||=`, since
  an empty value is unusable.
- **`pg_advisory_xact_lock` runs through `$executeRaw`, not `$queryRaw`.** The
  function returns `void`, which the driver adapter cannot deserialize as a result
  column. This was chosen up front, not hit as a failure.

### Known limitations, recorded deliberately

- **A discount code on a product with a fractional price throws.**
  `applyPercentDiscount` accepts whole VND only, and P8a's product endpoints only
  write whole VND. A row hand-seeded as, say, `199000.5` would turn a discounted
  quote into a 500. Found in self-review; no P8a writer can produce such a row.
- **Abandoned orders stay `pending`, and `getOrderStatus` has no caller** — by the
  spec, until a real gateway.
- **Discount limits can be exceeded by orders in flight** — by the spec, and
  asserted by `commerce-discounts.e2e-spec.ts`'s deactivate-then-webhook test.
- **CI still does not run the learner browser suite.** The api suites carry every
  money-path assertion, so CI covers the payment rules; the cross-app scenario
  remains a local gate, as P7's and P9's are.

### What P8b inherits

- **`sent_reminder_milestones` is reset to `[]` on every purchase extension**, and
  nothing in P8a reads it. P8b defines what a milestone is.
- **`LogEmailProvider` is still the only `EmailProvider`**, and no purchase
  confirmation or receipt email exists.
- **A `send_expiry_reminder` producer needs a row in
  `apps/api/src/jobs/job-permissions.ts`** (deny-by-default) and, per P7's note,
  `JobStatusService.instances()`.
- **Grants now have exactly two writers:** the webhook (purchases, under the
  advisory lock) and `grants-admin.service.ts` (owner grants and revocations).
  Anything that decides whether a grant is active calls `isGrantActive`.

### Verification at completion

All run on Node 24.14.1, after the last code change:

- **`pnpm verify`: exit 0.**
  - 11/11 typecheck tasks and 10/10 test tasks.
  - 1225 tests passed and 7 skipped (the paid live specs in `packages/ai`, which
    skip without keys).
  - api 618 across 27 files, including the six `commerce-*.e2e-spec.ts` files;
    content 144; shared 112; commerce 88; ai 80; worker 66; database 53, including
    the new DDL and fidelity assertions; storage 39; admin-web 25.
- **`pnpm --filter @knowledge-explorer/learner-web test:e2e`: 30 passed** — the
  seventeen P8a steps, P7's twelve with test 1 publishing a `paid` course through a
  real product, and P9's one.
- **`pnpm --filter @knowledge-explorer/admin-web test:e2e`: 17 passed.**
- **`./scripts/verify-magic-link.sh`: PASS.** The link was logged, only the hash
  was stored, hashing matches `InvitationService`, first use created a session,
  and reuse was rejected.
- **`prisma migrate status`:** 4 migrations, "Database schema is up to date!"
- **Mutation checks:** the advisory lock (8-order race failed 3/3 without it) and
  `stackExpiry`'s base (3 renewal tests failed).
- **Real-boot smoke test** of fake-page registration: 200 and paid with
  `PAYMENT_PROVIDER=fake`, route-absent 404 without it.
