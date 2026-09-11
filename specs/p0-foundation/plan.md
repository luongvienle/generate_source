# Plan: p0-foundation

**Spec:** specs/p0-foundation/spec.md
**Status:** Approved
**Date:** 2026-09-12

## Objective

Build the substrate every later phase depends on — a linked pnpm/Turborepo
monorepo, PostgreSQL carrying the complete §8 schema, Auth.js magic-link
sign-in with database sessions, and deny-by-default role enforcement proven by
an automated test of the §3 permission matrix including rules R-01 and R-02.

## Approach

**Impact analysis found nothing to integrate with.** The harness records
`source_files=0` [verified]; `architecture.md` states no pattern is implemented
because no code exists. There is no module to modify, no boundary that must not
be crossed, and no existing code to reuse. Every file in this plan is new, so
the risk is not regression — it is transcription error in the schema and
mis-wired authorization.

**Schema first, then vertical slices.** The skill prefers vertical slices, and
this plan deviates for tasks 1–7 for a stated reason: the migration carries
hand-written raw SQL for six partial unique indexes and two CHECK constraints
that Prisma's schema language cannot express. Regenerating the initial
migration would discard that SQL, so incremental "users table now, rest later"
slicing would either destroy hand-written DDL repeatedly or force multiple
migrations, which the spec's acceptance criteria forbid. The schema is also a
pure transcription of a locked specification with zero design risk, so
front-loading it costs little. From task 8 onward every task is a true vertical
slice: it lands code plus the test that proves it, and the first demonstrable
end-to-end behavior — request a sign-in link, consume it, get a session row —
arrives at task 10 of 17 rather than at the end.

**Authorization is layered in one direction.** `session.guard` resolves
identity from the database and nothing downstream may re-read it from the
request. `roles.guard` then enforces the declared role, and only after it
passes do `published-lock.guard` (R-01) and `assignment.guard` (R-02) apply
their narrower conditions. Each guard lands with its own test rather than all
four arriving together, so a failure names the layer that broke.

**The §3 matrix is data, not prose.** It is exported from
`packages/shared/src/roles.ts` and read by both the policy unit suite and the
guards, so the table cannot drift from enforcement. Because a shared table can
make tests pass vacuously, task 15 deliberately breaks two guards and confirms
the suite goes red.

## Affected files

