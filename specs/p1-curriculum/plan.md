# Plan: p1-curriculum

**Spec:** specs/p1-curriculum/spec.md
**Status:** Approved
**Date:** 2026-09-12

## Objective

Populate the curriculum tree: give the owner an import path from a §9.1 JSON
outline to categories, courses, chapters and lessons in the database, give
admins CRUD and reordering over that tree, and build the background-job
substrate — BullMQ, the `generation_jobs` lifecycle, SSE progress — that P3
through P6 inherit.

## Approach

### Ordering: one thin vertical slice first, then thicken

Tasks 1–5 are pure functions with no infrastructure: the schema, slug
derivation and the diff engine, all unit-tested without a database. Tasks 6–10
then carry **one** capability — the dry run — all the way from the queue to a
rendered preview in the browser. That is the first task at which a human can
watch the feature work, and it lands before commit, CRUD or the tree exist.
Everything after it thickens a path that is already proven end to end, rather
than integrating three horizontal layers at the end and discovering the seams
then.

### The diff engine is a pure function, and that is load-bearing

`packages/content/src/diff.ts` exports
`buildImportPlan(existing: ExistingTree, payload: ImportPayload): ImportPlan`.
It takes a plain snapshot — arrays of chapters and lessons with their ids,
orders, `contentStatus`, `deletedAt` and a `hasDraftContent` boolean — never a
Prisma client, never a transaction handle.

This is what makes the spec's central guarantee testable. The dry run loads a
snapshot and reports the plan; the commit worker loads a snapshot **inside its
transaction** and applies the plan. Because both call the same pure function,
a preview that disagrees with what commit does is impossible by construction
rather than by discipline, and the whole conflict/removal matrix is exercised
in `packages/content/test/diff.spec.ts` with no database at all — fast, and
covering cases that are tedious to set up over HTTP.

The commit re-runs `buildImportPlan` rather than trusting the dry run's output.
The gate is client-side, the database may have changed in between, and the
function is cheap.

### Reordering: a two-phase write, because deferral is not available

The spec left the mechanism open — "deferring the constraint within the
transaction, or a two-phase write through a disjoint range." **Deferral is not
possible here**, and the plan commits to the two-phase write.

`idx_chapters_order` and `idx_lessons_order` are declared in the initial
migration as `CREATE UNIQUE INDEX ... WHERE deleted_at IS NULL` (verified at
`packages/database/prisma/migrations/20260911180121_init/migration.sql:502`
and `:505`). PostgreSQL can defer a unique *constraint* declared `DEFERRABLE`;
it cannot defer a unique *index*, which is checked per-row on write. Making
them deferrable would mean editing that migration — which
`.claude/harness/conventions.md` records as critical invariant #1, never to be
regenerated, because the hand-written SQL below its generated section would be
lost.

So `structure.service.ts` rewrites order in two `UPDATE` passes inside one
transaction:

1. Set every affected row's order column to `-(targetIndex + 1)`.
2. Set every affected row's order column to `targetIndex + 1`.

Negatives cannot collide with the positives held by untouched rows, and are
unique among themselves; pass 2 then writes into a range no row occupies.
§8 places no `CHECK` on `chapter_order` or `lesson_order`, so the transient
negative values are legal. A full reversal of five chapters is the test that
proves it.

### `job_status` is a P1 decision, not a §8.1 transcription

`packages/shared/test/enums.spec.ts` deliberately transcribes §8.1 by hand so
that comparing the module against itself asserts nothing, and it asserts that
`enumColumns` has *exactly* the §8.1 keys and a length of 16. `job_status` is
not in §8.1 — the spec decides it.

Adding it to the `specifiedIn_8_1` table would make that table a lie. Instead
the test grows a second, separately-labelled table:

```ts
/** Not in §8.1. Decided by specs/p1-curriculum/spec.md; see its Open questions. */
const decidedInP1: Record<string, readonly string[]> = {
  job_status: ['queued', 'running', 'succeeded', 'failed'],
};
```

Coverage asserts over the union; the length assertion becomes 17 columns
across §8.1's 15 rows plus P1's one. Provenance stays visible in the diff, and
a future reader can tell which members the product spec fixed and which this
phase chose.

### Job lifecycle: the enqueue transaction, and a dry run that touches no SQL

**Commit.** `POST /courses/import` validates synchronously, then runs one
`prisma.$transaction` containing the category upsert and the `generation_jobs`
insert, and enqueues to BullMQ **after** that transaction commits. Enqueueing
inside the transaction risks the worker picking the job up and finding no row.
If the enqueue then throws, the endpoint marks the row `failed` with an error
message rather than leaving it `queued` forever.

