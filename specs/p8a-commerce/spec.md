# Spec: P8a — Commerce: products, checkout, webhook, grants

**Status:** Approved
**Date:** 2026-09-13

Derived from `knowledge-explorer-spec.md` §12 phase P8 — *"Products, checkout,
webhook verification, entitlement with expiry, renewal stacking, `EmailProvider`,
reminder job, signed URLs, manual grants."* That document is the product source of
truth and is locked except §14; this spec adds only the implementation decisions
P8a requires and the product spec does not make.

**P8 is split in two.** §12 budgets it at 2.5 weeks, the largest phase in the
plan. This spec is **P8a**: products, price-check, discount codes, checkout, the
payment webhook, renewal stacking, manual grants, and the owner and learner screens
over them. **P8b** — a Resend `EmailProvider`, FR-COM-05's daily reminder job
(§7.5), and any purchase email — gets its own spec after P8a ships, so it starts
from real grant-writing code rather than from this document. Two items in §12's P8
row are already delivered and are not rebuilt: *entitlement with expiry*
(`packages/commerce/src/entitlement.ts`, P7) and *signed URLs*
(`apps/api/src/public/media.controller.ts`, P7, 10-minute TTL under NFR-02).

**§14 decision 1 (payment gateway) stays open, deliberately.** P8a builds §11's
`PaymentProvider` port and a deterministic fake behind it, and **no real gateway
adapter**. Every flow — checkout, the signed webhook, stacking, refusals — is real
and end-to-end tested against the fake; choosing a gateway later is one adapter,
not a phase. §14 decision 2 (grace period length) remains per-product
configuration with a default of 0. P8a closes no §14 decision.

It assumes `specs/p0-foundation/` through `specs/p7-learner/` and
`specs/p9-topic-requests/` are delivered, which as of this writing they are.

## Problem statement

Three §8 tables have existed since P0's initial migration and nothing writes any
of them. `products`, `access_grants` and `payment_orders` are read — P7's
entitlement resolver reads grants, P7's catalog reads products, P6's checklist
counts products — but no endpoint, job or screen creates a row. Verified by
reading the repository:

- **A paid course cannot be published through the product.** §5.7's
  `active_product_for_paid` item (`packages/content/src/publish-checklist.ts:192`)
  refuses a paid course with no active product, and no product can be created. The
  learner browser suite works around it by publishing as `free` and flipping the
  column back to `paid` through Prisma (`apps/learner-web/e2e/learner.spec.ts`
  test 1, the block commented "P8 owns products").
- **No grant can be created except by hand.** `apps/learner-web/e2e/helpers.ts:91`
  `grantAccess()` writes `access_grants` directly, commented "P8 owns grant
  creation; until then the suite writes the row it would."
- **§11's `PaymentProvider` does not exist.** `packages/commerce/src/index.ts`
  exports entitlement and nothing else.
- **The price blocks have no action.** The course page
  (`apps/learner-web/app/courses/[slug]/page.tsx:89`) and category page
  (`app/categories/[slug]/page.tsx:49`) render price and bundle offers with no
  buy link; `me/courses`' `repurchase` link points at the course page; the
  paywall's comment says "`POST /checkout` is P8's".
- **The API cannot verify a webhook signature today.** `apps/api/src/main.ts`
  calls `NestFactory.create(AppModule)` without `rawBody`, so a controller sees
  only JSON re-parsed by the body parser. An HMAC over re-serialized JSON fails
  whenever the provider's whitespace or key order differs from Node's — silently
  for one gateway and not another. Every api e2e suite builds its app with
  `moduleRef.createNestApplication()`, which has the same gap.
- **Prices sit behind a 300-second ISR window.** Both pages above set
  `revalidate = 300`, and the only on-demand revalidation (`revalidateLearnerPages`
  in `packages/shared/src/revalidation.ts`) fires on publish, unpublish and
  archive — not on a price change.
- **The learner sign-in page cannot return anywhere.** `app/signin/page.tsx`
  calls `signIn('email', { email, redirect: false })` with no destination, so a
  learner sent to sign in from a checkout page lands on the default page afterwards.

Three things about P8a are unlike every phase before.

**It is the first code path that moves money.** Every defect class so far cost an
admin a regeneration or a learner a stale page. Here a stacking bug destroys paid
time (§7.4: "Writing `now + accessDurationDays` silently destroys paid time"), a
missing idempotency check double-extends a grant, and a fake provider reachable in
production grants access to anyone who clicks a button.

**It is the first unauthenticated write endpoint whose only credential is a
signature.** The webhook carries no session and must not: the caller is a payment
gateway. Its trust comes entirely from `verifyWebhook` over the raw request bytes.
Everything P7 and P9 established about asserting a *deliberate* absence of guards
applies, with higher stakes.

**It is the first writer of `access_grants`.** P7 built the reader on the promise
that "P8 must call [`isGrantActive`] rather than write a second one." P8a writes
grants and also has to *reason* about them — overlap warnings, the perpetual
refusal, the new-purchases-only rule, the owner's grant list — and every one of
those decisions goes through `isGrantActive`. E-02 still holds: nothing
materializes expiry, and no job touches a grant.

## Acceptance criteria

### The endpoint surface

| Method | Path | Auth | Behaviour |
|---|---|---|---|
| GET | `/api/admin/products` | owner | List, filterable; picker options. **Not in §9.2** |
| POST | `/api/admin/products` | owner | §9.2, FR-COM-01: create a single-course or bundle product |
| PATCH | `/api/admin/products/:productId` | owner | §9.2: price, duration, grace period, active flag |
| GET | `/api/admin/products/:productId/price-check` | owner | §9.2, FR-COM-01: bundle price against the sum of single prices |
| GET | `/api/admin/discount-codes` | owner | List with redemption counts. **Not in §9** |
| POST | `/api/admin/discount-codes` | owner | Create a code. **Not in §9** |
| PATCH | `/api/admin/discount-codes/:codeId` | owner | Edit limits and active flag. **Not in §9** |
| GET | `/api/admin/grants` | owner | List, filterable. **Not in §9.2** |
| POST | `/api/admin/grants` | owner | §9.2, FR-COM-04: grant manually |
| DELETE | `/api/admin/grants/:grantId` | owner | §9.2, FR-COM-04: revoke |
| GET | `/api/admin/orders` | owner | Read-only order list. **Not in §9** |
| GET | `/api/checkout/quote` | learner | What the confirm page shows. **Not in §9.4** |
| POST | `/api/checkout` | learner | §9.4, FR-COM-02: create a pending order, return the redirect |
| GET | `/api/me/orders` | learner | Own order history. **Not in §9.4** |
| GET | `/api/me/orders/:orderId` | learner | One own order, polled by the return page. **Not in §9.4** |
| POST | `/api/webhooks/payment` | signature | §9.4, FR-COM-03: verify, mark paid, create or extend the grant |
| GET, POST | `/api/payments/fake/checkout/:reference` | none | The fake provider's hosted page. **Mounted only when `PAYMENT_PROVIDER=fake`** |

- **"owner"** means `@UseGuards(SessionGuard, RolesGuard)` on an
  `@Controller('admin/…')` class, the shape `TopicRequestsAdminController` already
  has. `PublishedLockGuard`, `AssignmentGuard` and `OwnerFieldGuard` are absent and
  that is correct: none of these writes targets a course's content, and R-01 is
  about editing a published course, not about selling one.
