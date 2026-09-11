# Spec: P0 — Foundation

**Status:** Approved
**Date:** 2026-09-12

Derived from `knowledge-explorer-spec.md` §12 phase P0. That document is the
product source of truth and is locked except §14; this spec adds only the
implementation decisions P0 requires and the product spec does not make.

## Problem statement

The repository contains a complete, locked product specification and no code:
`detect.sh` reports `source_files=0`. None of the eleven phases in §12 can be
built, tested or demonstrated until a substrate exists — a linked monorepo, a
running database carrying the §8 schema, authentication, and role enforcement.
P0 delivers that substrate. It matters disproportionately because the entire
security model is layered on top of it: rule R-01 (only the owner may write to
a published course), rule R-02 (admins are scoped to their assignments) and
requirement E-01 (entitlement gates both the lesson and the media endpoint) all
assume that role resolution is correct and unavoidable. If role enforcement is
wrong here, every later phase inherits the defect. P0 also resolves the three
`[assumed]` items in `.claude/harness/INDEX.md` — implementation language,
runtime and workspace tool — turning them into verified facts.

## Acceptance criteria

**Monorepo and task orchestration**

- `pnpm install` from the repository root links every workspace; `pnpm-workspace.yaml`
  and `pnpm-lock.yaml` are committed, and the root `package.json` pins the
  package manager via the `packageManager` field so CI and local installs agree.
- All nine workspaces declared in §11 exist at exactly those paths — `apps/admin-web`,
  `apps/learner-web`, `apps/api`, `apps/worker`, `packages/database`,
  `packages/content`, `packages/ai`, `packages/commerce`, `packages/shared` —
  each with its own `package.json` under the `@knowledge-explorer/*` scope.
  Packages created but not used until a later phase contain only their manifest,
  a `tsconfig.json` and an empty `src/index.ts`.
- `turbo run build typecheck lint test` succeeds from a clean checkout, and a
  second identical invocation with no file changes reports cache hits for every
  task rather than re-running them.
- `apps/admin-web` and `apps/learner-web` each boot and serve a page; neither
  contains product UI beyond what the sign-in flow needs.

**Database**

- `docker compose up -d` starts PostgreSQL and Redis. Both declare healthchecks,
  and commands that depend on them wait for healthy rather than racing startup.
- A single initial Prisma migration creates all 18 tables from §8 — `users`,
  `categories`, `courses`, `chapters`, `lessons`, `lesson_contents`,
  `lesson_images`, `narration_scripts`, `lesson_audios`, `audio_segments`,
  `published_course_structures`, `products`, `access_grants`, `payment_orders`,
  `lesson_progress`, `topic_requests`, `topic_request_votes`, `generation_jobs`
  — reproducing every column, default, foreign key, `ON DELETE` behavior, index,
  partial unique index and `CHECK` constraint as written in §8.
- Applying the migration to an empty database and then running
  `prisma migrate diff` against the schema reports no drift.
- Enum-like columns are `String` in the Prisma schema, never Prisma `enum`,
  per §8's explicit decision to keep migrations cheap. All 16 such columns
  catalogued in §8.1 — 15 rows, since `script_status` and `audio_status` share
  one — have a zod schema in `packages/shared` whose members match that table
  exactly, including the reserved-but-unused values `snapshot_at_purchase` and
  `auto`.
- `products.price_amount` maps to Prisma `Decimal` (`NUMERIC(12,2)`), never a
  float. Every `TIMESTAMPTZ` column maps to `DateTime @db.Timestamptz(6)`.

**Authentication**

- The owner can create an admin account. Doing so produces a single-use
  sign-in link, delivered through an `EmailProvider` interface whose only P0
  implementation writes the message to the application log.
- Consuming a sign-in link establishes a session persisted as a database row
  via the Auth.js Prisma adapter. Consuming the same link a second time fails.
- Disabling an admin causes that account's next `/api/admin/*` request to
  return `403` — with no process restart, no cache flush and no waiting for a
  token to expire (FR-AUTH-01).
- On every request the API resolves the caller's role by loading the session
  row and reading `users.user_role`. A request that carries a role in its body,
  query string or headers produces exactly the same outcome as one that does
  not (FR-AUTH-02).

**Role enforcement**

- Every API endpoint declares its required role, and an endpoint with no
  declaration denies all callers. Authorization is deny-by-default, not
  allow-by-default.
- Every `403` response carries a machine-readable `errorCode` field
  (FR-AUTH-02).
- Rule R-01 holds: a write to any `/api/admin/*` route returns `403` when the
  target course has `publicationStatus = published` and the caller is not
  `admin_owner`. Enforcement is server-side and independent of any UI.
- Rule R-02 holds: an `admin` may write chapters and lessons only in courses
  where they are the assigned admin or where no assignment exists;
  `admin_owner` is unrestricted.