**Dry run.** No `generation_jobs` row at all. BullMQ holds the job in Redis and
the processor writes its `ImportPlan` to `import:dryrun:<jobId>` with a
1-hour TTL, so the result outlives BullMQ's own completed-job retention and the
"subscribing to a finished job returns its terminal event" criterion holds.

`job-lifecycle.service.ts` owns every `generation_jobs` transition and is the
only writer of that table, so `queued → running → succeeded | failed` cannot be
violated from three places. It also emits the NFR-07 structured log line with
`jobType`, `targetEntityId` and `attemptCount`.

### SSE by snapshot polling, not a queue event bus

`GET /admin/jobs/:jobId/stream` uses Nest's `@Sse()` returning an
`Observable<MessageEvent>` — rxjs is already a dependency of `apps/api`. The
observable polls `JobStatusService.snapshot(jobId)` on a short interval,
emits on change, and completes on `succeeded` or `failed` with the full result
attached.

BullMQ's `QueueEvents` would be more elegant, but it needs a second Redis
subscriber connection per API process and introduces event-ordering questions
that matter more at P3's concurrency than at P1's. Polling a snapshot is
correct in every case including "the job finished before you subscribed", which
is the case the spec explicitly requires and the one an event bus handles worst.

### The browser reaches the API directly, over CORS

`apps/admin-web` runs on :3000 and `apps/api` on :3001. Today `main.ts`
configures no CORS at all, so every browser call would fail.

`main.ts` gains `app.enableCors({ origin: AUTH_URL, credentials: true })`.
Cookies ignore port, so the `authjs.session-token` cookie set for `localhost`
is already sent to :3001; CORS must echo the specific origin rather than `*`
for credentialed requests, and `EventSource` must be constructed with
`withCredentials: true`.

The alternative — proxying through Next route handlers — avoids CORS but makes
the admin app re-implement every endpoint as a passthrough, and streaming SSE
through such a proxy is fiddly. One line of CORS is the smaller change.

### Field-level authorization is a guard, not a handler check

`assignedAdminId` is owner-only on routes admins may otherwise call, which
route-level `@RequirePermission` cannot express. A `@OwnerOnlyFields(...)`
decorator plus `OwnerFieldGuard` reading that metadata against `request.body`
matches the codebase's existing decorator+guard idiom, and — because guards run
before the handler — automatically satisfies the spec's requirement that a
mixed `{title, assignedAdminId}` request from an admin writes *neither* field.

### Two spec claims corrected against the repository

The spec's affected-files list says P1 adds `REDIS_URL` to `.env.example` and a
Redis service container to CI. **Both already exist** — `.env.example:8` and
`.github/workflows/ci.yml` already declare the Redis 7 service and the
`REDIS_URL` env var, added by P0 so the worker could prove its connection.
CI therefore needs only the Playwright step.

## Affected files