- **§3 has no row for "view orders" or "manage discount codes", and P8a adds
  none.** Following P5's precedent for voice configuration, existing actions are
  reused, and `packages/shared/src/roles.ts` does not change:
  - products, price-check and discount codes → `createProductsAndSetPrices` (a
    discount is setting a price);
  - grants and the order list → `grantOrRevokeAccessManually` (the owner reads
    orders to decide grants and revocations, including after a refund issued
    outside the app).
- **"learner"** means `@UseGuards(LearnerSessionGuard, RolesGuard)` with
  `@RequirePermission('buyAccessReadListenTrackProgress')`. §3 gives buying to
  `learner` alone. An owner signed into admin-web receives `401 UNAUTHENTICATED`
  first — their cookie is admin-web's, which `LearnerSessionGuard` does not read —
  and a learner-cookie session with a staff role receives `403 FORBIDDEN_ROLE`.
  Both are asserted.
- **"signature"** means the webhook controller carries **no `@UseGuards` and no
  `@RequirePermission`**, and a test named for that absence asserts it, as
  `PublicCatalogController` and `PublicTopicRequestsController` have. Its
  credential is `PaymentProvider.verifyWebhook` over the raw body.
- Every body and query string is validated with zod `strictObject` in the
  controller; every error carries an `errorCode` from `packages/shared/src/errors.ts`.
  Money crosses the wire as a **string of digits**, never a JavaScript number.

### Six endpoints §9 does not list

Each is recorded rather than assumed, as P9 recorded its three:

1. **`GET /admin/products`** — §9.2 has create, patch and price-check but no way
   to find a `productId`. It also carries `courseOptions` / `categoryOptions`
   bounded at 50 with a `targetSearch` parameter, because no admin course-list
   endpoint exists and P9 found 3093 courses in the development database
   (`topic-requests-admin.service.ts:59`).
2. **`GET` / `POST` / `PATCH /admin/discount-codes`** — discount codes are a P8a
   addition (below); they need an owner surface.
3. **`GET /admin/grants`** — `DELETE /grants/:grantId` is unreachable without a
   way to find a `grantId`.
4. **`GET /admin/orders`** — without it, a refund issued outside the app has no
   in-app trail for the owner to revoke against, and a mismatch-failed order is
   visible only in a log.
5. **`GET /checkout/quote`** — FR-COM-02's warning must be shown *before* the
   redirect, and the confirm page shows the resulting expiry under §7.4. Both need
   the caller's grants, so the course page (ISR, anonymous) cannot compute them.
6. **`GET /me/orders` and `GET /me/orders/:orderId`** — the order history page and
   the return page's poll. A browser redirect never grants access (FR-COM-03), so
   the return page learns the outcome only by asking.

### `PaymentProvider` — §11's port, in `packages/commerce`

```ts
// packages/commerce/src/payment-provider.ts
export interface PaymentProvider {
  readonly providerName: string;               // written to payment_orders.provider_name
  createCheckout(input: {
    readonly orderId: string;
    readonly providerOrderReference: string;   // minted by the app, see below
    readonly amount: string;                   // whole VND, digits only
    readonly currencyCode: 'VND';
    readonly description: string;
    readonly returnUrl: string;
  }): Promise<{ readonly redirectUrl: string }>;
  verifyWebhook(input: {
    readonly rawBody: Buffer;
    readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  }): Promise<VerifiedPaymentEvent | null>;    // null ⇔ signature invalid
  getOrderStatus(providerOrderReference: string): Promise<OrderStatus>;
}

export interface VerifiedPaymentEvent {
  readonly providerOrderReference: string;
  readonly outcome: 'paid' | 'failed';
  readonly amount: string;
  readonly currencyCode: string;
  readonly payload: unknown;                   // stored in raw_webhook_payload
}

export const PAYMENT_PROVIDER = Symbol('PaymentProvider');
```

- **`provider_order_reference` is minted by the app** (128 random bits,
  URL-safe) and inserted with the `pending` order *before* `createCheckout` is
  called, so the row exists by the time any webhook can arrive. A real adapter
  must round-trip that reference — as `orderCode`, `vnp_TxnRef`, or metadata,
  depending on the gateway. That is a constraint on the future adapter, recorded
  here and in the port's comment.
- **`getOrderStatus` has no caller in P8a.** §11 names it and the port declares it.
  Abandoned orders stay `pending` (below), so nothing reconciles. The fake
  implements it from the outcomes its own hosted page has delivered, or `pending`
  otherwise.
- **Selection is explicit opt-in, and deliberately unlike the other three
  providers.** `IMAGE_PROVIDER`, `LLM_PROVIDER` and `TTS_PROVIDER` select their fake
  when unset. A fake *payment* provider grants paid access to anyone, so:
  - `PAYMENT_PROVIDER=fake` binds `FakePaymentProvider`, and the API **refuses to
    boot** without `PAYMENT_FAKE_WEBHOOK_SECRET`, as `openai` without a key does.
  - Unset or any other value binds `UnavailablePaymentProvider`: `POST /checkout`
    returns `503 PAYMENT_PROVIDER_UNAVAILABLE`, `POST /webhooks/payment` returns
    `503`, and `/api/payments/fake/*` is **not registered** and returns 404.
  - `GET /checkout/quote` still works and reports the unavailability, so the
    confirm page can say the store is closed instead of failing on click.
  - Asserted by an api e2e file that boots `AppModule` with `PAYMENT_PROVIDER`
    unset.
- **The fake's signature** is HMAC-SHA256 over the raw body, hex-encoded, in an
  `x-fake-payment-signature` header, compared with `crypto.timingSafeEqual`. The
  body is `{ providerOrderReference, outcome, amount, currencyCode }`.
- **Raw body.** `main.ts` passes `{ rawBody: true }` to `NestFactory.create`, and
  every api e2e suite that exercises the webhook passes it to
  `createNestApplication`. The webhook controller reads `request.rawBody` and never
  the parsed body for verification. **Asserted:** a correctly signed body,
  re-serialized with different whitespace and delivered with the original
  signature, is refused — the test that proves the bytes, not the object, are what
  was signed.
- `packages/commerce` is server-only. It already is (only `apps/api` depends on
  it), and the fake's `node:crypto` import keeps it so; neither Next app may import
  it.

### The fake provider's hosted page

- `GET /api/payments/fake/checkout/:reference` serves a minimal HTML page:
  product display name (HTML-escaped — it is owner-entered text), amount, and two
  buttons, **Pay** and **Fail**, each a `<form method="post">`.
- `POST` to the same path builds the webhook body for that order, signs it with
  `PAYMENT_FAKE_WEBHOOK_SECRET`, and **delivers it over HTTP to
  `/api/webhooks/payment`** — the same controller, raw-body path and verification
  a real gateway's call would take — then answers `303` to the order's return URL.
  It never calls the webhook service in-process: the network hop is what makes the
  fake exercise the real path.
- An unknown reference is 404. A reference whose order is no longer `pending`
  still delivers, which is how the browser scenario exercises replay through the
  product.
- The controller is registered in `app.module.ts` only when
  `PAYMENT_PROVIDER === 'fake'` at module evaluation, **and** each handler checks
  the bound provider's name and returns 404 otherwise — two layers, because
  a controller left registered by mistake is the failure that matters here.
- The return URL is `${LEARNER_WEB_URL}/checkout/return?orderId=<id>`; the page's
  own URL is built from a new `API_PUBLIC_URL` (default `http://localhost:3001`).

### FR-COM-01 — products