- An unauthenticated request to `/api/admin/*` returns `401`, distinct from the
  `403` an authenticated-but-unauthorized request receives.

**CI**

- `.github/workflows/ci.yml` runs, on push and pull request: `pnpm install
  --frozen-lockfile`, migrate against a PostgreSQL service container,
  `turbo run typecheck lint test`. Any non-zero exit fails the job.

## Non-goals

These are out of scope for P0 and must not appear in its implementation.

- **All UI beyond sign-in.** No admin portal screens, no lesson editor, no
  learner catalog, no reader, no audio player. Both Next.js apps are bootable
  shells with a sign-in page.
- **All five external provider integrations.** No `LlmProvider`,
  `ImageGenerationProvider`, `TextToSpeechProvider` or `PaymentProvider` — not
  even stub implementations. `packages/ai` and `packages/commerce` stay empty.
  The single exception is `EmailProvider`, which exists in dev-mode delivery
  only because the auth flow depends on it.
- **Real email delivery.** No transactional email provider is chosen, wired or
  credentialed. §7.5's provider decision stays open until P8.
- **Deployment and hosting.** No cloud provisioning, no object storage, no CDN,
  no environments beyond local Docker Compose and the CI runner.
- **Seed and demo content.** No sample categories, courses, chapters or lessons.
  The only fixtures are the users the verification suite needs. §12 places seed
  data in P10.
- **Everything phases P1–P10 own.** No curriculum import or dry-run (P1), no
  markdown editor or block parser (P2), no image generation (P3), no narration
  script (P4), no audio or ffmpeg (P5), no publish checklist or snapshot (P6),
  no catalog or progress (P7), no products, checkout, webhooks, grants or
  entitlement resolution (P8), no topic requests (P9), no cost dashboard (P10).
  Their tables exist; no code reads or writes them.
- **`ffmpeg` in the worker image.** Declared in §11 but needed first in P5.
- **BullMQ queues and job processing.** `apps/worker` boots and connects to
  Redis; it registers no queue and processes no job type from §8.1.

## Constraints

- **The §8 schema is locked. Reproduce it, do not redesign it.** Column names
  stay `snake_case`; API and JSON field names stay `camelCase` (§9.1). Where
  Prisma's schema language cannot express a §8 construct, the migration carries
  raw SQL rather than a weakened approximation. This applies to at least: the
  six partial unique indexes (`idx_chapters_order`, `idx_lessons_order`,
  `idx_products_single_course`, `idx_products_category_bundle`,
  `idx_access_grants_course`, `idx_access_grants_category`), the partial index
  `idx_access_grants_expiry`, and the two `CHECK` constraints — one on
  `products`, one on `access_grants` — each enforcing that exactly one of a
  pair of nullable foreign keys is set.
- **Soft deletes.** `chapters`, `lessons` and any table with `deleted_at` are
  never hard-deleted. Uniqueness on ordering columns is enforced only
  `WHERE deleted_at IS NULL`, exactly as §8 writes it.
- **Role is read from the session on every request, never from client input**
  (FR-AUTH-02). No role claim in a cookie, header or token body is trusted.
- **Deny by default.** An endpoint that fails to declare a required role must
  reject every caller, so that forgetting a declaration fails closed.
- **TypeScript with `strict: true`** across every workspace. A shared base
  `tsconfig.json` lives in `packages/shared`; each workspace extends it.
- **Prompt and enum values are single-sourced.** Enum members live in
  `packages/shared` zod schemas and are imported everywhere; no workspace
  redeclares a literal union from §8.1.
- **Versions, confirmed 2026-09-12** — the product spec is silent on all
  three: Node 22 LTS (pinned in root `engines` and `.nvmrc`), PostgreSQL 16
  (`gen_random_uuid()` requires 13+), Redis 7.
- **No secret is committed.** `.env.example` is tracked; `.env` is ignored. The
  Auth.js secret and database URL are read from the environment.
- NFR-07 (structured job logging), NFR-09 (viewport support) and the remaining
  NFRs bind later phases; P0 introduces nothing they apply to.

## Affected files and interfaces

Every path below is created by P0. Nothing outside `specs/` and
`.claude/harness/` exists in the repository today.

