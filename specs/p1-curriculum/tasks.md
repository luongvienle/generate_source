# Tasks: p1-curriculum

**Plan:** specs/p1-curriculum/plan.md

Ordered. Tasks 1–5 are pure functions with no infrastructure. Tasks 6–10 carry
the dry run all the way to a rendered preview in the browser — **task 10 is the
first demonstrable end-to-end behavior**, and it lands before commit, CRUD or
the tree exist. Everything after it thickens a path already proven end to end.

Tick boxes as tasks complete — this file is the durable progress state, so
update it as you go rather than at the end.

---

## Foundations — pure, no database, no queue

- [x] **Task 1: `job_status` members and the new error codes**
  Add `jobStatuses` / `jobStatusSchema` / `JobStatus` to
  `packages/shared/src/enums.ts` and `job_status` to `enumColumns`. Add
  `FORBIDDEN_OWNER_ONLY_FIELD`, `IMPORT_SCHEMA_VERSION_MISMATCH`,
  `IMPORT_PAYLOAD_INVALID`, `STRUCTURE_MISMATCH` and `JOB_NOT_FOUND` to
  `errors.ts`. Extend `enums.spec.ts` with a **separate** `decidedInP1` table
  rather than adding `job_status` to `specifiedIn_8_1` — §8.1 does not list it.
  - done when: `pnpm --filter @knowledge-explorer/shared test` passes with
    `enumColumns` at 17 keys, `job_status` asserted as exactly
    `['queued','running','succeeded','failed']` from the P1 table, and
    `specifiedIn_8_1` still transcribing only what §8.1 writes.

- [x] **Task 2: Import schema, prompt template, and `packages/content` test wiring**
  Write `docs/import-schema.json` (§9.1 plus a required top-level
  `schemaVersion`) and `docs/owner-prompt-template.md` declaring the same
  version. Add `zod` and `vitest` to `packages/content` with a `test` script —
  it has only `typecheck` today. Write `src/import-schema.ts` exporting the zod
  schema and `SCHEMA_VERSION`, with version checked before field validation and
  errors collected with JSON paths.
  - done when: `pnpm --filter @knowledge-explorer/content test` passes
    `schema-parity.spec.ts`, which asserts the zod schema and the JSON Schema
    describe the same shape and that the template's declared version matches;
    editing either file alone fails the suite. A payload with three bad fields
    yields three errors with paths, and a stale `schemaVersion` yields exactly
    one error naming both versions.

- [x] **Task 3: Course slug derivation**
  `packages/content/src/slug.ts` with `slugify` and
  `deriveCourseSlug(categorySlug, levelLabel)`.
  - done when: `slug.spec.ts` passes, asserting `('japanese','N5') → 'japanese-n5'`,
    that repeated calls agree, that the course title is not an input, and that
    case, spacing and punctuation in `levelLabel` normalise.

- [x] **Task 4: Diff engine — creates, updates and ordering**
  `packages/content/src/diff.ts` exporting `ExistingTree`, `ImportPlan` and
  `buildImportPlan(existing, payload)`. Pure: no Prisma client, no transaction
  handle. This task covers first import, matching an existing course by derived
  slug, in-place title/description/order updates, and `levelOrder` collision
  detection.
  - done when: `diff.spec.ts` passes for first-import-of-a-new-category
    (all `create`, correct counts), identical re-import (zero creates, zero
    updates), renamed chapter and reordered lesson (`update`, ids preserved),
    and a `levelOrder` already held by another course (a `level_order_taken`
    conflict).

- [x] **Task 5: Diff engine — conflicts and removals**
  Extend `buildImportPlan` with the removal rules: a lesson absent from the
  payload is `delete` only when `contentStatus = 'empty'` and it has no draft
  content; one carrying draft content becomes a `lesson_has_draft_content`
  conflict and is never marked deleted; a chapter is `delete` only when every
  lesson under it is removable, otherwise
  `chapter_has_conflicted_lessons`.
  - done when: `diff.spec.ts` covers all four cases plus the mixed case — one
    conflicted lesson and one removable lesson in the same chapter — and
    asserts that conflicts never appear in the `delete` lists.

