# Tasks: p0-foundation

**Plan:** specs/p0-foundation/plan.md

Ordered. Tasks 1–7 build the substrate; from task 8 on, each task lands code
plus the test that proves it. The first demonstrable end-to-end behavior is
task 10. Tick boxes as tasks complete — this file is the durable progress
state, so update it as you go rather than at the end.

- [x] **Task 1: Workspace root and the nine package skeletons**
  Root `package.json` with `packageManager` pinned and `engines.node: 22`,
  `pnpm-workspace.yaml`, `.nvmrc`, `.gitignore`, `.env.example`, and a
  `package.json` + `tsconfig.json` for each of the nine workspaces in §11 under
  the `@knowledge-explorer/*` scope.
  - done when: `pnpm install` exits 0 and `pnpm ls -r --depth -1` lists exactly
    nine workspaces at the paths §11 names.

- [x] **Task 2: Turborepo task graph**
  `turbo.json` defining `build`, `typecheck`, `lint`, `test`, with
  `db:generate` declared as a dependency of `typecheck` and `build`.
  - done when: `turbo run typecheck` succeeds from a clean checkout with
    `node_modules` and `.turbo` removed, and an immediate re-run reports a
    cache hit for every task rather than re-executing.

- [x] **Task 3: Docker Compose for PostgreSQL 16 and Redis 7**
  Both services with healthchecks; a named volume for Postgres; connection
  details matching `.env.example`.
  - done when: `docker compose up -d --wait` exits 0, `docker compose ps` shows
    both services healthy, and `psql "$DATABASE_URL" -c 'select 1'` succeeds.

- [x] **Task 4: Shared enums, the §3 matrix, and error codes**
  `packages/shared/src/enums.ts` (zod, 16 columns per §8.1),
  `src/roles.ts` (the §3 matrix as exported data), `src/errors.ts`, and the
  strict `tsconfig.base.json` the other workspaces extend.
  - done when: `pnpm --filter @knowledge-explorer/shared test` passes
    `enums.spec.ts`, asserting every enum's members match §8.1 including
    `snapshot_at_purchase` and `auto`, and asserting the matrix has 16 action
    rows × 3 roles.

- [x] **Task 5: The full 18-table Prisma schema**
  Transcribe §8 into `schema.prisma`: enum-like columns as `String`,
  `price_amount` as `Decimal`, every timestamp as `@db.Timestamptz(6)`, every
  foreign key and `ON DELETE` behavior as written.
  - done when: `prisma validate` passes and `prisma migrate dev --create-only`
    produces SQL containing all 18 `CREATE TABLE` statements.

- [x] **Task 6: Hand-append the raw SQL Prisma cannot express, then verify**
  Add the six partial unique indexes (`idx_chapters_order`,
  `idx_lessons_order`, `idx_products_single_course`,
  `idx_products_category_bundle`, `idx_access_grants_course`,
  `idx_access_grants_category`), the partial index `idx_access_grants_expiry`,
  and the two CHECK constraints to `migration.sql`. Review the whole file
  against §8 line by line. Do not regenerate this migration afterwards.
  - done when: the migration applies to an empty database;
    `constraints.spec.ts` asserts all six partial indexes and both CHECKs exist
    in `pg_indexes` / `pg_constraint` with their predicates; and
    `prisma migrate diff --exit-code` reports no drift.

- [x] **Task 7: Auth.js adapter models, additive only**
  Add `Account`, `Session` and `VerificationToken`, plus one nullable
  `email_verified TIMESTAMPTZ` on `users`. Map the adapter's `email` and `name`
  onto `email_address` and `display_name` with `@map`; rename nothing.
  - done when: `schema-fidelity.spec.ts` reads `information_schema.columns` and
    asserts every §8 column of `users` is present with its original name and
    type, and the three adapter tables exist.

- [x] **Task 8: API bootstrap with database connectivity**
  `apps/api` Nest bootstrap, the `PrismaClient` singleton in
  `packages/database/src/client.ts`, and `GET /health`.
  - done when: with Compose up, `curl -s localhost:<port>/health` returns `200`
    and a body confirming a successful database round trip.

- [x] **Task 9: EmailProvider interface and its log implementation**
  `sendSignInLink(emailAddress, url)`, with the only P0 implementation writing
  to the application log.
  - done when: a unit test asserts the logged line contains the URL, and that
    the implementation opens no network connection.