| File | Change |
|---|---|
| `packages/shared/src/enums.ts` | Add `jobStatuses`, `jobStatusSchema`, `JobStatus`; add `job_status` to `enumColumns` (16 → 17 keys) |
| `packages/shared/src/errors.ts` | Add `FORBIDDEN_OWNER_ONLY_FIELD`, `IMPORT_SCHEMA_VERSION_MISMATCH`, `IMPORT_PAYLOAD_INVALID`, `STRUCTURE_MISMATCH`, `JOB_NOT_FOUND` |
| `packages/shared/test/enums.spec.ts` | Second `decidedInP1` table; union coverage; length 16 → 17 |
| `docs/import-schema.json` | **New.** §9.1 as JSON Schema, with `schemaVersion` |
| `docs/owner-prompt-template.md` | **New.** FR-IMP-03 template declaring the same `schemaVersion` |
| `packages/content/package.json` | Add `zod`, `vitest`, a `test` script (it has only `typecheck` today) |
| `packages/content/src/import-schema.ts` | **New.** zod schema + `SCHEMA_VERSION` |
| `packages/content/src/slug.ts` | **New.** `slugify`, `deriveCourseSlug` |
| `packages/content/src/diff.ts` | **New.** `ExistingTree`, `ImportPlan`, `buildImportPlan` — pure |
| `packages/content/src/index.ts` | Barrel re-exports |
| `packages/content/test/{schema-parity,slug,diff}.spec.ts` | **New.** |
| `apps/api/src/main.ts` | `enableCors({ origin: AUTH_URL, credentials: true })` |
| `apps/api/src/jobs/import.queue.ts` | **New.** BullMQ producer; queue name and connection |
| `apps/api/src/jobs/job-lifecycle.service.ts` | **New.** sole writer of `generation_jobs`; NFR-07 logging |
| `apps/api/src/jobs/job-status.service.ts` | **New.** `JobSnapshot` from Redis (dry run) or Redis + row (commit) |
| `apps/api/src/jobs/jobs.controller.ts` | **New.** `@Sse()` `GET /admin/jobs/:jobId/stream` |
| `apps/api/src/content/import.controller.ts` | **New.** dry-run, commit, template and schema downloads |
| `apps/api/src/content/categories.controller.ts` | **New.** `POST /categories` |
| `apps/api/src/content/courses.controller.ts` | **New.** `PATCH /:courseId/pricing-type`, `PATCH /:courseId/structure` |
| `apps/api/src/content/structure.service.ts` | **New.** two-phase order rewrite |
| `apps/api/src/content/chapters.controller.ts` | Add `POST`, `DELETE`; `PATCH` gains `description`, `assignedAdminId` |
| `apps/api/src/content/lessons.controller.ts` | Add `POST`, `DELETE`, `GET /my-assignments`; `PATCH` gains the §8 lesson fields and `assignedAdminId` |
| `apps/api/src/auth/owner-field.guard.ts` | **New.** `@OwnerOnlyFields` + guard |
| `apps/api/src/auth/target-resolver.ts` | Resolve targets for the new routes (`courseId`, body-carried ids) |
| `apps/api/src/app.module.ts` | Register the new controllers and providers |
| `apps/api/package.json` | Add `bullmq`, `ioredis` |
| `apps/worker/src/main.ts` | Long-lived process; drop the ping-and-exit and the "lands in P3" log |
| `apps/worker/src/worker.module.ts` | Register the import queue and its processors |
| `apps/worker/src/jobs/dry-run.processor.ts` | **New.** snapshot → `buildImportPlan` → Redis result, no SQL writes |
| `apps/worker/src/jobs/import.processor.ts` | **New.** apply the plan in one transaction |
| `apps/worker/package.json` | Add `bullmq`, `@knowledge-explorer/{content,database}`, `vitest`, a `test` script |
| `apps/admin-web/app/(portal)/layout.tsx` | **New.** authenticated shell + nav |
| `apps/admin-web/app/(portal)/import/page.tsx` | **New.** template download, payload, dry run, preview, gated commit |
| `apps/admin-web/app/(portal)/courses/[courseId]/page.tsx` | **New.** curriculum tree |
| `apps/admin-web/components/{job-progress,curriculum-tree}.tsx` | **New.** |
| `apps/admin-web/next.config.ts` | Add `@knowledge-explorer/content` to `transpilePackages` |
| `apps/admin-web/package.json` | Add `@playwright/test`, a `test:e2e` script (kept out of `test`) |
| `apps/admin-web/playwright.config.ts` | **New.** `webServer` starting api, worker and admin-web |
| `apps/admin-web/e2e/import.spec.ts` | **New.** the spec's 9-step browser scenario |
| `apps/api/test/{import,structure,assignment}.e2e-spec.ts` | **New.** |
| `apps/api/test/rbac.e2e-spec.ts` | Rows for every new route |
| `.github/workflows/ci.yml` | Add the Playwright step (Redis and `REDIS_URL` already present) |

No migration. No change to `schema.prisma`. No change to
`packages/database/prisma/migrations/`.

## Risks

- **Regenerating the initial migration destroys the hand-written SQL.** P1 adds
  no migration, so the only way this happens is an implementer running
  `prisma migrate dev` out of habit. *Mitigation:* P1 touches neither
  `schema.prisma` nor `prisma/migrations/`; `constraints.spec.ts` already fails
  loudly if the partial indexes vanish, and the reorder task depends on them
  existing.

- **The two-phase reorder is the highest-risk code in the phase.** A sequential
  rewrite passes a three-item shuffle and fails a reversal, so a weak test
  hides the bug. *Mitigation:* the "done when" for that task is specifically a
  full five-item reversal plus a cross-chapter lesson move, and the binding
  check mutates the service to a naive rewrite and requires that row to go red.

- **The dry run silently starts writing.** A refactor that shares code with the
  commit processor could introduce a write that nobody notices, because the
  preview still looks right. *Mitigation:* the assertion is a full row-count
  comparison across every curriculum table *and* `generation_jobs`, before and
  after — not an inspection of the code path.

- **Preview and commit drift apart.** The failure the diff engine exists to
  prevent. *Mitigation:* one pure function, both callers; the commit re-runs it
  rather than consuming the dry run's output; `diff.spec.ts` is the shared
  contract test.