## First vertical slice — the dry run, queue to browser

- [x] **Task 6: BullMQ wiring, and a worker that stays alive**
  Add `bullmq` to `apps/api` and `apps/worker`. Producer module in
  `apps/api/src/jobs/import.queue.ts`; register the queue in
  `apps/worker/src/worker.module.ts`; rewrite `apps/worker/src/main.ts` to keep
  the context alive with SIGTERM/SIGINT graceful shutdown instead of pinging
  Redis and exiting. Delete the "job processing lands in P3" log line. Add
  `vitest` and a `test` script to `apps/worker`.
  - done when: with `docker compose up -d --wait`, a test enqueues a trivial job
    from the API side and the worker process handles it and acknowledges
    completion; the worker does not exit on its own; Ctrl-C shuts it down
    without an unhandled rejection.

- [x] **Task 7: `generation_jobs` lifecycle**
  `apps/api/src/jobs/job-lifecycle.service.ts` as the **sole** writer of the
  table: create at `queued`, `running` sets `started_at`, `succeeded`/`failed`
  set `finished_at`, `attempt_count` increments per attempt, `error_message` on
  failure. Emits the NFR-07 log line with `jobType`, `targetEntityId`,
  `attemptCount`. Configure the queue for NFR-03: bounded concurrency,
  exponential backoff, 3 attempts.
  - done when: an integration test drives a job that always throws and observes
    the row reach `failed` with `attempt_count = 3` and a non-null
    `error_message`; a job that succeeds passes through `queued → running →
    succeeded` with both timestamps set; no other module writes
    `generation_jobs`.

- [x] **Task 8: Job snapshot and the SSE stream**
  `job-status.service.ts` producing `JobSnapshot` from Redis alone (dry run) or
  Redis plus the `generation_jobs` row (commit). `jobs.controller.ts` exposing
  `@Sse()` `GET /admin/jobs/:jobId/stream`, declaring
  `@RequirePermission('importCurriculumOutline')`, emitting on change and
  completing on a terminal status with the result attached.
  - done when: an integration test subscribes to a running job and receives
    transitions ending in a terminal event carrying the result; subscribing to
    an **already-finished** job within its TTL returns the terminal event
    immediately rather than hanging; an `admin` subscribing gets `403` with an
    `errorCode`; an unauthenticated subscriber gets `401`.

- [x] **Task 9: Dry-run endpoint and processor — and it writes no SQL**
  `POST /api/admin/courses/import/dry-run`: validate synchronously (`422` on
  schema or version failure, before any enqueue), otherwise `202 {jobId}`.
  `apps/worker/src/jobs/dry-run.processor.ts` loads the `ExistingTree` snapshot,
  calls `buildImportPlan`, and writes the result to `import:dryrun:<jobId>` with
  a 1-hour TTL. No `generation_jobs` row is created for a dry run.
  - done when: `import.e2e-spec.ts` asserts a dry run returns the expected
    counts, conflicts, resolved slug and `isPublished` flag — and that row
    counts across **every** curriculum table *and* `generation_jobs` are
    byte-identical before and after; two consecutive dry runs against an
    unchanged database return identical counts; `admin` and `learner` callers
    get `403`.

- [x] **Task 10: CORS, admin portal shell, and the import screen's dry run**
  `enableCors({ origin: AUTH_URL, credentials: true })` in
  `apps/api/src/main.ts`. `app/(portal)/layout.tsx` as the authenticated shell.
  `app/(portal)/import/page.tsx` with the template download, a payload textarea
  or file input, a "Run dry run" action, the preview table
  (create/update/delete/conflict counts with conflicts itemized), and
  `components/job-progress.tsx` subscribing over `EventSource` with
  `withCredentials: true`. Add `@knowledge-explorer/content` to
  `transpilePackages`.
  - done when: **demonstrable end to end** — with Postgres, Redis, API, worker
    and admin-web running, a signed-in owner pastes a valid payload, clicks
    "Run dry run", watches the progress component reach `succeeded`, and reads
    the preview table. A failing job shows its `error_message`, not a spinner.

