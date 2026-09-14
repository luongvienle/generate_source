# Plan: P8a — Commerce: products, checkout, webhook, grants

**Spec:** specs/p8a-commerce/spec.md
**Status:** Approved
**Date:** 2026-09-13

## Objective

Make `products`, `access_grants` and `payment_orders` writable through the
product. The owner prices courses and bundles, issues discount codes and grants
access. A learner buys through a signed-webhook payment flow against a fake
`PaymentProvider`. All of it must hold these properties:
- §7.4's stacking rule is written once;
- `isGrantActive` remains the only access predicate;
- the webhook trusts raw bytes and nothing else;
- the initial migration is never regenerated;
- a fake payment provider cannot be reached by accident.

## Approach

Eight decisions shape the work. Each came out of impact analysis against code
that exists today. **Four of them depart from the spec's "Affected files" table,
and are marked ⚑ for the gate** rather than done quietly.

**1. ⚑ The fake payment page is registered at bootstrap, not at import time.**
The spec says the fake page's controller is registered "at module evaluation"
when `PAYMENT_PROVIDER === 'fake'`. That cannot work here:
- `apps/api/src/main.ts` imports `AppModule` on its first lines and calls
  `loadEnv()` only inside the module body. A `controllers: [...]` array that reads
  `process.env` is evaluated before `.env` is loaded, so in development the page
  would **never** register, and nothing would say why.
- Every api e2e file has the same ordering: imports, then `loadEnv(...)`.

Instead, `AppModule` gains `static withFakePaymentPage(): DynamicModule`, which
returns `{ module: AppModule, controllers: [FakePaymentPageController] }`:
- `main.ts` chooses between `AppModule` and `AppModule.withFakePaymentPage()`
  **after** `loadEnv`, from the same selector the provider factory uses.
- Suites that need the page import the dynamic form.
- The twenty existing suites keep importing plain `AppModule` and are untouched.
- Each handler also refuses with 404 unless the bound provider's `providerName` is
  `fake`, which is the spec's second layer.

If a dynamic module that repeats its own class does not merge metadata as
expected in Nest 12, the fallback is a separate `FakePaymentPageModule` plus
`AppModule` exporting `PrismaService` and `PAYMENT_PROVIDER`. Task 13 checks this
first.

**2. ⚑ `schema-fidelity.spec.ts` must change, and it is P0's guard.**
- Its `adds no table beyond §8, the adapter, and Prisma bookkeeping` test fails the
  moment `discount_codes` exists.
- The edit adds a named `tablesAddedAfterSpec8` list with a comment citing this
  spec. Nothing is widened into a wildcard: the test's purpose — no silent table —
  survives, and the new tables are *declared*.
- The money-type test gains `('payment_orders','list_price_amount')`, so the new
  price column is held to `numeric(12,2)` like the other two.

**3. Every env-dependent choice is made where env is already loaded.**
- **Provider selection** is a `useFactory` (`createPaymentProvider()` in
  `apps/api/src/commerce/payment-provider.factory.ts`), which runs at
  `NestFactory.create`. That is after `loadEnv` in `main.ts`, and after the suite's
  `loadEnv` in tests. This is the `TEXT_TO_SPEECH_PROVIDER` shape.
- **Commerce api suites** set `PAYMENT_PROVIDER='fake'` and
  `PAYMENT_FAKE_WEBHOOK_SECRET` *before* their `loadEnv` call.
- **The unavailable-provider suite** sets `PAYMENT_PROVIDER=''` — an empty string,
  not `delete`. dotenv never overrides a key that is already present, so a
  developer `.env` holding `fake` cannot leak into the suite that asserts its
  absence.
- **The learner Playwright config** defaults both variables with `??=` after its
  own `loadEnv`, so the browser suite does not depend on a developer's `.env`. The
  api child process inherits them, and `signWebhook` in `helpers.ts` reads the
  same values.

**4. The webhook reads `rawBody` or nothing.**
- `main.ts` and every suite that posts webhooks pass `{ rawBody: true }`
  (`NestApplicationOptions.rawBody` exists in the installed `@nestjs/common@12.0.1`).
- The controller types its request locally as `{ rawBody?: Buffer; headers }`,
  keeping express types out, as `session-context.ts` does.
- A missing `rawBody` is a **500 wiring fault, never a fallback to
  `JSON.stringify(body)`**. That fallback passes every test that signs
  `JSON.stringify` output and fails only against a real gateway. The re-serialized
  body test is what makes the fallback impossible to add unnoticed.