- **`POST /admin/products`** body, a discriminated union on `productType`:
  `{ productType: 'single_course', courseId }` or
  `{ productType: 'category_bundle', categoryId }`, plus `displayName` (trimmed,
  1–120), `priceAmount`, `accessDurationDays` (integer ≥ 1, default 365),
  `gracePeriodDays` (integer ≥ 0, default 0), and an optional
  `currencyCode: 'VND'`.
  - **`priceAmount` is a string of digits, integer ≥ 0 VND**, at most 10 digits
    (`Decimal(12,2)`'s integer part). VND has no minor unit; `"1500.50"` is 400
    `INVALID_BODY`. Zero is allowed and goes through the provider like any other
    amount.
  - **Currency is VND only.** Any other `currencyCode` is `400 INVALID_BODY`.
  - `renewalType` and `bundleInclusionPolicy` are not accepted; §7.4 and §7.2 lock
    them and the schema defaults write the locked values.
  - Unknown target → `404 COURSE_NOT_FOUND` / `CATEGORY_NOT_FOUND`. A product may be
    created for a course in any publication status — it must exist *before* a paid
    course can pass the checklist.
  - A second active product for the same course or category fails the partial
    unique index; the P2002 maps to `409 PRODUCT_ALREADY_ACTIVE` carrying the
    existing `productId`.
- **`PATCH /admin/products/:productId`** accepts exactly §9.2's four fields:
  `priceAmount`, `accessDurationDays`, `gracePeriodDays`, `isActive`. `productType`,
  the target and `displayName` are fixed at creation; the body refuses them as
  `400 INVALID_BODY`. Reactivating while another product is active for the same
  target → `409 PRODUCT_ALREADY_ACTIVE`.
  - A change applies to later checkouts. **Duration and grace are read from the
    product when the webhook arrives**, so a pending order paid after a duration
    change receives the new duration. The order's `amount` never changes after
    checkout. Existing grants are untouched: each carries its own
    `grace_period_days`.
- **Save warnings, never blocking.** `POST` and `PATCH` responses carry
  `warnings: [...]`:
  - `BUNDLE_PRICE_NOT_BELOW_SUM` — on saving a `category_bundle`, per FR-COM-01,
    carrying the price-check result below. A single-course save does not warn; the
    price-check endpoint is how the owner re-checks a bundle after changing a single
    price.
  - `COURSE_NOT_FOR_SALE` — when one or more **published, paid** courses had an
    active covering product before the save and have none after it (neither a
    single product nor a bundle for their category), naming each. A course that
    was already unsellable before the save does not re-warn. Deactivating a bundle can orphan
    several courses at once. Pending orders for a deactivated product still grant if
    paid; existing grants are unaffected; the course page shows its existing
    `not-for-sale` state.
- **`GET /admin/products/:productId/price-check`** returns
  `{ bundlePriceAmount, sumOfSinglePriceAmounts, isBelowSum, includedCourses:
  [{ courseId, title, priceAmount }], coursesWithoutSingleProduct: [{ courseId,
  title }] }`, over the category's courses with `publication_status = 'published'`.
  A published course with no active single product is excluded from the sum and
  listed. With no included course the sum is `"0"` and any price is "not below"
  it — that is FR-COM-01's arithmetic, not a special case. A `single_course`
  product → `400 PRICE_CHECK_NOT_BUNDLE`.
- **`GET /admin/products?courseId=&categoryId=&includeInactive=&targetSearch=`**
  lists products with target title and slug, plus the bounded picker options.
- **A product write revalidates the learner pages that show its price**, through
  the existing best-effort `revalidateLearnerPages`: a single-course product → its
  course and that course's category; a bundle → its category and every published
  course in it, because each course page shows the bundle offer. A failure never
  fails the save. This is P7's publish-hook rule applied to the other thing those
  pages render.

### Discount codes

**Not in §5.9 or §9; added to P8a by decision.** A code is a percentage off
chosen products.

- **Shape.** `code` (3–32 characters of `A–Z`, `0–9` and `-`, **stored uppercase
  and matched case-insensitively**), `percentOff` (integer 1–100), and either
  `appliesToAllProducts: true` or a non-empty `productIds` list — exactly one of
  the two.
- **Optional limits**, each independent:
  - `startsOn` / `endsOn` — dates, interpreted in **Asia/Ho_Chi_Minh** as 00:00:00.000
    and 23:59:59.999 of that day and stored as `timestamptz`;
  - `maxRedemptions` — integer ≥ 1;
  - `oncePerLearner` — boolean;
  - `newPurchasesOnly` — boolean.
- **A redemption is a `paid` order carrying the code.** Pending and failed orders
  do not count.
- **Editable after creation:** `startsOn`, `endsOn`, `maxRedemptions`,
  `oncePerLearner`, `newPurchasesOnly`, `isActive`. **Fixed:** `code`,
  `percentOff`, the product list; the PATCH body refuses them as `400 INVALID_BODY`.
  To change a discount, deactivate the code and create another. Lowering
  `maxRedemptions` below the current count is allowed and exhausts the code.
- A duplicate code → `409 DISCOUNT_CODE_ALREADY_EXISTS`.
- **Amount.** `amount = round_half_up(listPrice × (100 − percentOff) / 100)` in whole
  VND, computed in integer arithmetic by one pure function in `packages/commerce`.
  100% yields `"0"`, and a zero-amount order **still goes through the provider and
  the webhook** — FR-COM-03 has no exception for free.
- **Evaluation at quote and checkout**, first failure wins, each returning `422`:

  | Condition | `errorCode` |
  |---|---|
  | Unknown code, or `is_active = false` | `DISCOUNT_CODE_NOT_FOUND` |
  | Now outside `[starts_at, ends_at]` | `DISCOUNT_CODE_OUTSIDE_WINDOW` |
  | Product not covered by the code | `DISCOUNT_CODE_NOT_APPLICABLE` |
  | Paid orders with the code ≥ `max_redemptions` | `DISCOUNT_CODE_EXHAUSTED` |
  | `once_per_learner` and the caller has a paid order with it | `DISCOUNT_CODE_ALREADY_USED` |
  | `new_purchases_only` and the caller's **same-scope** grant is active per `isGrantActive` | `DISCOUNT_CODE_NEW_PURCHASES_ONLY` |

  - *Same-scope* means the row the webhook would extend: the course row for a
    single product, the category row for a bundle. A learner whose grant has
    lapsed past expiry and grace may use a new-purchases-only code — that is a
    win-back, not a renewal.
- **Limits are enforced at checkout only.** A webhook for an order whose code has
  since expired, been deactivated or been exhausted by a concurrent order **grants
  normally** at the amount the learner paid. `max_redemptions` and
  `once_per_learner` can therefore be exceeded by orders in flight. This is a known
  bound, recorded here and asserted by a test, so a later reader does not "fix" it
  in the webhook by refusing money already taken.

### FR-COM-02 — checkout

**`GET /checkout/quote?productId=&discountCode=`** and **`POST /checkout`**
`{ productId, discountCode? }` share one evaluation in
`apps/api/src/commerce/checkout.service.ts`. The POST **recomputes everything** and
never trusts a quote.

Quote response:

```
{
  product:  { productId, productType, displayName, accessDurationDays, gracePeriodDays, currencyCode },
  target:   { scopeType, courseSlug?, courseTitle?, categorySlug, categoryName },
  listPriceAmount, amount,
  discount: { code, percentOff } | null,
  discountError: { errorCode } | null,        // amount is then the undiscounted price
  currentExpiresAt: string | null,            // the same-scope, un-revoked row
  resultingExpiresAt: string,                 // §7.4 stacking, previewed
  isRenewal: boolean,                         // a same-scope, un-revoked row exists
  warnings: [ { code, ... } ],
  blockedBy: { errorCode, ... } | null,       // what POST /checkout would refuse with
  paymentAvailable: boolean
}
```

**Refusals**, evaluated in this order; the first wins:

| # | Condition | Status, `errorCode` |
|---|---|---|
| 1 | No payment provider bound (POST only) | `503 PAYMENT_PROVIDER_UNAVAILABLE` |
| 2 | Unknown product, or `is_active = false` | `404 PRODUCT_NOT_FOUND` |
| 3 | Single: course not `published` | `409 CHECKOUT_COURSE_NOT_PUBLISHED` |
| 4 | Single: course `pricing_type = 'free'` | `409 CHECKOUT_COURSE_FREE` |
| 5 | Bundle: category has no `published` course | `409 CHECKOUT_BUNDLE_EMPTY` |
| 6 | A perpetual un-revoked grant on the same scope, **or**, for a single product, on the course's category | `409 CHECKOUT_ALREADY_PERPETUAL` |
| 7 | Stacked term too long (below) | `409 CHECKOUT_TERM_TOO_LONG` |
| 8 | Discount code fails (table above) | `422 DISCOUNT_CODE_*` |
| 9 | Rate limit (POST only) | `429 CHECKOUT_RATE_LIMITED` |

- **In the quote, a failing discount code is not a refusal.** It is reported in
  `discountError`, the amount falls back to the list price, and `blockedBy` holds
  only rows #2–#7, so the learner can remove the code and still pay. POST with the
  same failing code returns #8's `422`.
- **#6.** A learner with perpetual access to the scope can never lose it, so a
  payment would buy nothing. A bundle purchase over a perpetual *single* grant is
  not refused; it follows FR-COM-02's overlap warning.
- **#7 — the term cap.** With `d = accessDurationDays` and a same-scope un-revoked
  row: refuse when `stackExpiry(currentExpiresAt, now, d) > now + 2d`,
  equivalently when `currentExpiresAt > now + d`. §7.4's own example — renewing two
  months early on 365 days, yielding fourteen months — passes. The 409 carries
  `currentExpiresAt` and `renewableFrom = currentExpiresAt − d`. A first purchase
  can never trip it.
- **#9 — the rate limit.** At most `CHECKOUT_HOURLY_CAP` (default 5) `payment_orders`
  rows **of any status** created by the caller in the trailing hour, counted in
  Postgres. The 429 carries the cap and `retryAfterSeconds`. As with P9's pending
  cap, two simultaneous checkouts at the boundary may both land: it is an abuse
  brake, not an invariant, and no lock is added for it. No Redis limiter.
- **Warnings**, never blocking, computed from the caller's grants through
  `isGrantActive`:
  - `BUNDLE_OVERLAPS_OWNED_COURSES` — FR-COM-02: buying a bundle while holding an
    active single-course grant for a course in that category, naming each course.
    "No refund of the overlap in v1" (§13).
  - `COURSE_COVERED_BY_BUNDLE` — the reverse: buying a single course while holding
    an active category grant covering it. Allowed.
- **On success** POST inserts `payment_orders` in `pending` with `provider_name`,
  the minted reference, `amount`, `list_price_amount`, `currency_code = 'VND'` and
  `discount_code_id`, then calls `createCheckout` and returns
  `201 { orderId, redirectUrl }`. If `createCheckout` throws, the order is marked
  `failed` and the response is `502 PAYMENT_PROVIDER_ERROR`.
- **Abandoned orders stay `pending` forever.** They grant nothing, no job cleans
  them up, and a later checkout creates a new order. They count against the hourly
  cap for an hour and against nothing else.
- FR-COM-02's "the same endpoint serves first purchase and renewal" holds: there is
  no renewal endpoint, and `isRenewal` is informational.

### FR-COM-03 / NFR-06 — the webhook

`POST /api/webhooks/payment`, in one `prisma.$transaction`:

1. **Verify.** `provider.verifyWebhook({ rawBody, headers })`. `null` →
   `401 WEBHOOK_SIGNATURE_INVALID` and **nothing is written** — not even the raw
   payload, which is untrusted input at that point.
2. **Find.** The order by `(provider_name, provider_order_reference)`. Unknown →
   `200`, a warning log, nothing written, so a gateway does not retry forever
   against a reference this database never minted.
3. **Lock and check.** `SELECT … FOR UPDATE` on the order row. If `order_status` is
   not `pending` → `200` and no change. **A terminal order never changes again**,
   including a `failed` event arriving after `paid`. This is the replay guarantee:
   idempotent on `(provider_name, provider_order_reference)`.
4. **`failed`** → `order_status = 'failed'`, `completed_at = now`, `raw_webhook_payload`
   stored. No grant.
5. **`paid` but `amount` or `currency_code` differs from the order** →
   `order_status = 'failed'`, `completed_at`, payload stored, an **error-level**
   structured log with `reason: 'PAYMENT_AMOUNT_MISMATCH'`, and `200`. No grant.
6. **`paid` and matching** → `order_status = 'paid'`, `completed_at`, payload
   stored, and the grant write below **in the same transaction**. If the grant write
   fails, the order stays `pending` and the gateway's retry replays the whole thing.

`completed_at` is written for both terminal statuses: it records when the order
settled, not only when it succeeded.

**The grant write** — `applyPurchaseToGrant` in `apps/api/src/commerce/`:

- **Serialized per learner and scope** with
  `pg_advisory_xact_lock` keyed on `(userId, scopeType, scopeId)`. Two different
  paid orders for the same learner and scope delivered concurrently must both
  stack. Locking an existing grant row cannot serialize the *insert* case, so the
  row lock alone is insufficient. **Asserted** by a test that delivers two such
  webhooks at once and expects one row, `renewal_count = 1`, and an expiry two
  terms out.
- The product row is read now — duration and grace at webhook time — whether or
  not it is still active.
- **A same-scope un-revoked row exists** → it is extended in place, because the
  partial unique index allows exactly one:
  - `expires_at = stackExpiry(expires_at, now, accessDurationDays)` — §7.4 verbatim:
    `base = expires_at > now ? expires_at : now`;
  - `renewal_count += 1`;
  - `grace_period_days`, `source_product_id` and `payment_order_id` from this purchase;
  - `access_source = 'purchase'`;
  - **`sent_reminder_milestones = '[]'`**, so P8b's reminders fire for the new term
    rather than being suppressed by the old one's;
  - `granted_by_user_id` **unchanged**.
- **That row is perpetual** — possible only if the owner granted perpetual access
  after this checkout passed refusal #6 — → the order is still `paid`, the row keeps
  `expires_at = NULL`, and an info log records it. Nothing is extended and nothing
  is lost.
- **No un-revoked row** → insert: scope from the product, `access_source = 'purchase'`,
  `expires_at = now + accessDurationDays`, the product's `grace_period_days`,
  `source_product_id`, `payment_order_id`, `renewal_count = 0`. A revoked row is
  never extended.
- **No other grant is touched.** A bundle purchase does not modify single-course
  grants in that category, and a single purchase does not modify a bundle grant.
- E-02 holds: expiry stays a computed property of `expires_at + grace_period_days`,
  and nothing writes a status.

### FR-COM-04 — manual grants

- **`POST /admin/grants`** body, a discriminated union on `scopeType`:
  `{ learnerEmail, scopeType: 'course', courseId, expiresOn, gracePeriodDays? }` or
  the `category` / `categoryId` twin.
  - `learnerEmail` is matched case-insensitively. No user → `404 USER_NOT_FOUND`.
    **No account is created**: the learner signs up in learner-web first. A user
    whose role is not `learner` → `422 GRANT_TARGET_NOT_LEARNER`.
  - `expiresOn` is a `YYYY-MM-DD` date, meaning 23:59:59.999 of that day in
    Asia/Ho_Chi_Minh, **or `null` for perpetual** — §7.2 permits `NULL` expiry for
    owner grants only, and this is the only writer of one. A date before today in
    Asia/Ho_Chi_Minh → `400 GRANT_EXPIRY_IN_PAST`.
  - `gracePeriodDays` is an integer ≥ 0, default 0.
  - **A same-scope un-revoked row already exists → `409 GRANT_ALREADY_EXISTS`**,
    carrying that grant's id, source and expiry. The owner revokes it first. The
    P2002 from a concurrent insert maps to the same response.
  - Written: `access_source = 'granted_by_owner'`, `granted_by_user_id` from the
    session, no product, no order.
- **`DELETE /admin/grants/:grantId`** sets `revoked_at = now` and returns `204`.
  Revoking an already-revoked grant is `204` with `revoked_at` unchanged. Unknown →
  `404 GRANT_NOT_FOUND`. Purchase grants may be revoked — that is the in-app half
  of a refund issued outside it. There is **no un-revoke**: a new grant inserts a
  new row, which the partial index permits.
  - "Revocation takes effect on the next request": `hasAccessToLesson` checks
    `revoked_at` first and caches nothing. A signed media URL minted before the
    revocation survives up to its 10-minute TTL — E-03's bound, accepted and stated.
- **`GET /admin/grants?learnerEmail=&courseId=&categoryId=&status=&page=&pageSize=`**
  — `status` is `live` (un-revoked, the default), `revoked` or `all`, filtered in
  SQL on `revoked_at`. **Each row's `isActive` is computed by `isGrantActive`**, never
  by a SQL expiry predicate: §7.3's arithmetic exists in exactly one place, and
  "active or expired" is a display column, not a filter. Rows carry the learner's
  email, scope names, source, `expiresAt`, `gracePeriodDays`, `renewalCount`,
  `revokedAt`, the granting owner's email, and the source product's name.
  Pagination uses the catalog's bounds (`DEFAULT_PAGE_SIZE`, `MAX_PAGE_SIZE`,
  `apps/api/src/public/catalog.service.ts`).