## Commit

- [x] **Task 11: Commit endpoint — validate, upsert, enqueue**
  `POST /api/admin/courses/import`: validate synchronously, then one
  `prisma.$transaction` containing the category upsert (create when the slug is
  new, update `displayName` when changed, never overwrite fields the payload
  omits) and the `generation_jobs` insert with
  `job_type = 'import_course_outline'` and `target_entity_id` = the category id.
  Enqueue **after** the transaction commits; if the enqueue throws, mark the row
  `failed`.
  - done when: a commit returns `202 {jobId}`; the `generation_jobs` row carries
    the right `job_type` and a `target_entity_id` equal to the category's id; a
    forced enqueue failure leaves the row `failed`, not `queued`; validation
    failure returns `422` and creates neither a category nor a job row.

- [x] **Task 12: Commit processor — apply creates and updates**
  `apps/worker/src/jobs/import.processor.ts`: load the snapshot inside one
  PostgreSQL transaction, call `buildImportPlan` (re-diffing, never trusting the
  dry run), and apply creates and updates. New lessons get
  `contentStatus = 'empty'` and no `lesson_contents` row. Set
  `courses.imported_by_user_id` and the derived slug.
  - done when: `import.e2e-spec.ts` shows a first import creating the category,
    course, chapters and lessons with the slug `japanese-n5` and every lesson
    `empty` with no content row; re-importing the identical payload creates no
    duplicates; a renamed chapter and reordered lesson update in place with ids
    unchanged; a processor forced to throw mid-apply leaves the tree exactly as
    it was.

- [x] **Task 13: Commit processor — removals, conflicts, and the published flag**
  Apply the plan's `delete` entries as soft deletes (`deleted_at`), leave
  conflicted rows entirely untouched, return the `conflicts` array in the job
  result, and set `courses.has_unpublished_changes = true` when the target
  course is `published`.
  - done when: re-import omitting an empty lesson sets its `deleted_at` while
    the row survives; re-import omitting a lesson with draft content leaves
    `deleted_at` null and reports it in `conflicts` — **and the rest of that
    same import still applies**; re-importing a `published` course sets
    `has_unpublished_changes`; nothing is ever hard-deleted.

- [x] **Task 14: Import screen — the gated commit**
  Wire the commit action, disabled until a dry run for the payload currently in
  the editor has succeeded, and re-disabled when the payload is edited. Render
  the terminal result: applied counts and the itemized conflicts.
  - done when: in the browser, commit is disabled on load, enabled only after a
    successful dry run, disabled again after a single keystroke in the payload,
    and a completed commit renders its counts and conflicts.

## CRUD, structure and assignment

- [x] **Task 15: Categories and course pricing**
  `categories.controller.ts` with `POST /api/admin/categories` (slug,
  displayName, optional description, coverImageUrl, displayOrder).
  `courses.controller.ts` with `PATCH /api/admin/courses/:courseId/pricing-type`.
  Both owner-only via `@RequirePermission`.
  - done when: an owner creates a category and switches a course between `free`
    and `paid`; an `admin` gets `403` with an `errorCode` on both; a duplicate
    slug returns a clear error rather than a Prisma fault.

- [x] **Task 16: Chapter and lesson CRUD**
  Add `POST` and `DELETE` (soft) to `chapters.controller.ts` and
  `lessons.controller.ts`; widen their `PATCH` bodies to the §8 editable fields.
  Extend `target-resolver.ts` so R-01 and R-02 resolve targets on the new
  routes, including ids carried in the body rather than the path.
  - done when: `structure.e2e-spec.ts` shows create, edit and soft delete on
    both; `DELETE` sets `deleted_at` and leaves the row present; R-01 still
    returns `403` for an `admin` writing to a `published` course on **every**
    new route; R-02 still returns `403` for a row assigned to another admin.

