# Spec: P1 — Curriculum skeleton

**Status:** Approved
**Date:** 2026-09-12

Derived from `knowledge-explorer-spec.md` §12 phase P1 — *"Categories, courses,
import dry-run and commit, prompt template, chapter and lesson CRUD,
assignment."* That document is the product source of truth and is locked except
§14; this spec adds only the implementation decisions P1 requires and the
product spec does not make. It assumes `specs/p0-foundation/` is delivered:
the §8 schema, Auth.js sessions and the §3 guard chain all exist and are
verified.

## Problem statement

P0 built a substrate that holds no content. The 18 tables from §8 exist and no
code reads or writes them; `courses`, `chapters` and `lessons` are empty, and
the only write endpoints in `apps/api` are the two minimal routes P0 created so
that rules R-01 and R-02 had something real to guard. Nothing can enter the
system. An owner cannot create a category, cannot import an outline, cannot see
a course, and cannot give an admin something to work on — so P2's editor has no
lesson to edit, P3 has no figure block to illustrate, and P6 has no structure to
publish. Every phase from P2 onward is blocked on the same missing thing: a
populated curriculum tree.

P1 delivers it, and in doing so crosses three thresholds the project has not yet
crossed. It is the first phase to write curriculum data, so the draft/published
split of §4.3 becomes real. It is the first phase to run background work, so
BullMQ, the `generation_jobs` lifecycle and server-sent progress all arrive here
rather than in P3 as P0 assumed — `apps/worker/src/main.ts` currently logs *"No
queues registered — job processing lands in P3"*, and P1 makes that line obsolete.
And it is the first phase to build product UI, so the admin portal shell, its
import screen and its curriculum tree are established here for every later phase
to extend.

P1 also closes the first of the three specification gaps `.claude/harness/INDEX.md`
records as blocking later phases: `generation_jobs.job_status` gets its member
list. The second — R-02's scope — is resolved by an explicit decision below. The
third, the payment gateway, is untouched and still owned by P8.

## Acceptance criteria

### Import schema and prompt template

- `docs/import-schema.json` is the machine-readable form of §9.1 and is the only
  definition of the payload shape. The zod schema in `packages/content` is
  generated from it or asserted equal to it by a test — the two can never drift.
- The payload carries a required top-level `schemaVersion` string. A payload
  whose `schemaVersion` does not match the version the server ships is rejected
  with a single clear error naming both versions, before any field-level
  validation runs.
- `docs/owner-prompt-template.md` declares the same `schemaVersion`, and a test
  asserts the two files agree. An owner who pastes a stale template learns that
  in one sentence rather than through a list of field errors.
- `GET /api/admin/import-template` serves the template as a download, and
  `GET /api/admin/import-schema` serves the JSON schema. Both are owner-only
  (FR-IMP-03: *"downloadable from the owner portal"*).
- Validation failure lists **every** error with its JSON path — not the first —
  and writes nothing (FR-IMP-01).

### Dry run

- `POST /api/admin/courses/import/dry-run` accepts a §9.1 payload, validates it
  synchronously, and on success returns `202` with a `jobId`. Schema-level
  failures return `422` before any job is enqueued.
- The dry run makes **no PostgreSQL write of any kind** — not to curriculum
  tables, and not to `generation_jobs`. Its state lives only in BullMQ/Redis and
  its result is cached there under a 1-hour TTL.
- The completed dry run reports, per §5.2 FR-IMP-02, counts of chapters and
  lessons to **create**, **update**, **delete** and **conflict**, plus the
  resolved course slug, whether the category will be created or matched, and
  whether the course is currently `published`.
- Conflicts are itemized, not merely counted: each names the lesson, its
  chapter, and why it conflicts.
- Running a dry run twice in a row against an unchanged database returns
  identical counts.

### Import commit

- `POST /api/admin/courses/import` validates the payload synchronously, then in
  one transaction upserts the category, writes a `generation_jobs` row with
  `job_type = 'import_course_outline'` and `target_entity_id` = that category's
  id, and enqueues the job. It returns `202` with `{ jobId }`.