### Orders

- **`GET /admin/orders?status=&learnerEmail=&page=&pageSize=`**, newest first:
  learner email, product name and type, target title, `amount`,
  `listPriceAmount`, discount code, provider name and reference, status,
  `createdAt`, `completedAt`. `raw_webhook_payload` is not serialized.
- **`GET /me/orders`**, newest first, paginated: product name, target slug and
  title, `amount`, `listPriceAmount`, discount code, status, `createdAt`,
  `completedAt`. No provider reference.
- **`GET /me/orders/:orderId`** returns the caller's own order. Another learner's
  order is `404 ORDER_NOT_FOUND`, indistinguishable from a missing one — P9's
  withdrawal rule, for the same reason.

### The schema change — one new migration

```sql
-- packages/database/prisma/migrations/<timestamp>_add_discount_codes/migration.sql
CREATE TABLE "discount_codes" (
  "id"                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "code"                     TEXT NOT NULL,
  "percent_off"              INTEGER NOT NULL,
  "applies_to_all_products"  BOOLEAN NOT NULL DEFAULT false,
  "starts_at"                TIMESTAMPTZ(6),
  "ends_at"                  TIMESTAMPTZ(6),
  "max_redemptions"          INTEGER,
  "once_per_learner"         BOOLEAN NOT NULL DEFAULT false,
  "new_purchases_only"       BOOLEAN NOT NULL DEFAULT false,
  "is_active"                BOOLEAN NOT NULL DEFAULT true,
  "created_by_user_id"       UUID NOT NULL,
  "created_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "discount_codes_code_key" UNIQUE ("code"),
  CONSTRAINT "discount_codes_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id")
    REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "discount_codes_percent_off_check"     CHECK ("percent_off" BETWEEN 1 AND 100),
  CONSTRAINT "discount_codes_code_uppercase_check"  CHECK ("code" = upper("code")),
  CONSTRAINT "discount_codes_max_redemptions_check" CHECK ("max_redemptions" IS NULL OR "max_redemptions" >= 1),
  CONSTRAINT "discount_codes_window_check"          CHECK ("starts_at" IS NULL OR "ends_at" IS NULL OR "starts_at" < "ends_at")
);

CREATE TABLE "discount_code_products" (
  "discount_code_id" UUID NOT NULL REFERENCES "discount_codes"("id") ON DELETE CASCADE,
  "product_id"       UUID NOT NULL REFERENCES "products"("id")       ON DELETE CASCADE,
  PRIMARY KEY ("discount_code_id", "product_id")
);

ALTER TABLE "payment_orders"
  ADD COLUMN "list_price_amount" NUMERIC(12,2) NOT NULL,
  ADD COLUMN "discount_code_id"  UUID;
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_discount_code_id_fkey"
  FOREIGN KEY ("discount_code_id") REFERENCES "discount_codes"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- The hourly checkout cap and /me/orders.
CREATE INDEX "idx_payment_orders_user_created" ON "payment_orders" ("user_id", "created_at" DESC);
-- Redemption counts: paid orders per code.
CREATE INDEX "idx_payment_orders_discount_paid" ON "payment_orders" ("discount_code_id")
  WHERE "order_status" = 'paid';
```