**5. The money path is one interactive transaction with two locks.**
`purchase.service.ts` runs inside `prisma.client.$transaction(async (tx) => …)`:
- **`SELECT … FROM payment_orders … FOR UPDATE`** serializes duplicate deliveries
  of one order. A terminal status then short-circuits.
- **`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`**, keyed on
  `userId:scopeType:scopeId`, serializes *different* orders for the same learner
  and scope. A row lock cannot cover the insert case, where there is no row to
  lock yet. A hash collision only serializes two unrelated pairs, which costs
  latency and never correctness.
- The order update and `applyPurchaseToGrant` share `tx`, so a failed grant write
  leaves the order `pending` and the gateway's retry replays it whole.

**6. The pure rules live in `packages/commerce` and are unit-tested without a
database.**
- `renewal.ts`: `stackExpiry`, `exceedsTermCap`, `renewableFrom`.
- `discount.ts`: `applyPercentDiscount`, `normalizeDiscountCode`.
- `calendar.ts`: Asia/Ho_Chi_Minh day start and end, "before today".
- The fake provider's sign and verify.

The checkout quote, the POST, the term cap, the confirm page's preview and the
webhook all import these, so §7.4's formula exists exactly once. The existing
`entitlement.spec.ts` needs Postgres; the new unit files do not, and stay pure.

**7. ⚑ `e2e/seed.ts` gains two options so X and Y can share category K.**
- `seedCourse` creates its own category (slug `p7-${run}`) and derives
  `levelOrder` from `pricingType`. Two paid courses therefore collide on both the
  category slug and `(category_id, level_order)`.
- It gains optional `categoryId` and `levelOrder` (and a slug suffix). Without them
  its behaviour is exactly as today, so `learner.spec.ts` is unaffected.
- P9 seeded its course directly to avoid the authoring pipeline. P8a cannot:
  step 7 reads a paid lesson body, and step 1 must pass the real checklist.

**8. ⚑ `COURSE_NOT_FOUND` and `CATEGORY_NOT_FOUND` join `errors.ts`; the bare
strings elsewhere stay.**
- `courses.controller.ts` and others throw `'COURSE_NOT_FOUND'` and
  `'INVALID_BODY'` as literals that `errors.ts` does not declare.
- P8a declares the two not-found codes it needs, as the spec says, and uses
  `errorCodes.*` in new code.
- It does **not** sweep existing controllers, and `INVALID_BODY` / `INVALID_QUERY`
  stay bare strings, matching every controller that already returns them. That
  sweep is its own change.

Everything else follows shapes that exist:
- **Owner controllers** mirror `TopicRequestsAdminController`: class-level
  `@UseGuards(SessionGuard, RolesGuard)`, `@RequirePermission` per method, zod
  `strictObject`, `errorCode` on every refusal.
- **Learner controllers** mirror `TopicRequestsLearnerController`:
  `LearnerSessionGuard`.
- **The webhook controller** mirrors `PublicTopicRequestsController`: no guards,
  plus a test named for that.
- **Picker options** are bounded at 50, newest first, with a search parameter,
  copying `topic-requests-admin.service.ts`.
- **Revalidation** is `revalidateLearnerPages`, awaited and unchecked, as
  `publishing.service.ts:115` uses it.
- **Server pages** fetch through `serverApiFetch`; client writes use `apiFetch`
  with `credentials: 'include'`.
- **Copy** is Vietnamese inline in learner-web and English in admin-web.
- **Prices** are formatted with the existing `formatPrice`.

## Affected files