- The worker applies the whole outline in a single PostgreSQL transaction. A
  failed attempt leaves the curriculum tree exactly as it was.
- Import creates the skeleton only: every new lesson has `contentStatus = 'empty'`
  and no `lesson_contents` row (FR-IMP-01).
- Import is idempotent on `(categorySlug, levelLabel)`. Re-importing updates
  titles, descriptions, ordering and lesson metadata, and creates no duplicate
  row.
- The course slug is derived as `slugify(categorySlug) + '-' + slugify(levelLabel)`
  — `japanese` + `N5` → `japanese-n5`. It is computed the same way on every
  import, so it is stable across re-import and changing the course title never
  changes a learner-facing URL.
- `courses.imported_by_user_id` records the owner who enqueued the commit.

### Re-import: conflicts and removals

- A lesson present in the database but absent from the payload is soft-deleted
  (`deleted_at` set) **only if** it has `contentStatus = 'empty'` and no
  `lesson_contents` row with a non-null `draft_content_markdown`.
- A lesson absent from the payload that **does** carry draft content is left
  entirely untouched — not deleted, not reordered out of existence — and is
  returned in the response's `conflicts` array (FR-IMP-01).
- A chapter absent from the payload is soft-deleted only when every lesson under
  it is itself removable. Otherwise the chapter survives, carrying its
  conflicted lessons, and is reported as a conflict.
- **Commit proceeds when conflicts exist.** It applies every create, update and
  permitted deletion, and reports the conflicts alongside. Import never refuses
  to run because of content the owner already wrote; removing such a lesson is a
  deliberate act through `DELETE /api/admin/lessons/:lessonId`.
- Re-importing a course whose `publicationStatus = 'published'` applies to the
  draft track as normal and sets `courses.has_unpublished_changes = true`.
  Learners continue to see the last published snapshot until P6 publishes again.
- Nothing is ever hard-deleted.

### Background jobs

- `generation_jobs.job_status` has exactly four members: `queued`, `running`,
  `succeeded`, `failed`. This resolves the §8.1 gap. `queued` is §8's declared
  column default; the set is job-lifecycle vocabulary and deliberately distinct
  from the `pending`/`generating`/`ready`/`stale`/`failed` set that
  `script_status` and `audio_status` share, because a job is never *stale*.
- A zod schema for `job_status` lives in `packages/shared/src/enums.ts` beside
  the other 15, and the §8.1 catalogue test covers 16 rows rather than 15.
- Status transitions are `queued → running → succeeded | failed` and no other.
  `started_at` is set on entering `running`, `finished_at` on reaching
  `succeeded` or `failed`, `attempt_count` increments once per attempt, and
  `error_message` is populated on `failed`.
- Per NFR-03 the import queue has bounded concurrency, retries with exponential
  backoff, and stops after 3 attempts. A job exhausting its attempts is
  `failed`, with `attempt_count = 3`.
- Per NFR-07 every job logs structurally with `jobType`, `targetEntityId` and
  `attemptCount`.
- `apps/worker` runs as a long-lived process that registers the import queue and
  processes jobs, rather than pinging Redis and exiting.

### Progress stream

- `GET /api/admin/jobs/:jobId/stream` is a server-sent event stream reporting a
  job's status transitions and progress, per NFR-04. It serves dry-run jobs
  (Redis-only) and commit jobs (Redis plus a `generation_jobs` row) through one
  interface.
- The stream terminates when the job reaches `succeeded` or `failed`, and the
  terminal event carries the full result payload — the preview for a dry run,
  the applied counts and `conflicts` array for a commit.
- Subscribing to a job that has already finished within its TTL immediately
  yields the terminal event rather than hanging.
- The endpoint is owner-only in P1 and declares the §3 action
  `importCurriculumOutline`, because import is the only job type P1 enqueues.

### Categories and courses

- `POST /api/admin/categories` creates a category with `slug`, `displayName`,
  and optionally `description`, `coverImageUrl` and `displayOrder` (§9.2).
- Import upserts the category named in its payload: it creates the category when
  the slug is new, and updates `displayName` when it changed. Fields the payload
  does not carry are never overwritten.