- **A new migration, never a regeneration** (CLAUDE.md invariant 1). It is
  hand-written in the style of `20260913185000_add_topic_request_duplicate_of`,
  with a header comment naming this spec.
- **`list_price_amount` is `NOT NULL` with no default or backfill** because no
  code has ever written `payment_orders`: P8a is its first writer. If a development
  database holds hand-seeded rows, the migration fails loudly rather than inventing
  a price.
- The CHECK constraints and the partial index are exactly what Prisma cannot
  express; `schema.prisma` gains the two models, the two `PaymentOrder` fields and
  their relations, with a comment pointing at the migration.
- `packages/database/test/constraints.spec.ts` gains assertions for all four CHECK
  constraints (and one enforced-behaviour case each for percent and uppercase), both
  foreign keys on `payment_orders` and `discount_code_products`, both indexes, and
  the partial predicate on `idx_payment_orders_discount_paid`.
- No other column changes. `access_grants`, `products` and their hand-written
  indexes from the initial migration are used as they are.

### The screens

**learner-web, Vietnamese copy, inline, no catalogue.**

- **Price blocks gain buy links.** The course page's single and bundle offers and
  the category page's bundle offer link to `/checkout/:productId`
  (`data-testid="buy-single"` / `buy-bundle`). The links carry no per-learner
  state, so both pages stay ISR and anonymous-cacheable.
- **`app/checkout/[productId]/page.tsx`**, `force-dynamic`:
  - Signed out → a sign-in link carrying `callbackUrl` back to this page.
  - Signed in → the quote: product, target, list price, a discount-code field that
    re-quotes, the amount, access duration, current and resulting expiry, every
    warning in words, and — when `blockedBy` is set — the refusal in words with
    **no pay button**.
  - **Pay** POSTs `/checkout` and navigates to `redirectUrl`.
- **`app/checkout/return/page.tsx`** polls `GET /me/orders/:orderId` every 2 s for
  up to 60 s:
  - `paid` → success and a link into the course;
  - `failed` → failure and a link back to the confirm page;
  - still `pending` → "đang xử lý" and a link to `/me/orders`.
  - The page **writes nothing**, and nothing about access depends on it having
    loaded.