| File | Change |
|---|---|
| `packages/database/prisma/migrations/<ts>_add_discount_codes/migration.sql` | **New, hand-written.** Two tables; `payment_orders.list_price_amount` (NOT NULL) and `discount_code_id` with FK; four CHECKs; `idx_payment_orders_user_created`; partial `idx_payment_orders_discount_paid`. Header comment cites this spec and invariant 1 |
| `packages/database/prisma/schema.prisma` | `DiscountCode`, `DiscountCodeProduct`; `PaymentOrder.listPriceAmount`, `discountCodeId`, relation; back-relations `User.createdDiscountCodes`, `Product.discountCodeProducts`, `DiscountCode.paymentOrders`; `@@index(…, map:)` matching SQL names; comment that CHECKs and the partial index are SQL-only |
| `packages/database/test/constraints.spec.ts` | New describe block: four CHECKs present, enforced behaviour for percent range and uppercase, both FKs with their delete actions, both indexes, the partial predicate |
| `packages/database/test/schema-fidelity.spec.ts` | ⚑ `tablesAddedAfterSpec8` allowlist; money-type check gains `list_price_amount` |
| `packages/shared/src/errors.ts` | The spec's 25 codes plus `COURSE_NOT_FOUND`, `CATEGORY_NOT_FOUND`, each with the what-and-which-section comment |
| `packages/shared/src/commerce.ts` | **New.** Warning codes, `DISCOUNT_CODE_PATTERN`, `CHECKOUT_TERM_CAP_MULTIPLIER = 2`, default hourly cap |
| `packages/shared/src/index.ts` | Export `commerce.ts` |
| `packages/commerce/src/renewal.ts`, `discount.ts`, `calendar.ts` | **New.** Pure rules (approach 6) |
| `packages/commerce/src/payment-provider.ts` | **New.** Port, `VerifiedPaymentEvent`, `PAYMENT_PROVIDER` token, reference minting |
| `packages/commerce/src/fake-payment-provider.ts` | **New.** HMAC-SHA256 hex, `timingSafeEqual`, `signFakeWebhook(body, secret)` exported for tests, delivered-outcome map behind `getOrderStatus` |
| `packages/commerce/src/unavailable-payment-provider.ts` | **New.** Throws a typed unavailable error from every method |
| `packages/commerce/src/index.ts` | Barrel |
| `packages/commerce/test/renewal.spec.ts`, `discount.spec.ts`, `calendar.spec.ts`, `fake-payment-provider.spec.ts` | **New.** Pure unit tests |
| `apps/api/src/commerce/payment-provider.factory.ts` | **New.** `createPaymentProvider()`, `isFakePaymentEnabled()`; throws at boot on `fake` without a secret |
| `apps/api/src/commerce/products.controller.ts`, `products.service.ts` | **New.** List + options, create, patch, price-check, before/after not-for-sale diff, revalidation |
| `apps/api/src/commerce/grants-admin.controller.ts`, `grants-admin.service.ts` | **New.** Create, revoke, list with `isActive` from `isGrantActive` |
| `apps/api/src/commerce/discount-codes.controller.ts`, `discount-codes.service.ts` | **New.** Owner CRUD; `evaluateDiscount()` used by checkout |
| `apps/api/src/commerce/checkout.controller.ts`, `checkout.service.ts` | **New.** Quote, POST, refusal ladder, warnings, rate cap, `/me/orders`, `/me/orders/:orderId` |
| `apps/api/src/commerce/webhook.controller.ts`, `purchase.service.ts` | **New.** Verify, find, lock, settle, `applyPurchaseToGrant` |
| `apps/api/src/commerce/fake-payment-page.controller.ts` | **New.** GET page, POST outcome → HTTP delivery → 303 |
| `apps/api/src/commerce/orders-admin.controller.ts` | **New.** Owner order list |
| `apps/api/src/app.module.ts` | ⚑ Controllers, services, `PAYMENT_PROVIDER` factory binding, `static withFakePaymentPage()` |
| `apps/api/src/main.ts` | `{ rawBody: true }`; ⚑ choose `AppModule` vs `AppModule.withFakePaymentPage()` after `loadEnv` |
| `apps/api/test/commerce-products.e2e-spec.ts`, `commerce-grants.e2e-spec.ts`, `commerce-checkout.e2e-spec.ts`, `commerce-webhook.e2e-spec.ts`, `commerce-discounts.e2e-spec.ts`, `commerce-provider-unavailable.e2e-spec.ts` | **New.** Per the spec's file table; orders-list assertions live in `commerce-checkout` |
| `apps/admin-web/lib/commerce-types.ts` | **New.** Owner views |
| `apps/admin-web/app/(portal)/products/page.tsx`, `grants/page.tsx`, `discount-codes/page.tsx`, `orders/page.tsx` | **New.** Owner screens |
| `apps/admin-web/app/(portal)/layout.tsx` | Nav links, added as each screen lands |
| `apps/learner-web/lib/commerce-types.ts` | **New.** Quote and order views |
| `apps/learner-web/app/checkout/[productId]/page.tsx`, `app/checkout/return/page.tsx`, `app/me/orders/page.tsx` | **New.** Confirm, return poll, history |
| `apps/learner-web/components/checkout/` | **New.** Client pay button, discount field, return poller |
| `apps/learner-web/app/courses/[slug]/page.tsx`, `app/categories/[slug]/page.tsx` | Buy links in the price blocks |
| `apps/learner-web/app/signin/page.tsx` | `callbackUrl` → `redirectTo`, relative single-slash paths only |
| `apps/learner-web/app/layout.tsx` | Nav link to `/me/orders` |
| `apps/learner-web/components/paywall.tsx` | Comment only |
| `apps/learner-web/e2e/learner.spec.ts` | Test 1 creates a product through the API and publishes as `paid`; workaround deleted |
| `apps/learner-web/e2e/seed.ts` | ⚑ `seedCourse` gains optional `categoryId`, `levelOrder`, slug suffix |
| `apps/learner-web/e2e/helpers.ts` | `signWebhook(body)`; `grantAccess` comment updated |
| `apps/learner-web/playwright.config.ts` | ⚑ `PAYMENT_PROVIDER ??= 'fake'` and an e2e-only secret default, after `loadEnv` |
| `apps/learner-web/e2e/commerce.spec.ts` | **New.** The spec's seventeen steps |
| `.env.example` | `PAYMENT_PROVIDER`, `PAYMENT_FAKE_WEBHOOK_SECRET`, `API_PUBLIC_URL`, `CHECKOUT_HOURLY_CAP` |
| `.github/workflows/ci.yml` | `PAYMENT_PROVIDER: fake` and a CI-only fake secret in the job env |
| `CLAUDE.md`, `.claude/harness/architecture.md`, `.claude/harness/INDEX.md` | At completion: `PaymentProvider` exists (fake only); commerce writes exist |