- `PATCH /api/admin/courses/:courseId/pricing-type` switches `free` or `paid`
  (§9.2).

### Chapter and lesson CRUD

- `POST /api/admin/chapters` and `POST /api/admin/lessons` create a row; `PATCH`
  on `/:chapterId` and `/:lessonId` edits its fields; `DELETE` on each sets
  `deleted_at` and never removes the row (§9.3, FR-EDIT-04).
- `PATCH /api/admin/courses/:courseId/structure` takes the complete ordering
  tree — every chapter in order, each with its lessons in order — and rewrites
  it in one transaction. Reordering is one request carrying the full new order,
  never one request per item (FR-EDIT-04). Moving a lesson between chapters is
  expressible in that same single request.
- Applying a new order never transiently violates `idx_chapters_order` or
  `idx_lessons_order`, so any permutation — including a full reversal — succeeds.
- A structure request that omits an existing non-deleted row, names an unknown
  id, or names a row belonging to another course is rejected whole with a `422`
  and writes nothing.

### Assignment

- `assignedAdminId` is accepted on `PATCH /api/admin/chapters/:chapterId` and
  `PATCH /api/admin/lessons/:lessonId`, and that field is **owner-only**: an
  `admin` editing `title` on the same route succeeds, and the same admin setting
  `assignedAdminId` receives `403` with an `errorCode`.
- `GET /api/admin/my-assignments` returns the lessons whose `assigned_admin_id`
  is the caller, with enough chapter and course context to render them (§9.3).
- **R-02 stays strictly row-level.** A lesson with `assigned_admin_id = NULL` is
  unassigned and any admin may edit it, regardless of who is assigned to its
  chapter. There is no inheritance, and `assignment.guard.ts` and
  `target-resolver.ts` are unchanged by P1 except to cover the new routes.

### Admin portal UI

- An authenticated owner reaches an import screen that: downloads the prompt
  template, accepts a pasted or uploaded JSON payload, runs a dry run, renders
  the preview as a table of create/update/delete/conflict counts with the
  conflicts itemized, and keeps the commit action disabled until a dry run for
  the payload currently in the editor has succeeded.
- The commit gate is enforced in the browser only, exactly as FR-IMP-02 words it
  (*"The UI requires a dry run..."*). The API accepts any well-formed commit;
  safety comes from the commit job re-validating and re-diffing from scratch
  rather than trusting a preview.
- Editing the payload after a successful dry run disables commit again.
- Both screens show live job progress from the SSE stream, and a failed job
  surfaces its `error_message` rather than a spinner that never resolves.
- A curriculum tree screen lists a course's chapters and lessons and supports
  create, rename, drag-to-reorder, soft delete, and — for the owner — assigning
  an admin. Reordering issues exactly one `PATCH .../structure` request.
- An `admin` sees the assignment control disabled or absent; the server refuses
  it regardless (the UI never carries the enforcement).
- Per NFR-09 both screens work at 1280 px and wider.

### Role enforcement

- Every new endpoint declares a §3 action through `@RequirePermission`; an
  endpoint without one denies all callers, as P0 established.
- Import, category creation, pricing-type changes and assignment writes are
  owner-only. Chapter and lesson CRUD and the structure endpoint are open to
  `admin_owner` and `admin`.
- R-01 holds on every new write route: an `admin` writing to a chapter, lesson
  or structure belonging to a `published` course gets `403`. Import is exempt in
  practice because only the owner may call it.
- R-02 holds on every new chapter and lesson write route.
- Every `403` carries a machine-readable `errorCode`.

## Non-goals

These are out of scope for P1 and must not appear in its implementation.

- **Lesson body content.** No markdown editor, no preview, no autosave, no block
  parser, no figure or table numbering, no checksums. `lesson_contents` is read
  by the conflict check and written by nothing. All of that is P2.
- **`packages/content` beyond the import schema.** The package gains the import
  schema, the diff engine and slug derivation. It does **not** gain the markdown
  parser, block extraction or the §6.5 checksum chain.