- **`app/me/orders/page.tsx`**, `force-dynamic` — the learner's order history.
- **`app/signin/page.tsx`** accepts a `callbackUrl` search parameter and passes it
  to `signIn` as `redirectTo`. **Only a relative path beginning with a single `/`
  is honoured**; anything else is ignored, so the parameter is not an open redirect.
- `app/layout.tsx` nav gains a link to `/me/orders`. `me/courses`' `repurchase` link
  and the paywall's course link are unchanged — both lead to a price block that now
  has a buy link. The paywall's "P8's" comment is corrected.
- NFR-09: the confirm, return and orders pages are usable without horizontal
  scrolling from 360 px.

**admin-web, English copy.** NFR-09: 1280 px and wider. `app/(portal)/layout.tsx`
nav gains Products, Discount codes, Grants and Orders.

- **`app/(portal)/products/page.tsx`** — list with course/category filter and
  inactive toggle. A create form with a type radio and a searchable target picker
  over `courseOptions` / `categoryOptions`. Edit in place for the four PATCH
  fields. Save warnings render inline and do not block. Bundle rows get a
  price-check panel.
- **`app/(portal)/discount-codes/page.tsx`** — list with redemption counts. A
  create form: code, percent, all-or-selected products, dates, cap, the two flags.
  Rows edit only the editable fields.
- **`app/(portal)/grants/page.tsx`** — filters by learner email, course, category
  and status. A create form with an expiry date picker **labelled with its
  timezone**, a "no expiry" option and a grace field. A revoke action per live row.
  An expired-but-live row is visibly distinct from an active one, using
  `isActive`.
- **`app/(portal)/orders/page.tsx`** — read-only list with status and learner
  filters.
- Every form is convenience, not enforcement: each rule above is checked
  server-side before anything is written.

## Non-goals

- **Everything in P8b.** No real `EmailProvider`, no Resend adapter, no FR-COM-05
  reminder job, no §7.5 milestones logic (P8a only *resets* the column on
  extension), no `send_expiry_reminder` producer, queue or `job-permissions.ts` row,
  no purchase-confirmation or receipt email, and no change to how magic links are
  delivered. `LogEmailProvider` is untouched.
- **A real payment gateway adapter.** §14 decision 1 stays open. No PayOS, VNPay,
  MoMo or Stripe code, credentials or sandbox configuration.
- **Refunds.** Nothing writes `order_status = 'refunded'`. A refund happens outside
  the app, and the owner revokes the grant with `DELETE /admin/grants/:grantId`.
- **Reconciliation.** No caller of `getOrderStatus`, no cleanup of abandoned
  `pending` orders, no job of any kind.
- **Automatic renewal, payment mandates, dunning, cancellation** (§13, §7.4).
- **Price grandfathering at renewal** (§13); **refund or credit for bundle overlap**
  (§13).
- **Snapshotting duration or grace onto the order.** They are read at webhook time.
- **Currencies other than VND**, fractional prices, tax, VAT, e-invoices, receipts.
- **Editing** a product's type, target or display name; a discount code's string,
  percent or product list; a grant's term. Replace instead: deactivate and
  recreate, or revoke and regrant.
- **Un-revoking a grant.**
- **Granting to an email with no account**, or creating accounts from admin-web.
- **Learner cancellation of a pending order.**
- **A general or Redis rate limiter.** The hourly order cap is the only brake.
- **Discount-code stacking, automatic promotions, sale prices on products, referral
  or affiliate codes.**
- **Changing entitlement.** `isGrantActive`, `hasAccessToCourse` and
  `hasAccessToLesson` are called, never modified. No status column, no expiry job
  (E-02).
- **Any change to `bundle_inclusion_policy` or `renewal_type`** beyond the locked
  defaults.