## Risks

- **`prisma migrate dev` silently drops the initial migration's nine hand-written
  objects.** *Mitigation:* the migration is hand-written and applied with
  `pnpm db:migrate` only. `constraints.spec.ts` runs green before and after
  task 1.
- **The fake page is never registered, or registered in production.** Import-time
  env reads are the first failure; a copied `.env` in production is the second.
  *Mitigation:*
  - bootstrap-time selection (approach 1);
  - the handler-level `providerName` check;
  - the unavailable-provider suite asserts 404 on the page and 503 on checkout
    and the webhook;
  - task 13's done-when boots the real `pnpm --filter api start` rather than a
    test module.
- **The webhook verifies a re-serialized body.** Passes every self-signed test,
  fails against a real gateway. *Mitigation:* approach 4, plus the spec's
  whitespace test.
- **§7.4 stacking regresses to `now + days`.** Paid time is destroyed silently.
  *Mitigation:*
  - one `stackExpiry`;
  - the dedicated early-renewal unit test;
  - task 2's mutation check: break the base date and watch the test fail.
- **Concurrent paid orders lose a term.** *Mitigation:* the advisory lock, a
  concurrency test with two different orders, and task 12's mutation check:
  remove the lock and watch the test fail.
- **A second access predicate appears in SQL.** Most tempting in the owner
  grant-list filter. *Mitigation:* the list filters only on `revoked_at`, and
  `isActive` comes from `isGrantActive`. The reviewer greps new services for
  `expires_at`/`expiresAt` comparisons.
- **Developer `.env` lacks the new variables**, so suites 503 in ways that look
  like bugs. *Mitigation:* suites set their own, Playwright defaults its own, and
  `.env.example` documents all four. The tasks file's "before starting" step says
  to copy them.
- **FK cleanup order breaks `afterAll`.** `payment_orders` → `products`/`users`
  and `discount_codes` → `users` are `NO ACTION`. *Mitigation:* every commerce
  suite deletes, in order:
  1. orders;
  2. discount codes;
  3. grants;
  4. products;
  5. courses and categories;
  6. sessions;
  7. users.

  `seed.ts`'s `cleanUp` is not used for courses that have orders.
- **`list_price_amount NOT NULL` fails on a development database holding
  hand-seeded orders.** Nothing in the repository writes `payment_orders` today;
  the only reference is `schema-fidelity.spec.ts`. *Mitigation:* the migration
  fails loudly by design (spec), and the tasks file notes it.
- **The api suites flake under concurrent load** (P7's note: four failures across
  different files, gone once dev servers stopped). *Mitigation:* stop api,
  admin-web and learner-web dev servers before `pnpm test`, and treat a new flake
  as a resource problem first.
- **`redirectTo` becomes an open redirect.** *Mitigation:* only paths matching
  `^/(?!/)` are passed. Task 14's done-when includes an external `callbackUrl`
  landing on the default page, and `scripts/verify-magic-link.sh` re-runs
  (invariant 3).