```
package.json                      workspaces root, packageManager, engines, scripts
pnpm-workspace.yaml               apps/* and packages/*
pnpm-lock.yaml                    committed
turbo.json                        build, typecheck, lint, test task graph
docker-compose.yml                postgres:16, redis:7, healthchecks, volumes
.env.example                      DATABASE_URL, AUTH_SECRET, AUTH_URL
.nvmrc                            22
.gitignore                        .env, node_modules, .turbo, dist, .next
.github/workflows/ci.yml          install, migrate, typecheck, lint, test

packages/shared/
  tsconfig.base.json              strict TypeScript, extended by every workspace
  src/enums.ts                    zod schemas for the 16 columns in §8.1
  src/roles.ts                    UserRole, and the §3 permission matrix as data
  src/errors.ts                   machine-readable errorCode constants

packages/database/
  prisma/schema.prisma            all 18 tables from §8
  prisma/migrations/<ts>_init/    generated SQL plus hand-written raw SQL for
                                  partial unique indexes and CHECK constraints
  src/client.ts                   PrismaClient singleton export

apps/api/
  src/main.ts                     NestJS bootstrap
  src/auth/session.guard.ts       loads session row, resolves current role
  src/auth/roles.decorator.ts     declares required role per endpoint
  src/auth/roles.guard.ts         deny-by-default enforcement, emits errorCode
  src/auth/published-lock.guard.ts  rule R-01
  src/auth/assignment.guard.ts    rule R-02
  src/admins/admins.controller.ts POST /admins, PATCH /admins/:userId
  src/email/email.provider.ts     EmailProvider interface
  src/email/log-email.provider.ts dev-mode implementation, logs the link
  test/rbac.e2e-spec.ts           HTTP matrix over a live app and database

apps/admin-web/                   Next.js shell, Auth.js route handler, sign-in page
apps/learner-web/                 Next.js shell, boots only
apps/worker/                      NestJS bootstrap, Redis connection, no queues
packages/content/  packages/ai/  packages/commerce/
                                  manifest, tsconfig, empty src/index.ts
```

**Interfaces introduced**

- `EmailProvider` — `sendSignInLink(emailAddress: string, url: string): Promise<void>`.
  The only P0 implementation logs. P8 replaces it without touching callers.
- `SessionContext` — `{ userId, userRole, isActive }`, produced by
  `session.guard.ts` from the database on every request and the sole source of
  identity for downstream guards.
- The §3 permission matrix exported as data from `packages/shared/src/roles.ts`,
  so the policy unit tests and the guards read the same table rather than
  restating it.

## End-to-end verification

From a clean checkout, with Docker running:

```
docker compose up -d --wait
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm test
```

**Expected:** exit code `0`, with two suites reporting all green.

**1. Policy unit tests** (`packages/shared`) — no database, no HTTP. The suite
iterates the §3 permission matrix and asserts one case per cell: 16 actions ×
3 roles = 48 assertions. Adding a row to the matrix without implementing it
fails the suite.

**2. RBAC integration test** (`apps/api/test/rbac.e2e-spec.ts`) — boots the
Nest application against the migrated database, seeds one `admin_owner`, two
`admin` accounts and one `learner`, then asserts over real HTTP:

| Scenario | Expected |
|---|---|
| Owner creates an admin account | `201`, sign-in link present in the log |
| Reusing that sign-in link | rejected; first use succeeded |
| Admin creates an admin account | `403` + `errorCode` |
| Learner calls any `/api/admin/*` route | `403` + `errorCode` |
| Unauthenticated call to `/api/admin/*` | `401`, not `403` |
| Admin edits a chapter in a `draft` course with no assignment | `200` |
| Admin edits a chapter assigned to the other admin | `403` (R-02) |
| Admin edits a lesson in a `published` course | `403` (R-01) |
| Owner edits a lesson in a `published` course | `200` |
| Admin disabled, then repeats a previously-allowed call | `403`, same process |
| Any call with `userRole: 'admin_owner'` injected in body and query | identical to the same call without it |

**3. Guard-binding check.** Temporarily returning `true` from
`published-lock.guard.ts` must make the R-01 row fail, and removing the
`@Roles` decorator from `POST /admins` must make that endpoint's row fail
rather than silently pass. This proves the suite binds to the enforcement code
instead of passing vacuously. Record the result in the PR description; do not
commit the mutation.

**4. CI.** The same four commands run in `.github/workflows/ci.yml` against a
PostgreSQL service container, and the job is green on the branch that
implements P0.

## Open questions

None. Both items raised at draft time were resolved on 2026-09-12 and are
recorded here rather than dropped:

- **Version choices — resolved.** Node 22 LTS, PostgreSQL 16 and Redis 7 are
  confirmed, and now appear as a constraint above rather than a question.
- **No git remote — resolved as an accepted limitation.** The repository was
  initialized locally on 2026-09-12 with no remote, so
  `.github/workflows/ci.yml` is authored and committed as part of P0, but
  verification step 4 cannot be observed until the repository is pushed. This
  is accepted: it blocks neither implementation nor verification steps 1–3, and
  step 4 runs on the first push.

The four open decisions in product-spec §14 — payment gateway, grace period
length, free-preview lesson count, and TTS SSML support — do not affect P0.
Their tables (`products`, `access_grants`, `payment_orders`, `lesson_audios`,
`audio_segments`) are created by the initial migration with the defaults §8
specifies, and no P0 code reads them.