- **Images, narration, audio.** No `ImageGenerationProvider`, `LlmProvider` or
  `TextToSpeechProvider`, not even stubs. `packages/ai` stays empty. No ffmpeg
  in the worker image — §11 declares it, P5 needs it.
- **Publishing.** No checklist, no publish job, no `published_course_structures`
  row, no snapshot, no unpublish, no `submit-review`. P1 sets
  `has_unpublished_changes` and nothing consumes it until P6.
- **The learner app.** `apps/learner-web` stays the P0 shell. No catalog, no
  course page, no reader, no progress. Nothing reads the published track.
- **Commerce.** No products, pricing beyond the `pricing_type` switch, checkout,
  webhooks, grants or entitlement. `packages/commerce` stays empty.
- **`is_free_preview`.** The column exists and P1 never sets it. §14 decision 3
  — how many preview lessons a course gets — is still open and belongs to P7/P8.
- **Category editing and deletion.** §9.2 lists only `POST /categories`. No
  `PATCH`, no `DELETE`, no reordering of categories.
- **Course deletion or archival.** `publicationStatus` transitions beyond
  `draft` are P6's.
- **A generic job framework.** P1 registers one queue for one job type. It does
  not build a job registry, a dashboard, a dead-letter UI, or the broadened
  stream authorization P3 will need.
- **Real email.** Unchanged from P0: `LogEmailProvider` only.
- **Deployment, object storage, CDN.** Still local Docker Compose and the CI
  runner.
- **Bulk assignment.** Assignment is a field on the existing `PATCH` routes. No
  staff-a-whole-course endpoint.
- **Import rollback or history.** No undo, no version log. Re-import is the
  correction mechanism.

## Constraints

- **The §8 schema is locked and P1 adds no migration.** Every table and column
  P1 writes already exists. `job_status` gets a member list in
  `packages/shared`, not a database constraint — §8's decision to validate
  enum-like `TEXT` in the application layer stands.
- **`generation_jobs.target_entity_id` is `UUID NOT NULL`.** For an import
  commit it is the category id, which is why the category upsert shares the
  enqueue transaction. **Accepted consequence:** a commit job that ultimately
  fails leaves a newly-created category behind. The upsert is idempotent and a
  corrected re-import reuses it, so this is preferred over a sentinel id or a
  nullable column the schema does not permit.
- **The dry run writes nothing to PostgreSQL.** This is load-bearing and must be
  asserted, not assumed: the verification suite compares row counts across every
  curriculum table *and* `generation_jobs` before and after.
- **One diff engine, two callers.** The dry run reports the plan and the commit
  worker applies it, from the same pure function over `(existing tree, payload)`.
  A preview that disagrees with what commit does is the failure mode this phase
  most needs to prevent.
- **The commit re-diffs; it never trusts a preview.** The database may change
  between dry run and commit, and the gate is client-side.
- **Soft deletes only.** `deleted_at` is set; rows are never removed. Ordering
  uniqueness applies only `WHERE deleted_at IS NULL`, per §8.
- **The partial unique indexes are the hard part of reordering.**
  `idx_chapters_order` and `idx_lessons_order` are enforced immediately, so a
  naive sequential rewrite collides mid-update. The implementation must avoid
  the transient violation — deferring the constraint within the transaction, or
  a two-phase write through a disjoint range. Whichever is chosen, a full
  reversal must pass.
- **`UNIQUE (category_id, level_order)`** likewise constrains re-import when
  `levelOrder` changes or another course already holds the slot. The dry run
  reports the collision; the commit must not half-apply.
- **Role is read from the session on every request, never from client input**
  (FR-AUTH-02). Unchanged from P0 and re-asserted for the new routes.
- **Deny by default.** An endpoint with no `@RequirePermission` rejects everyone.
- **Field-level authorization is server-side.** `assignedAdminId` being
  owner-only on a route admins may otherwise call cannot be expressed by the
  guard chain's route-level `@RequirePermission` alone, and must be enforced in
  the handler or a dedicated guard — never by omitting the control in the UI.
- **Enum values are single-sourced.** `job_status` members live in
  `packages/shared` and no workspace restates them.