| File | Change |
|---|---|
| `package.json` | New. Workspace root: `packageManager: pnpm@<pinned>`, `engines.node: 22`, scripts `db:migrate`, `db:generate`, `test`, `verify` |
| `pnpm-workspace.yaml` | New. `apps/*` and `packages/*` |
| `pnpm-lock.yaml` | New, committed, so CI installs with `--frozen-lockfile` |
| `turbo.json` | New. Tasks `build`, `typecheck`, `lint`, `test`; `db:generate` declared as a dependency of `typecheck` and `build` so the Prisma client exists before anything compiles |
| `.nvmrc` | New. `22` |
| `.gitignore` | New. `.env`, `node_modules`, `.turbo`, `dist`, `.next` |
| `.env.example` | New. `DATABASE_URL`, `AUTH_SECRET`, `AUTH_URL`. Tracked; `.env` never committed |
| `docker-compose.yml` | New. `postgres:16` and `redis:7`, healthchecks on both, named volume for Postgres |
| `.github/workflows/ci.yml` | New. Install, migrate against a Postgres service container, `turbo run typecheck lint test` |
| `packages/shared/package.json` | New. `@knowledge-explorer/shared`, depends on `zod` |
| `packages/shared/tsconfig.base.json` | New. `strict: true`; every workspace extends it |
| `packages/shared/src/enums.ts` | New. zod schema per §8.1 — 16 columns across 15 rows, including reserved `snapshot_at_purchase` and `auto` |
| `packages/shared/src/roles.ts` | New. `UserRole` plus the §3 permission matrix as exported data: 16 actions × 3 roles |
| `packages/shared/src/errors.ts` | New. `errorCode` constants returned with every 403/401 |
| `packages/shared/test/enums.spec.ts` | New. Asserts each enum's members match §8.1 exactly |
| `packages/shared/test/policy.spec.ts` | New. 48 assertions, one per matrix cell |
| `packages/database/package.json` | New. `@knowledge-explorer/database`, depends on `@prisma/client` |
| `packages/database/prisma/schema.prisma` | New. All 18 §8 tables, plus the Auth.js adapter models — see Risk 2. Enum-like columns are `String`; money is `Decimal`; timestamps are `@db.Timestamptz(6)` |
| `packages/database/prisma/migrations/<ts>_init/migration.sql` | New. Generated DDL, then hand-appended raw SQL for the six partial unique indexes and two CHECK constraints |
| `packages/database/src/client.ts` | New. `PrismaClient` singleton export |
| `packages/database/test/constraints.spec.ts` | New. Queries `pg_indexes` and `pg_constraint` to assert each partial index and CHECK exists with its predicate |
| `packages/database/test/schema-fidelity.spec.ts` | New. Reads `information_schema.columns` and asserts every §8 column on `users` is present and unchanged despite the adapter additions |
| `apps/api/package.json` | New. NestJS, depends on `database` and `shared` |
| `apps/api/src/main.ts` | New. Nest bootstrap |
| `apps/api/src/health.controller.ts` | New. `GET /health`, confirms database connectivity |
| `apps/api/src/auth/session.guard.ts` | New. Loads the session row, reads `users.user_role` and `is_active`, builds `SessionContext`. The sole source of identity |
| `apps/api/src/auth/roles.decorator.ts` | New. Declares the required role per endpoint |
| `apps/api/src/auth/roles.guard.ts` | New. Deny-by-default: no declaration means reject everyone. Emits `errorCode` |
| `apps/api/src/auth/published-lock.guard.ts` | New. Rule R-01 |
| `apps/api/src/auth/assignment.guard.ts` | New. Rule R-02 |
| `apps/api/src/admins/admins.controller.ts` | New. `POST /admins`, `PATCH /admins/:userId` |
| `apps/api/src/email/email.provider.ts` | New. `EmailProvider` interface |
| `apps/api/src/email/log-email.provider.ts` | New. Dev-mode implementation; writes the sign-in link to the log |
| `apps/api/test/rbac.e2e-spec.ts` | New. The spec's eleven-row HTTP matrix over a live app and database |
| `apps/admin-web/*` | New. Next.js shell, Auth.js route handler with Prisma adapter and email provider, sign-in page. No other UI |
| `apps/learner-web/*` | New. Next.js shell that boots and serves one page |
| `apps/worker/*` | New. Nest bootstrap, Redis connection, no queues registered |
| `packages/content/`, `packages/ai/`, `packages/commerce/` | New. Manifest, tsconfig, empty `src/index.ts` each |

## Risks

- **Prisma cannot express the constraints §8 requires, and regeneration
  destroys hand-written SQL.** Six partial unique indexes and two CHECK
  constraints must be appended to the generated `migration.sql` by hand. Any
  later `prisma migrate dev` that regenerates the initial migration silently
  drops them, leaving a schema that migrates cleanly and then admits duplicate
  chapter orders and double-active products. *Mitigation:* append the raw SQL
  once (task 6), never regenerate the init migration, and make
  `constraints.spec.ts` assert every partial index and CHECK against the
  Postgres catalogs so a regression fails the suite rather than reaching P8.

- **The locked §8 schema and Auth.js database sessions genuinely collide.**
  `@auth/prisma-adapter` requires `Account`, `Session` and `VerificationToken`
  models that §8 does not specify, and its `User` model requires an
  `emailVerified` field that `users` does not have. The magic-link flow cannot
  work without both. *Mitigation:* keep the deviation strictly additive — three
  new adapter tables, plus one nullable `email_verified TIMESTAMPTZ` column on
  `users` — and map the adapter's `email` and `name` onto the existing
  `email_address` and `display_name` via `@map` rather than renaming anything.
  `schema-fidelity.spec.ts` asserts every §8 column survives unchanged. This
  needs the spec owner's acknowledgement: it adds to §8's `users` table, which
  the product spec calls locked.