- **CI never runs the learner browser suite**, which is true today. The P8a
  scenario, like P7's and P9's, is a local gate. *Mitigation:* the api suites
  carry every money-path assertion so CI still covers them. Adding learner-web e2e
  to CI is recorded out of scope.
- **The harness is stale** (INDEX still says P4 onward is unbuilt). *Mitigation:*
  planned from the spec and the code; the harness's conventions and invariants
  were used. Refreshed in task 21.

## Test strategy

- **Pure units — `packages/commerce/test/{renewal,discount,calendar,fake-payment-provider}.spec.ts`**
  (`pnpm --filter @knowledge-explorer/commerce test`). No database.
  - §7.4's early renewal: 60 days left + 365 → 425 days from now.
  - An expired base stacks from now.
  - The term cap on both sides of `now + d`.
  - Half-up rounding at .5 VND, 1% and 100%.
  - Vietnam day start and end for a date, and "before today" at 23:59 and 00:00
    local.
  - Signatures: valid, one byte flipped, re-serialized body, missing header, wrong
    secret, different length.
- **Database — `constraints.spec.ts` and `schema-fidelity.spec.ts`**
  (`pnpm --filter @knowledge-explorer/database test`). Catalog presence and
  enforced behaviour for the new DDL; the declared-additions allowlist.
- **Integration — six `apps/api/test/commerce-*.e2e-spec.ts` files**
  (`pnpm --filter @knowledge-explorer/api test commerce`), supertest against a
  booted module with `{ rawBody: true }`, sessions seeded as
  `topic-requests.e2e-spec.ts` does. Each carries the spec's assertions for its
  area.
  - **Webhook:** the guard-absence test, re-serialized body, replay, terminal
    orders, mismatch, concurrent stacking, milestone reset.
  - **Checkout:** the refusal ladder in order, warnings, the rate cap, provider
    error → failed, `/me/orders` isolation, the owner orders list.
  - **Discounts:** every evaluation row, and the in-flight bound — a code
    deactivated after checkout still grants at webhook.
  - **Unavailable provider:** boots with `PAYMENT_PROVIDER=''`.
  - **Mutation checks:** two tasks require breaking the implementation and
    watching a test fail — the advisory lock (task 12) and stacking (task 2). A
    concurrency or money test that passes against a broken implementation is worse
    than none, which P9's notes record from experience.
- **Browser — `apps/learner-web/e2e/commerce.spec.ts`**
  (`pnpm --filter @knowledge-explorer/learner-web test:e2e`), the spec's seventeen
  steps in one serial file, alongside P7's and P9's.
  - `learner.spec.ts` test 1 is proven to pass without its pricing workaround.
  - Steps 3 (revalidation), 4 (sign-in return), 6 (a redirect never grants) and
    14–15 (cross-app owner actions) cannot move to the api suite.
- **Gate — `pnpm verify`** green across the monorepo; both browser suites green;
  `scripts/verify-magic-link.sh` passing; `prisma migrate status` clean.

## Out of scope

The spec's non-goals stand unchanged:
- P8b (Resend `EmailProvider`, the reminder job, purchase email, magic-link
  delivery);
- any real gateway adapter;
- refunds, and nothing writing `refunded`;
- reconciliation and abandoned-order cleanup;
- automatic renewal;
- price grandfathering;
- overlap credit;
- snapshotting duration onto orders;
- non-VND currencies, tax and invoices;
- editing fixed fields, and un-revoking grants;
- grants to emails with no account;
- learner cancellation;
- a general rate limiter;
- code stacking and promotions;
- any change to entitlement;
- locked policy values;
- seed data, dashboards and alerting;
- a published narration track.

Discovered during planning and added:

- **`apps/worker` is not touched.** No queue, no job type, no
  `job-permissions.ts` row. Everything in P8a is synchronous request handling.
- **`packages/commerce/src/entitlement.ts` and `packages/shared/src/roles.ts` are
  not modified.** Both are read; the permission reuse is in controllers only.
- **Existing bare-string error codes are not migrated into `errors.ts`**
  (approach 8).
- **`seed.ts`'s `cleanUp` is unchanged.** The commerce scenario owns its cleanup
  because its rows have `NO ACTION` foreign keys that `cleanUp` does not know
  about.
- **No learner-web or admin-web unit-test infrastructure is introduced.** The two
  Next apps are covered by typecheck and the browser suites, as in every phase so
  far.
- **CI does not gain the learner browser suite.** Recorded as a pre-existing gap,
  not closed here.
- **`me/courses`' `repurchase` link and the paywall's link are not retargeted.**
  Both already land on a price block that now carries a buy link.