- **Prompt and schema versioning** follows NFR-08's spirit: `schemaVersion` is
  stored in `docs/import-schema.json`, echoed by the template, and required in
  every payload.
- **NFR-04**: no HTTP request waits on the import job. Both import endpoints
  return `202` immediately.
- **NFR-03**: bounded concurrency, exponential backoff, maximum 3 attempts.
- **NFR-09**: the admin editor targets 1280 px and wider.
- **NFR-10** is not yet engaged — P1 stores no lesson body.
- **TypeScript `strict: true`** across every workspace, extending
  `packages/shared/tsconfig.base.json`.
- **No secret is committed.** `REDIS_URL` joins `.env.example`; it already
  defaults to `redis://localhost:6380` in `apps/worker/src/redis.service.ts`.

## Affected files and interfaces

Paths marked **new** do not exist today; the rest are modified.

```
docs/import-schema.json               new  §9.1 as JSON Schema, carries schemaVersion
docs/owner-prompt-template.md         new  FR-IMP-03, declares the same schemaVersion

packages/shared/
  src/enums.ts                             + jobStatus zod schema (the §8.1 gap)
  src/errors.ts                            + errorCodes for import validation,
                                             schema-version mismatch, structure
                                             mismatch, assignment-field denial

packages/content/                     the package P0 left empty
  src/import-schema.ts                new  zod schema, asserted equal to docs/
  src/slug.ts                         new  slugify + deriveCourseSlug
  src/diff.ts                         new  pure (existing tree, payload) -> ImportPlan
  src/index.ts                             re-exports the above
  test/diff.spec.ts                   new  table-driven: creates, updates,
                                             conflicts, removals, published course
  test/slug.spec.ts                   new
  test/schema-parity.spec.ts          new  zod schema === docs/import-schema.json

packages/database/
  src/client.ts                            unchanged; no migration in P1

apps/api/
  src/jobs/import.queue.ts            new  BullMQ producer, enqueue + generation_jobs
  src/jobs/jobs.controller.ts         new  GET /admin/jobs/:jobId/stream (SSE)
  src/jobs/job-status.service.ts      new  reads Redis + generation_jobs, one shape
  src/content/import.controller.ts    new  POST /courses/import/dry-run, /import
                                           GET /import-template, /import-schema
  src/content/categories.controller.ts new POST /categories
  src/content/courses.controller.ts   new  PATCH /:courseId/pricing-type,
                                           PATCH /:courseId/structure
  src/content/chapters.controller.ts       + POST, DELETE; PATCH gains
                                             assignedAdminId (owner-only)
  src/content/lessons.controller.ts        + POST, DELETE, GET /my-assignments;
                                             PATCH gains assignedAdminId
  src/content/structure.service.ts    new  order rewrite without index violation
  src/auth/owner-field.guard.ts       new  field-level owner-only enforcement
  src/auth/target-resolver.ts              + resolve targets for the new routes
  src/app.module.ts                        + the new controllers and providers

apps/worker/
  src/main.ts                              long-lived process; drop the
                                           "job processing lands in P3" exit
  src/worker.module.ts                     + BullMQ registration
  src/jobs/import.processor.ts        new  applies the plan in one transaction
  src/jobs/dry-run.processor.ts       new  computes the plan, writes no SQL
  src/jobs/job-lifecycle.service.ts   new  generation_jobs transitions, NFR-07 logs

apps/admin-web/
  app/(portal)/layout.tsx             new  authenticated portal shell + nav
  app/(portal)/import/page.tsx        new  template download, payload, dry run,
                                           preview table, gated commit
  app/(portal)/courses/[courseId]/page.tsx new curriculum tree
  components/job-progress.tsx         new  SSE subscriber
  components/curriculum-tree.tsx      new  reorder, create, delete, assign
  e2e/import.spec.ts                  new  Playwright: owner imports end to end

apps/api/test/
  import.e2e-spec.ts                  new  dry run, commit, idempotency,
                                           conflicts, removals, published re-import
  structure.e2e-spec.ts               new  reorder, soft delete, R-01, R-02
  assignment.e2e-spec.ts              new  owner-only field, my-assignments
  rbac.e2e-spec.ts                         + rows for every new route

.env.example                               + REDIS_URL
.github/workflows/ci.yml                   + a Redis service container;
                                             + the Playwright run
```