- **A shared matrix can make the policy suite pass vacuously.** Guards and
  tests both read `roles.ts`, so a guard that is never invoked still shows
  green. *Mitigation:* task 15 stubs `published-lock.guard` to return `true`
  and strips `@Roles` from `POST /admins`, confirms the suite goes red, then
  reverts. Without this the 48 assertions prove only that the table agrees with
  itself.

- **`emailVerified`-style drift between the two enforcement points.** Auth.js
  in `admin-web` and the guard chain in `api` both make authorization-relevant
  decisions, and only the API is tested here. A disabled admin could retain a
  usable Next.js session while the API correctly rejects them. *Mitigation:*
  treat the API guard chain as the only enforcement point for P0 — consistent
  with R-01's "enforced server-side, not by hiding buttons" — and assert the
  disabled-admin case over HTTP, not through the web app.

- **Turborepo task ordering versus Prisma codegen.** `typecheck` fails on a
  clean checkout if the generated client does not exist yet. *Mitigation:*
  declare `db:generate` as a dependency of `typecheck` and `build` in
  `turbo.json`, and verify from a clean clone with `node_modules` and `.turbo`
  removed.

- **Eighteen tables of hand transcription is the likeliest source of silent
  error.** A wrong `ON DELETE`, a missed default or a dropped index will not
  fail any P0 test. *Mitigation:* `prisma migrate diff --exit-code` must report
  no drift, and review the generated `migration.sql` against §8 line by line as
  an explicit step in task 6 rather than trusting the schema file alone.

- **CI cannot be observed green.** No git remote exists, so `ci.yml` is written
  blind. *Mitigation:* accepted in the spec. Keep the workflow to the same four
  commands the local verification runs, so a local pass is strong evidence, and
  run step 4 on the first push.

## Test strategy

**Unit, no database or HTTP** — `packages/shared`. `enums.spec.ts` asserts each
of the 16 §8.1 columns' member lists. `policy.spec.ts` iterates the exported
§3 matrix and asserts one case per cell: 16 actions × 3 roles = 48 assertions.
Adding a matrix row without a corresponding policy branch fails.

**Schema, database only** — `packages/database`. `constraints.spec.ts` queries
`pg_indexes` and `pg_constraint` for the six partial unique indexes and two
CHECK constraints. `schema-fidelity.spec.ts` reads `information_schema.columns`
and asserts the §8 shape of `users` survived the adapter additions.

**Integration, real HTTP against a migrated database** — `apps/api`.
`rbac.e2e-spec.ts` boots the Nest application, seeds one `admin_owner`, two
`admin` accounts and one `learner`, and asserts all eleven rows of the spec's
verification table, including single-use link consumption, the `401`/`403`
distinction, R-01, R-02, immediate effect of disabling an admin, and that an
injected `userRole` changes nothing.

**Mutation check, run by hand once** — task 15, recorded in the PR description.

**The spec's end-to-end verification executes as:**

```
docker compose up -d --wait
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm test
```

Expected: exit `0`, with the unit, schema and integration suites all green.
`.github/workflows/ci.yml` runs the same four commands.

## Out of scope

Restated from the spec's non-goals: all UI beyond sign-in; all five external
provider integrations except dev-mode `EmailProvider`; real email delivery;
deployment, hosting, object storage and CDN; seed and demo content; everything
phases P1–P10 own, including their tables' read and write paths; `ffmpeg`; and
BullMQ queue registration.

Discovered during planning and also out of scope:

- **Rate limiting on sign-in link requests.** The magic-link endpoint is an
  unauthenticated email-sending path and therefore abusable. It is harmless in
  P0 because delivery only writes to a log, but it must be addressed when a
  real `EmailProvider` lands in P8.
- **Auth.js UI theming and email templates.** The sign-in page is functional
  and unstyled.
- **Session revocation tooling.** Disabling an admin blocks API access as
  required, but no interface lists or clears that user's existing session rows.
- **`GET /health` beyond database connectivity.** No Redis check, no readiness
  or liveness split.