- **Playwright is new infrastructure and the most likely task to overrun.** It
  needs browsers installed, three processes running, and a magic-link sign-in
  automated. *Mitigation:* it is task 22 of 23, so nothing depends on it; it is
  scoped to one scenario; and `playwright.config.ts` uses `webServer` so the
  suite owns process lifecycle rather than the developer. If it overruns, every
  other verification step still stands on its own.

- **A job enqueued but never picked up.** If BullMQ's `add` fails after the
  transaction commits, a `generation_jobs` row would sit at `queued` forever.
  *Mitigation:* the endpoint catches the failure and marks the row `failed`;
  import is idempotent, so the owner simply re-imports.

- **CORS and cookies across ports.** Credentialed CORS plus `EventSource`
  `withCredentials` is easy to get subtly wrong and fails only in a real
  browser, which the integration suites do not use. *Mitigation:* the first
  browser-visible task (10) exercises it, well before the tree UI depends on it.

- **`enums.spec.ts` gets falsified rather than extended.** The path of least
  resistance when the length assertion breaks is to add `job_status` to the
  §8.1 table. *Mitigation:* the approach above specifies the two-table shape,
  and task 1's "done when" names it.

## Test strategy

**Unit, no database, no HTTP** — `packages/content` and `packages/shared`:
`schema-parity.spec.ts` (zod schema ≡ `docs/import-schema.json`, and the
template declares the same `schemaVersion`), `slug.spec.ts` (derivation stable,
title-independent), `diff.spec.ts` (table-driven across first import, renames,
reorders, empty-lesson removal, draft-content conflict, chapter removability,
`levelOrder` collision), `enums.spec.ts` (17 columns, `job_status` sourced to
P1).

**Integration over real HTTP, real Postgres, real Redis, real worker** —
`apps/api/test/`: `import.e2e-spec.ts` (the spec's 19-row table, including the
no-writes row-count assertion, the retry-to-3-attempts row and the
already-finished-job subscription), `structure.e2e-spec.ts` (the 10-row table,
including the five-chapter reversal and the R-01/R-02 rows), and
`assignment.e2e-spec.ts` (the 6-row table, including the mixed-field 403 that
must write neither field). `rbac.e2e-spec.ts` grows a row per new route.

**Browser** — `apps/admin-web/e2e/import.spec.ts` runs the spec's nine steps,
of which step 8 is the one no other suite can make: asserting that a drag
produces **exactly one** `PATCH .../structure` request.

**Binding check** — the four mutations the spec lists, each required to turn a
named row red: neutering `owner-field.guard.ts`, removing `@RequirePermission`
from `POST /courses/import`, making the diff engine ignore draft content, and
replacing the two-phase reorder with a sequential rewrite. Results go in the PR
description; the mutations are not committed.

**Execution** — the spec's command sequence, unchanged except that Playwright
runs separately so `turbo run test` stays browser-free:

```
docker compose up -d --wait
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm test
pnpm --filter @knowledge-explorer/admin-web exec playwright test
```

## Out of scope

The spec's non-goals stand in full: lesson body content and the markdown editor
(P2); block parsing, figure/table numbering and the §6.5 checksum chain (P2);
images, narration and audio, and any of the three AI provider interfaces (P3–P5);
the publish checklist, snapshot and `published_course_structures` (P6); the
learner app and anything reading the published track (P7); products, checkout,
grants and entitlement (P8); `is_free_preview`; category editing and deletion;
course deletion and `publicationStatus` transitions beyond `draft`; a generic
job framework, registry or dashboard; bulk assignment; import rollback or
history; real email; deployment, object storage and CDN.

Added during planning:

- **No linter.** `turbo run lint` still matches no package script. P1 introduces
  a lot of new code and the temptation to adopt ESLint with it is real; the
  harness records linter choice as an open tooling question and it is not P1's
  to settle.
- **No change to `apps/learner-web`.** It stays the P0 shell.
- **No styling system.** `apps/admin-web` has no Tailwind, no component library
  and two unstyled pages. P1's screens stay plain and functional; choosing a
  design system is not in the spec and would quietly become the largest task
  in the phase.
- **No `GET /courses/:courseId/stream`.** §9.3 lists it; the job-scoped stream
  covers P1's single job type, and P3 builds it when there is a second producer.
- **No reconciliation for orphaned `queued` rows.** The enqueue-failure path
  marks the row `failed` inline; a sweeper for rows stranded by a process crash
  is P10's operations work.