**Interfaces introduced**

- `ImportPlan` — the output of `packages/content/src/diff.ts` and the contract
  between preview and application:
  ```ts
  interface ImportPlan {
    category: { action: 'create' | 'update' | 'unchanged'; slug: string; displayName: string }
    course:   { action: 'create' | 'update'; slug: string; isPublished: boolean }
    chapters: Array<{ action: 'create' | 'update' | 'delete'; chapterOrder: number; title: string; id?: string }>
    lessons:  Array<{ action: 'create' | 'update' | 'delete'; chapterOrder: number; lessonOrder: number; title: string; id?: string }>
    conflicts: Array<{ kind: 'lesson_has_draft_content' | 'chapter_has_conflicted_lessons' | 'level_order_taken'
                       lessonId?: string; chapterId?: string; title: string; reason: string }>
    counts: { chaptersCreated: number; chaptersUpdated: number; chaptersDeleted: number
              lessonsCreated: number; lessonsUpdated: number; lessonsDeleted: number; conflicts: number }
  }
  ```
  It is pure data with no database handle, which is what lets the dry run
  compute it without writing and the worker apply it without recomputing a
  different answer.

- `JobSnapshot` — `{ jobId, jobType, jobStatus, attemptCount, startedAt, finishedAt, errorMessage, result }`,
  produced by `job-status.service.ts` from Redis for dry runs and from Redis
  plus `generation_jobs` for commits, so the SSE endpoint has one shape to emit
  regardless of which kind of job it is watching.

- `CourseStructure` — the request body of `PATCH /courses/:courseId/structure`:
  an ordered array of chapters, each with an ordered array of lesson ids. The
  complete intended order, not a delta.

- `jobStatus` — added to `packages/shared/src/enums.ts`:
  `['queued', 'running', 'succeeded', 'failed']`.

**Deviations from §9.2 and §9.3**

P1 adds three routes the locked API contract does not list, and declines to
build one that it does. These are deliberate; none is an oversight.

| Route | Status | Why |
|---|---|---|
| `GET /admin/import-template` | **added** | FR-IMP-03 requires the template be *"downloadable from the owner portal"* and §9.2 lists no endpoint that serves it |
| `GET /admin/import-schema` | **added** | The schema is versioned alongside the template; serving one without the other leaves the owner unable to check a mismatch |
| `PATCH /courses/:courseId/structure` | **added** | §9.3 assigns reorder to `PATCH /chapters/:id`, which cannot express FR-EDIT-04's *"single request carrying the full new order"*, and has no natural shape for moving a lesson between chapters |
| `GET /admin/jobs/:jobId/stream` | **added** | §9.3's stream is keyed by `courseId`, but a first import has no course until the job commits one |
| `GET /courses/:courseId/stream` | **deferred** | §9.3 lists it; P1's only job type is import, which the job-scoped stream already covers. P3 builds it when per-course job progress has more than one producer |

The §9.2 and §9.3 routes P1 *does* implement keep their paths and methods
exactly as written. Every other route in those tables belongs to a later phase.

## End-to-end verification

From a clean checkout, with Docker running:

```
docker compose up -d --wait
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm test
pnpm --filter @knowledge-explorer/admin-web exec playwright test
```

**Expected:** exit code `0` from both commands, with every suite green.

**1. Unit suites — no database, no HTTP.**

- `packages/content/test/schema-parity.spec.ts` — the zod schema and
  `docs/import-schema.json` describe the same shape, and
  `docs/owner-prompt-template.md` declares the same `schemaVersion`. Editing one
  without the other fails.
- `packages/content/test/slug.spec.ts` — `('japanese', 'N5') → 'japanese-n5'`;
  derivation is stable across repeated calls and unaffected by the course title.