- [ ] **Task 10: Magic-link sign-in end to end** — first demonstrable behavior
  `apps/admin-web` Next.js shell, the Auth.js route handler wired to the Prisma
  adapter and the email provider, and an unstyled sign-in page.
  - done when: requesting a link for a seeded `admin_owner` writes a URL to the
    log; visiting it creates a row in `Session`; visiting the same link a
    second time is rejected.

- [x] **Task 11: SessionContext and session.guard**
  Resolve `{ userId, userRole, isActive }` from the session row and
  `users.user_role` on every request. Nothing downstream may read identity from
  the request.
  - done when: integration tests show an authenticated request carries the
    correct role; a request injecting `userRole` in body, query and header
    produces an identical response to one without it; and disabling a user
    causes their next call to fail with no process restart.

- [x] **Task 12: roles.guard, deny-by-default, and the admin endpoints**
  `@Roles` decorator, `roles.guard` rejecting every caller when no role is
  declared, `errorCode` on all rejections, and `POST /admins` +
  `PATCH /admins/:userId`.
  - done when: over HTTP — owner creates an admin → `201` with a link logged;
    admin → `403` + `errorCode`; learner → `403`; unauthenticated → `401`; and
    a temporary endpoint with no `@Roles` rejects all three roles.

- [x] **Task 13: published-lock.guard (R-01) and assignment.guard (R-02)**
  Apply both to the chapter and lesson write routes.
  - done when: the R-01 and R-02 rows of the spec's verification table pass —
    admin writing to a `published` course → `403`; owner → `200`; admin writing
    a chapter assigned to another admin → `403`; unassigned → `200`.

- [x] **Task 14: The full policy suite and the eleven-row HTTP matrix**
  `policy.spec.ts` iterating all 48 matrix cells, and `rbac.e2e-spec.ts`
  covering every row of the spec's verification table against a live app.
  - done when: `pnpm test` runs 48 policy assertions and all eleven integration
    rows green, and adding a matrix row without a policy branch fails the suite.

- [x] **Task 15: Guard-binding mutation check**
  Temporarily stub `published-lock.guard` to return `true`; separately strip
  `@Roles` from `POST /admins`. Confirm the suite goes red each time, then
  revert both.
  - done when: both mutations produce a failing suite, the failures name the
    R-01 row and the `POST /admins` row respectively, the result is recorded in
    the PR description, and `git status` is clean afterwards.

- [x] **Task 16: Remaining shells and empty packages**
  `apps/learner-web` serving one page, `apps/worker` connecting to Redis with
  no queues registered, and `packages/content`, `packages/ai`,
  `packages/commerce` each with a manifest, tsconfig and empty `src/index.ts`.
  - done when: both apps boot, the worker logs a successful Redis `PING`, and
    `turbo run build` is green across all nine workspaces.

- [x] **Task 17: CI workflow**
  `.github/workflows/ci.yml` on push and pull request: `pnpm install
  --frozen-lockfile`, migrate against a `postgres:16` service container, then
  `turbo run typecheck lint test`.
  - done when: the workflow runs the same four commands as the local
    verification and the full local sequence passes from a clean checkout.
    Observing the job green is deferred until a git remote exists — see the
    spec's resolved open question.

---

## Progress notes

Recorded 2026-09-12, after tasks 1–7. Read these before continuing at task 8.

**Environment**
- Node 22.23.2 installed via nvm. Fresh shells still resolve Node 20, because
  the user's profile does not source nvm — prefix commands with
  `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"` or run
  `nvm use` first. `pnpm` is a standalone binary and is unaffected.
- Redis is mapped to **host port 6380**, not 6379: a native `redis-server` on
  this machine already holds 6379. The container-internal port is unchanged, so
  CI can map 6379 directly. `REDIS_URL` in `.env.example` reflects 6380.
- `DATABASE_URL` deliberately omits `?schema=public`. Prisma defaults to that
  schema, and omitting it keeps the URL usable by `psql` and other libpq tools.

**Deviations from the plan, and why**
- **Task 7 was executed before task 6's migration was created.** The plan warns
  that regenerating the initial migration discards the hand-written SQL. Adding
  the adapter models first meant one migration containing everything, so the
  hand-written DDL was appended exactly once and never regenerated.
- **Two additive columns on `users`, not one.** The approved deviation
  anticipated `email_verified`. `@auth/prisma-adapter` also requires `image` on
  its User model, so `image_url` (nullable) was added as well. Both are
  asserted nullable by `schema-fidelity.spec.ts`.