- [x] **Task 17: The structure endpoint and the two-phase reorder**
  `PATCH /api/admin/courses/:courseId/structure` taking the complete ordering
  tree. `structure.service.ts` rewrites order in two `UPDATE` passes inside one
  transaction — negatives first, then finals — because
  `idx_chapters_order` / `idx_lessons_order` are unique **indexes** and cannot
  be deferred. Reject whole (`422`, nothing written) when the payload omits an
  existing non-deleted row, names an unknown id, or names a row from another
  course.
  - done when: a **full reversal of five chapters** succeeds in one request with
    no unique-index violation; a lesson moves between chapters in that same
    request with both chapters left contiguous; each of the three rejection
    cases returns `422` and writes nothing; R-01 and R-02 hold on the route.

- [x] **Task 18: Assignment**
  `@OwnerOnlyFields('assignedAdminId')` plus `owner-field.guard.ts`, added to
  the guard chain on both content controllers. `GET /api/admin/my-assignments`
  returning the caller's assigned lessons with chapter and course context.
  R-02 stays strictly row-level — no inheritance, no change to
  `assignment.guard.ts`.
  - done when: `assignment.e2e-spec.ts` passes all six rows, including the
    mixed `{title, assignedAdminId}` request from an `admin` returning `403`
    with **the title not written either**, and the row asserting that an admin
    may edit an unassigned lesson whose chapter is assigned to someone else.

## Tree UI

- [x] **Task 19: Curriculum tree — list, create, rename, delete**
  `app/(portal)/courses/[courseId]/page.tsx` and
  `components/curriculum-tree.tsx`: render chapters and their lessons in order,
  with create, inline rename and soft delete.
  - done when: in the browser, an imported course's full tree renders in the
    imported order, and a chapter and a lesson can each be created, renamed and
    deleted, with the tree reflecting each change after a reload.

- [x] **Task 20: Curriculum tree — reorder and assignment**
  Drag-to-reorder issuing exactly one `PATCH .../structure` per drop, and an
  assignment control visible to the owner and inoperable for an `admin`.
  - done when: dragging a chapter to a new position sends one request (verified
    in the network panel), the new order survives a reload, and an `admin` sees
    no operable assignment control while the server refuses the write
    regardless.

## Verification

- [x] **Task 21: RBAC matrix rows for every new route**
  Extend `apps/api/test/rbac.e2e-spec.ts` with a row per new endpoint across
  owner, admin, learner and unauthenticated. Leave
  `UndeclaredPolicyFixtureController` exactly as it is — it holds
  deny-by-default under permanent test.
  - done when: `pnpm --filter @knowledge-explorer/api test` passes with every
    new route covered; removing `@RequirePermission` from any new endpoint makes
    its rows fail rather than silently pass.

- [x] **Task 22: Playwright and the browser end-to-end suite**
  Add `@playwright/test` to `apps/admin-web` with a `test:e2e` script kept
  **out** of `test` so `turbo run test` stays browser-free.
  `playwright.config.ts` with a `webServer` block starting api, worker and
  admin-web. `e2e/import.spec.ts` implementing the spec's nine steps.
  - done when: `pnpm --filter @knowledge-explorer/admin-web exec playwright test`
    passes all nine steps from a cold start, including step 8's assertion that a
    drag produces **exactly one** `PATCH .../structure` request.

- [x] **Task 23: Binding check, CI, and the full verification run**
  Run the four mutations from the spec and confirm each turns its named row red:
  neuter `owner-field.guard.ts`; remove `@RequirePermission` from
  `POST /courses/import`; make the diff engine ignore draft content; replace the
  two-phase reorder with a sequential rewrite. Add the Playwright step to
  `.github/workflows/ci.yml` — the Redis service and `REDIS_URL` are already
  there from P0, so no service change is needed.
  - done when: all four mutations fail their rows and none is committed; the
    spec's full command sequence passes from a clean checkout; the results are
    recorded in the PR description.