- `packages/content/test/diff.spec.ts` — table-driven over `ImportPlan`:
  first import of a new category; re-import with a renamed chapter; re-import
  that drops an empty lesson (→ `delete`); re-import that drops a lesson with
  draft content (→ `conflict`, no `delete`); a chapter whose lessons are all
  removable (→ `delete`) versus one whose are not (→ `conflict`); a `levelOrder`
  already taken by another course (→ `conflict`).
- `packages/shared/test/enums.spec.ts` — the §8.1 catalogue now covers 16
  columns, including `job_status` with exactly four members.

**2. Import integration suite** (`apps/api/test/import.e2e-spec.ts`) — boots the
API and a real worker against the migrated database and a live Redis, seeds one
`admin_owner`, two `admin` accounts and one `learner`, then asserts:

| Scenario | Expected |
|---|---|
| Owner dry-runs a valid new-category payload | `202` + `jobId`; stream terminates `succeeded` with counts |
| Row counts across all curriculum tables **and** `generation_jobs`, before vs. after that dry run | identical |
| Owner commits the same payload | `202`; job reaches `succeeded`; category, course, chapters and lessons exist |
| Every lesson created by that import | `contentStatus = 'empty'`, no `lesson_contents` row |
| The created course's slug | `japanese-n5`, derived from `(categorySlug, levelLabel)` |
| `generation_jobs` row for the commit | `job_type = 'import_course_outline'`, `target_entity_id` = the category id, `queued → running → succeeded`, `started_at` and `finished_at` set |
| Re-import of the identical payload | no duplicate rows; counts report zero creates |
| Re-import with a renamed chapter and a reordered lesson | titles and order updated in place; ids unchanged |
| Re-import omitting an empty lesson | that lesson's `deleted_at` is set; the row still exists |
| Re-import omitting a lesson that has draft content | lesson untouched, `deleted_at` still null, reported in `conflicts` |
| — and the rest of that same import | applied, not blocked |
| Re-import of a `published` course | applies to the draft track; `has_unpublished_changes = true` |
| Payload with a stale `schemaVersion` | `422` naming both versions; no job enqueued; nothing written |
| Payload with three invalid fields | `422` listing all three with JSON paths; nothing written |
| `admin` calls either import endpoint | `403` + `errorCode` |
| `learner` calls either import endpoint | `403` + `errorCode` |
| Unauthenticated call | `401`, not `403` |
| Commit job forced to throw | retried to `attempt_count = 3`, then `failed` with `error_message`; curriculum tree unchanged from before the attempt |
| Subscribing to an already-finished job within TTL | terminal event immediately, no hang |

**3. Structure and CRUD suite** (`apps/api/test/structure.e2e-spec.ts`):

| Scenario | Expected |
|---|---|
| Owner reverses the order of five chapters in one request | `200`; no unique-index violation; order fully reversed |
| Owner moves a lesson to a different chapter in that same request | `200`; both chapters' orders contiguous |
| Structure request omitting an existing non-deleted lesson | `422`; nothing written |
| Structure request naming a lesson from another course | `422`; nothing written |
| `DELETE /lessons/:id` | `deleted_at` set, row still present, sibling order still valid |
| `admin` reorders a `draft` course with no assignment | `200` |
| `admin` reorders a `published` course | `403` (R-01) |
| Owner reorders a `published` course | `200` |
| `admin` edits a lesson assigned to the other admin | `403` (R-02) |
| `admin` edits an unassigned lesson whose **chapter** is assigned to the other admin | `200` — R-02 is row-level, by decision |

**4. Assignment suite** (`apps/api/test/assignment.e2e-spec.ts`):

| Scenario | Expected |
|---|---|
| Owner sets `assignedAdminId` on a lesson | `200` |
| `admin` sets `title` on that same route | `200` |
| `admin` sets `assignedAdminId` on that same route | `403` + `errorCode` |
| `admin` sets `title` and `assignedAdminId` together | `403`; the title is **not** written either |
| `GET /my-assignments` as the assigned admin | returns that lesson with chapter and course context |
| `GET /my-assignments` as the other admin | does not return it |