- **`User` Prisma field names are `email`, `name`, `emailVerified`, `image`.**
  The adapter writes those names. The §8 column names are preserved through
  `@map`, so the database shape is unchanged — but application code refers to
  `user.email`, not `user.emailAddress`.
- **Prisma is pinned to exactly 7.10.0** (CLI and client). `pnpm add prisma`
  resolves to `8.0.0-rc.13`, because prisma's `latest` dist-tag currently points
  at a release candidate. Do not run `pnpm up` on these two packages without
  checking the resolved version.
- **Prisma 7 moved the connection URL out of the schema.** It now lives in
  `packages/database/prisma.config.ts`, which loads the repository-root `.env`.
  The `datasource` block has no `url`.

**Known gaps carried into later tasks**
- `turbo run lint` executes nothing and warns "No tasks were executed": no
  linter is configured in any workspace. The spec's CI criterion names the
  command, not a tool. Choose one before task 17.
- `prisma migrate diff` reports "No difference detected" even though the partial
  indexes and CHECK constraints exist only in hand-written SQL — Prisma's diff
  does not track them. `constraints.spec.ts` is therefore the only guard against
  losing them; do not weaken it.
- §8.1 catalogues no allowed values for `generation_jobs.job_status`, though the
  column exists with default `queued`. No enum was invented for it. Worth
  raising with the spec owner before P3, which is the first phase to write jobs.

---

## Progress notes, part two

Recorded 2026-09-12, after tasks 8-9 and 11-17. **Task 10 is the only one left.**

**Task 10 is blocked on a version decision, not on effort.** `next-auth` latest
is 4.24.15; Auth.js v5 is still `5.0.0-beta.32`, and `@auth/prisma-adapter`
(stable 2.11.3) pairs with v5. Choosing between a stable v4 and a beta v5 is a
product decision, so nothing was installed. Everything else was built first
because the API guard chain reads `sessions` rows directly and does not depend
on which library writes them.

**Consequences of task 10 being outstanding**
- Verification row 2 ("reusing a sign-in link is rejected") is an `it.todo` in
  `rbac.e2e-spec.ts`. Ten of the eleven rows pass; this one has no endpoint to
  exercise yet and was left visibly undone rather than faked.
- `InvitationService` mints tokens hashed as `sha256(token + AUTH_SECRET)`,
  which is Auth.js's documented scheme. Whichever version is chosen must hash
  the same way, or invitation links will not be consumable. The coupling is
  flagged in a comment on the service.
- `apps/admin-web` exists as a booting Next.js shell; task 10 adds only the
  Auth.js route handler and the sign-in page.

**Decisions taken while implementing**
- **Explicit `@Inject(Token)` everywhere in Nest, never type-based DI.**
  Type-based injection needs `emitDecoratorMetadata`, which esbuild (tsx,
  vitest) does not emit. `emitDecoratorMetadata` is set to `false` deliberately;
  do not "fix" it by turning it on and dropping the tokens.
- **Endpoints declare a §3 *action*, not a role.** `@RequirePermission(action)`
  plus `isAllowed()` keeps the matrix the only place a role decision exists.
- **`UndeclaredPolicyFixtureController` is intentional.** It declares no
  permission and must always return 403 `FORBIDDEN_NO_POLICY`. It is a
  permanent regression fixture for deny-by-default. Do not give it a permission.
- **R-02 is enforced row-level** against a chapter's or lesson's own
  `assigned_admin_id`. §3 phrases it as "courses where they are assigned", but
  §8 defines no course-level assignment column. Whether an unassigned lesson
  should inherit its chapter's assignment is unspecified and was not inferred.
  Worth confirming with the spec owner before P1.
- **`vitest.config.mts` widens the test glob** to `*-spec.ts`. Vitest's default
  only matches `*.spec.ts`, so `rbac.e2e-spec.ts` silently did not run at first
  — and a file that never runs is indistinguishable from a passing one.
- Next 16.3.5 / React 19.3.0, both stable. Worker uses `ioredis` with
  `maxRetriesPerRequest: null`, which is what BullMQ will require in P3.

**Task 15 mutation results (evidence the suite binds to the guards)**
- Stubbing `PublishedLockGuard` to return `true`: row 8 fails, and only row 8.
- Removing `@RequirePermission` from `POST /admins`: rows 1 and 3 fail. Note the
  endpoint became unusable rather than open — deny-by-default fired, which is
  the correct fail-closed behavior.
- Both mutations reverted; no residue remains.