- **Seed or demo data** (P10). **Cost dashboards, alerting** (P10).
- **A published track for narration and audio** (P7's recorded limitation).

## Constraints

- **`knowledge-explorer-spec.md` outranks this document.** §5.9, §7.1–§7.4 including
  E-01/E-02/E-03 and the stacking rule, §3's matrix, §8's schema and §9's routes are
  not reopened here.
- **Node 22** (`nvm use`); **ffmpeg and ffprobe** present, because the browser suite
  spawns the worker.
- **CLAUDE.md invariant 1**: never regenerate `20260911180121_init/migration.sql`.
  The discount tables arrive in a new, hand-written migration.
- **Invariant 2**: `UndeclaredPolicyFixtureController` keeps returning `403
  FORBIDDEN_NO_POLICY`. Every new owner and learner endpoint declares a permission.
  The webhook and the fake page declare none, and the webhook's absence is asserted
  by a named test.
- **Invariant 4**: `emitDecoratorMetadata` stays `false`; `PAYMENT_PROVIDER` is
  injected with an explicit `@Inject(PAYMENT_PROVIDER)`.
- **Invariant 6**: Prisma 7.10.0 and next-auth 5.0.0-beta.32 stay pinned. The
  `redirectTo` change uses the pinned API; re-run `scripts/verify-magic-link.sh`
  afterwards (invariant 3).
- **One access decision.** Every "is this grant active" question in P8a — warnings,
  refusal #6, `newPurchasesOnly`, the owner list's `isActive`, and the webhook's
  choice between extend and insert — calls `isGrantActive` from `packages/commerce`
  or reads `revoked_at`/`expires_at` for *identity*, never for *activity*. No SQL
  expiry predicate is written.
- **§7.4's stacking lives once**, as `stackExpiry(currentExpiresAt, now, days)` in
  `packages/commerce/src/renewal.ts`. The confirm page's preview, the term cap and
  the webhook call it.
- **Money** is `Decimal(12,2)` in the database and a digit string on the wire. VND
  amounts are integers; discount arithmetic is integer arithmetic.
- **Dates** that are days (`expiresOn`, `startsOn`, `endsOn`) are interpreted in
  Asia/Ho_Chi_Minh by one helper in `packages/commerce`. Vietnam has used a fixed
  UTC+07:00 with no daylight saving since 1975; the helper's test pins both day
  boundaries.
- **Dependency direction is one-way.** `packages/commerce` imports `database` and
  `shared`; `apps/api` imports `commerce`; neither Next app imports `commerce`;
  api and worker still never import each other. The worker is untouched by P8a.
- Enum-like values stay `String` columns. `orderStatuses`, `productTypes`,
  `scopeTypes` and `accessSources` in `packages/shared/src/enums.ts` are imported,
  not re-declared. Warning codes live beside them in a new
  `packages/shared/src/commerce.ts`, so admin-web and learner-web branch on the same
  strings.
- Tests live in per-workspace `test/`; `*.e2e-spec.ts` for suites that boot an app;
  the api vitest config already lists both globs and runs files serially. Suites
  that need a specific `PAYMENT_PROVIDER` set it before compiling `AppModule`.
- **New environment variables**, each documented in `.env.example`:
  `PAYMENT_PROVIDER` (the example file sets `fake`, with a comment that *unset means
  checkout is closed*), `PAYMENT_FAKE_WEBHOOK_SECRET`, `API_PUBLIC_URL`,
  `CHECKOUT_HOURLY_CAP=5`. `.github/workflows/ci.yml` sets the first two explicitly.
- CORS and cookies are unchanged. The fake page's form posts are same-origin to the
  API, and the webhook is server-to-server.

## Affected files and interfaces

**New**

| Path | Purpose |
|---|---|
| `packages/database/prisma/migrations/<ts>_add_discount_codes/migration.sql` | Two tables, two `payment_orders` columns, four CHECKs, two indexes |
| `packages/commerce/src/payment-provider.ts` | The §11 port, `VerifiedPaymentEvent`, the `PAYMENT_PROVIDER` token |
| `packages/commerce/src/fake-payment-provider.ts` | HMAC-SHA256 fake; builds and signs the webhook body for the hosted page |
| `packages/commerce/src/unavailable-payment-provider.ts` | What unset `PAYMENT_PROVIDER` binds |
| `packages/commerce/src/renewal.ts` | `stackExpiry`, `exceedsTermCap`, `renewableFrom` — §7.4 once |
| `packages/commerce/src/discount.ts` | `applyPercentDiscount` in integer VND |
| `packages/commerce/src/calendar.ts` | Asia/Ho_Chi_Minh day start/end |
| `packages/commerce/test/renewal.spec.ts` | **§7.4's dedicated early-renewal test**, expired base, cap boundary both sides |
| `packages/commerce/test/discount.spec.ts`, `calendar.spec.ts`, `fake-payment-provider.spec.ts` | Rounding; day boundaries; valid, tampered, re-serialized, missing-header and wrong-secret signatures |
| `packages/shared/src/commerce.ts` | Warning codes, the reference format, the code pattern |
| `apps/api/src/commerce/payment-provider.factory.ts` | Env selection, boot refusal without the fake secret |
| `apps/api/src/commerce/products.controller.ts`, `products.service.ts` | Owner products, warnings, price-check, revalidation |
| `apps/api/src/commerce/discount-codes.controller.ts`, `discount-codes.service.ts` | Owner codes; evaluation used by checkout |
| `apps/api/src/commerce/grants-admin.controller.ts`, `grants-admin.service.ts` | Manual grant, revoke, list |
| `apps/api/src/commerce/orders-admin.controller.ts` | Owner order list |
| `apps/api/src/commerce/checkout.controller.ts`, `checkout.service.ts` | Quote, checkout, refusals, warnings, `/me/orders` |
| `apps/api/src/commerce/webhook.controller.ts`, `purchase.service.ts` | Verify, lock, settle, `applyPurchaseToGrant` |
| `apps/api/src/commerce/fake-payment-page.controller.ts` | The hosted page; registered only under `fake` |
| `apps/api/test/commerce-products.e2e-spec.ts` | Validation, 409s, warnings, price-check sums, roles |
| `apps/api/test/commerce-discounts.e2e-spec.ts` | Every evaluation row, case-insensitivity, fixed fields, the in-flight-limit bound |
| `apps/api/test/commerce-checkout.e2e-spec.ts` | Every refusal in order, warnings, rate cap, provider error → failed |
| `apps/api/test/commerce-webhook.e2e-spec.ts` | Signature, raw bytes, replay, terminal orders, mismatch, concurrent stacking, milestone reset, the guard-absence test |
| `apps/api/test/commerce-grants.e2e-spec.ts` | Manual grant, duplicate 409, past expiry, non-learner, revoke idempotency, `isActive` column |
| `apps/api/test/commerce-provider-unavailable.e2e-spec.ts` | `PAYMENT_PROVIDER` unset: 503s, quote reports it, fake route 404 |
| `apps/learner-web/app/checkout/[productId]/page.tsx`, `app/checkout/return/page.tsx`, `app/me/orders/page.tsx` | Confirm, return poll, history |
| `apps/learner-web/lib/commerce-types.ts` | Quote and order views |
| `apps/learner-web/e2e/commerce.spec.ts` | The scenario below |
| `apps/admin-web/app/(portal)/products/page.tsx`, `discount-codes/page.tsx`, `grants/page.tsx`, `orders/page.tsx` | Owner screens |
| `apps/admin-web/lib/commerce-types.ts` | Owner views |

**Modified**

| Path | Change |
|---|---|
| `packages/database/prisma/schema.prisma` | `DiscountCode`, `DiscountCodeProduct`; `PaymentOrder.listPriceAmount`, `discountCodeId`; back-relations on `User` and `Product` |
| `packages/database/test/constraints.spec.ts` | The new CHECKs, FKs and indexes |
| `packages/commerce/src/index.ts` | Barrel exports for the new modules |
| `packages/shared/src/errors.ts` | `PRODUCT_NOT_FOUND`, `PRODUCT_ALREADY_ACTIVE`, `PRICE_CHECK_NOT_BUNDLE`, `DISCOUNT_CODE_ALREADY_EXISTS`, `DISCOUNT_CODE_NOT_FOUND`, `DISCOUNT_CODE_OUTSIDE_WINDOW`, `DISCOUNT_CODE_NOT_APPLICABLE`, `DISCOUNT_CODE_EXHAUSTED`, `DISCOUNT_CODE_ALREADY_USED`, `DISCOUNT_CODE_NEW_PURCHASES_ONLY`, `CHECKOUT_COURSE_NOT_PUBLISHED`, `CHECKOUT_COURSE_FREE`, `CHECKOUT_BUNDLE_EMPTY`, `CHECKOUT_ALREADY_PERPETUAL`, `CHECKOUT_TERM_TOO_LONG`, `CHECKOUT_RATE_LIMITED`, `PAYMENT_PROVIDER_UNAVAILABLE`, `PAYMENT_PROVIDER_ERROR`, `WEBHOOK_SIGNATURE_INVALID`, `ORDER_NOT_FOUND`, `USER_NOT_FOUND`, `GRANT_TARGET_NOT_LEARNER`, `GRANT_ALREADY_EXISTS`, `GRANT_NOT_FOUND`, `GRANT_EXPIRY_IN_PAST`, plus `COURSE_NOT_FOUND` / `CATEGORY_NOT_FOUND` if not already declared |
| `packages/shared/src/index.ts` | Export `commerce.ts` |
| `apps/api/src/main.ts` | `NestFactory.create(AppModule, { rawBody: true })` |
| `apps/api/src/app.module.ts` | The commerce controllers and services; `PAYMENT_PROVIDER` binding; the fake page controller registered conditionally, with a comment |
| `apps/learner-web/app/courses/[slug]/page.tsx`, `app/categories/[slug]/page.tsx` | Buy links on the price blocks |
| `apps/learner-web/app/signin/page.tsx` | `callbackUrl` → `redirectTo`, relative paths only |
| `apps/learner-web/app/layout.tsx` | Nav link to `/me/orders` |
| `apps/learner-web/components/paywall.tsx` | Comment only |
| `apps/learner-web/e2e/learner.spec.ts` | Test 1 creates a product and publishes as `paid`; the free-then-paid workaround is deleted |
| `apps/learner-web/e2e/helpers.ts` | `grantAccess`'s comment updated; `signWebhook(body)` for replay and tamper steps |
| `apps/admin-web/app/(portal)/layout.tsx` | Four nav links |
| `.env.example`, `.github/workflows/ci.yml` | The four variables; CI sets `PAYMENT_PROVIDER` and the fake secret |
| `CLAUDE.md`, `.claude/harness/architecture.md` | `PaymentProvider` now exists (fake only); at completion, not before |

**Read, not modified**

`isGrantActive`, `hasAccessToCourse`, `hasAccessToLesson`
(`packages/commerce/src/entitlement.ts`); `revalidateLearnerPages`
(`packages/shared/src/revalidation.ts`); `LearnerSessionGuard`
(`apps/api/src/auth/learner-session.guard.ts:33`), `SessionGuard`, `RolesGuard`,
`RequirePermission`; `DEFAULT_PAGE_SIZE` / `MAX_PAGE_SIZE`
(`apps/api/src/public/catalog.service.ts`); the checklist's
`active_product_for_paid` (`packages/content/src/publish-checklist.ts:192`), which
needs no change — creating a product is what makes it pass; `ProgressService.myCourses`
(`apps/api/src/public/progress.service.ts`), which already lists purchase grants
correctly; `permissionMatrix` (`packages/shared/src/roles.ts`) — no row added;
`apps/api/src/email/*` — P8b's.

## End-to-end verification

**`pnpm --filter @knowledge-explorer/learner-web test:e2e`** — a new
`e2e/commerce.spec.ts` in the learner browser suite, which boots api (`:3001`),
admin-web (`:3000`) and learner-web (`:3002`) through `webServer` and spawns the
worker in `global-setup.ts`. It runs with `PAYMENT_PROVIDER=fake`. An owner sets up
products in admin-web and a learner buys them in learner-web, so it belongs in the
only suite that runs both apps.

One scripted scenario, asserted end to end. `X` and `Y` are two paid courses in
category `K`; `A` and `B` are learners.

1. **A paid course publishes through the product.** Seed an owner, a plain admin,
   learners A and B, and courses X and Y as `paid`. The owner opens admin-web
   `/products` and creates a single product for X (200 000 VND, 365 days) and for Y
   at the same price. Publish both **as `paid`** — the checklist's
   `active_product_for_paid` passes with no Prisma edit. Open X's course page
   anonymously on `:3002`: the single offer and its buy link are present, and
   **there is no bundle offer**. That render is now the cached page.
2. **Bundle warning.** The owner creates a bundle for K at 400 000 VND. The save
   succeeds and shows `BUNDLE_PRICE_NOT_BELOW_SUM`; the price-check panel shows a
   sum of 400 000 over X and Y.
3. **Prices appear without waiting out ISR.** Reload X's course page immediately:
   the bundle offer and its buy link are now present, well inside the 300-second
   revalidate window. That proves product writes fire the revalidation hook rather
   than riding on step 1's publish.
4. **Sign in from checkout.** A clicks X's buy link signed out, follows the sign-in
   link, completes a magic link, and **lands back on `/checkout/<productId>`**. The
   confirm page shows 200 000 VND and a resulting expiry of now + 365 days.
5. **Discount.** The owner creates `WELCOME10`: 10%, X's product only, new
   purchases only, once per learner, cap 1. A enters `welcome10` in lowercase; the
   amount becomes 180 000.
6. **A redirect never grants.** A clicks Pay and reaches the fake page. **Before
   clicking anything there**, assert the order is `pending` and X's lesson 2 still
   returns `403 LESSON_NOT_ENTITLED`.
7. **Pay.** A clicks Pay. The return page shows success; lesson 2 renders. Assert
   one `access_grants` row: `purchase`, `expires_at` ≈ now + 365 d,
   `renewal_count = 0`. Assert the order: `paid`, `amount = 180000`,
   `list_price_amount = 200000`, the code set.
8. **Replay, tamper, mismatch.**
   - Re-deliver the same signed webhook → `200`, and the grant row is
     byte-identical.
   - Deliver it with one flipped signature byte → `401 WEBHOOK_SIGNATURE_INVALID`,
     nothing written.
   - Start a fresh checkout for Y, then deliver a correctly signed `paid` event with
     the wrong amount → the order is `failed` and no Y grant exists.
9. **Early renewal, §7.4's example.** Set A's X grant to `expires_at = now + 60 d`
   and `sent_reminder_milestones = ["day_30"]`. A's confirm page for X shows
   `resultingExpiresAt` = old expiry + 365 d, and `WELCOME10` is refused with
   `DISCOUNT_CODE_EXHAUSTED`, because its one redemption was step 7 and the cap is
   evaluated before `newPurchasesOnly`. The new-purchases-only row itself is
   covered in `commerce-discounts.e2e-spec.ts`. A pays without a code. Assert the **same row**: `expires_at` = old + 365 d (≈ fourteen months
   out, not twelve), `renewal_count = 1`, milestones `[]`.
10. **Term cap.** A reopens X's confirm page. `CHECKOUT_TERM_TOO_LONG` is shown
    with its renewable-from date, there is no pay button, and `POST /api/checkout`
    returns `409`.
11. **Overlap, both directions.** A opens K's bundle: `BUNDLE_OVERLAPS_OWNED_COURSES`
    names X, and paying is allowed. Assert a new category row and that Y's lesson 2
    now reads. A opens Y's single product: `COURSE_COVERED_BY_BUNDLE` is shown and
    the page still offers Pay.
12. **Failure path.** B checks out X and clicks Fail. The return page shows
    failure, no grant exists, and `/me/orders` lists it as failed.
13. **Rate limit.** B creates orders through the API until the sixth →
    `429 CHECKOUT_RATE_LIMITED` with `retryAfterSeconds`.
14. **Manual grants.**
    - In admin-web `/grants`, the owner grants B perpetual access to K. B's confirm
      pages for X (cross-scope) and for K's bundle (same scope) both show
      `CHECKOUT_ALREADY_PERPETUAL`.
    - Granting B K again → `409 GRANT_ALREADY_EXISTS`.
    - The owner revokes it. B's next request for X's lesson 2 is refused, and the
      grants list shows the row as revoked.
15. **Deactivation.**
    - The owner deactivates X's single product: no warning, because the bundle
      still covers X.
    - The owner deactivates the bundle: `COURSE_NOT_FOR_SALE` names X.
    - X's course page shows its not-for-sale state, and a checkout for X's single
      product → `404 PRODUCT_NOT_FOUND`.
    - A still reads X.
16. **Roles.**
    - The owner's admin-web cookie against `POST /api/checkout` → `401`.
    - The plain admin against `GET /api/admin/grants` → `403 FORBIDDEN_ROLE`, and a
      learner against it → `403`.
    - An anonymous, unsigned `POST /api/webhooks/payment` → `401`, not `403`.
17. **Orders.** The owner's `/orders` shows A's paid and B's failed orders with the
    discount code on A's first. A's `/me/orders` shows only A's orders.

Plus **`pnpm verify`** (typecheck + test) green across the monorepo, including:
- the four new `packages/commerce` unit files, **`renewal.spec.ts`'s early-renewal
  case** among them;
- the six `apps/api/test/commerce-*.e2e-spec.ts` files, with the concurrent-stacking
  and re-serialized-body assertions;
- the extended `packages/database/test/constraints.spec.ts`.

Also `pnpm --filter @knowledge-explorer/admin-web test:e2e` still green,
`apps/learner-web/e2e/learner.spec.ts` green **without its pricing workaround**,
`scripts/verify-magic-link.sh` passing after the sign-in change, and `prisma
migrate status` reporting no drift.

## Open questions

None blocking. Recorded as deliberately deferred:

- **§14 decision 1 — the payment gateway.** Still open. The first real adapter must
  round-trip the app-minted `provider_order_reference`, verify signatures over raw
  bytes, and report `amount` as whole VND.
- **Reconciliation of abandoned or unconfirmed orders.** `getOrderStatus` is
  declared and unused. Revisit with the real adapter, since only a real gateway can
  leave a paid order without a webhook.
- **Discount limits exceeded by in-flight orders.** Accepted as a bound; revisit
  only if a capped code is abused at scale.
- **P8b inherits:** grants whose milestones reset on every extension; a
  `sent_reminder_milestones` column P8a writes but never reads; `LogEmailProvider`
  still the only `EmailProvider`; and P7's note that a `send_expiry_reminder` job
  needs a `job-permissions.ts` row and `JobStatusService.instances()`.