**5. Browser end-to-end** (`apps/admin-web/e2e/import.spec.ts`, Playwright —
a new dependency P1 introduces, against a running API, worker, Postgres and
Redis):

1. Sign in as the owner via the dev-mode magic link.
2. Open the import screen; download the prompt template and assert its
   `schemaVersion` matches the server's.
3. Paste a valid payload for a new category. Assert the commit action is
   **disabled**.
4. Run the dry run. Assert the preview table appears with the expected
   create counts, and the commit action becomes **enabled**.
5. Edit one character of the payload. Assert commit is **disabled** again.
6. Restore, re-run the dry run, commit. Assert the progress component shows the
   job reaching `succeeded`.
7. Navigate to the curriculum tree for the new course. Assert every imported
   chapter and lesson is listed in the imported order.
8. Drag the last chapter to the first position. Assert exactly **one** network
   request to `PATCH /courses/:courseId/structure` (not one per item), and that
   reloading the page shows the new order.
9. Sign in as an `admin`. Assert the assignment control is not operable, and
   that a direct `PATCH` with `assignedAdminId` from the browser console returns
   `403`.

**6. Binding check.** As in P0, prove the suites bind to enforcement rather than
passing vacuously. Each mutation below must turn its named row red:

- Returning `true` unconditionally from `owner-field.guard.ts` → the
  `admin` sets `assignedAdminId` row fails.
- Removing `@RequirePermission` from `POST /courses/import` → that endpoint's
  `admin` and `learner` rows fail.
- Making the diff engine treat draft content as absent → the
  lesson-with-draft-content conflict row fails.
- Rewriting chapter order sequentially without the collision avoidance → the
  five-chapter reversal row fails.

Record the results in the PR description; do not commit the mutations.

**7. CI.** `.github/workflows/ci.yml` runs the same commands with both a
PostgreSQL and a Redis service container, plus the Playwright suite, and the job
is green on the branch implementing P1.

## Open questions

None. Fifteen decisions the product spec does not make were resolved during the
interview on 2026-09-12 and are recorded above rather than dropped. The four
that a reader is most likely to want the reasoning for:

- **`generation_jobs.job_status` — resolved as `queued`, `running`, `succeeded`,
  `failed`.** This closes the first of the three specification gaps in
  `.claude/harness/INDEX.md`. §8 defaults the column to `queued`, which rules
  out reusing the `script_status`/`audio_status` set, and `stale` has no meaning
  for a job. `cancelled` was considered and rejected: no endpoint in §9 exposes
  a cancel action, so it would sit unused.
- **R-02 — resolved as strictly row-level, no inheritance.** This closes the
  second harness gap. §3 phrases R-02 as *"courses where they are assigned"*,
  but §8 defines `assigned_admin_id` only on `chapters` and `lessons`. Adding a
  course-level column was rejected because the P0 constraint — reproduce §8, do
  not redesign it — still binds. `assignment.guard.ts` therefore keeps the
  behavior it already documents, and the e2e suite asserts the surprising case
  (an unassigned lesson under an assigned chapter is editable) so the decision
  is visible rather than accidental.
- **BullMQ arrives in P1, not P3.** §8.1 lists `import_course_outline` as a job
  type and NFR-04 requires SSE progress for long-running operations, so import
  is modelled as a real background job. The cost is that P1 owns the queue
  infrastructure, the job lifecycle and the stream that P0's worker comment
  assigned to P3; the benefit is that P3, P4, P5 and P6 inherit all of it built
  and tested against a job that cannot fail for an external-provider reason.
- **The commit gate is client-side.** FR-IMP-02 says *"The UI requires a dry run
  to succeed"* — the requirement is on the UI. Server-side enforcement by
  payload hash or token was considered and rejected as redundant: the commit job
  re-validates and re-diffs from scratch, so a commit that skipped the preview
  is correct, merely unpreviewed.

The two remaining harness-flagged gaps are untouched and correctly so: the
payment gateway (§14 decision 1) blocks P8, and the four §14 open decisions —
gateway, grace period, free-preview count, TTS SSML — none of which P1 reads or
writes.
