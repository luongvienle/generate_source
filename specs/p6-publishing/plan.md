# Plan: P6 — Publishing

**Spec:** specs/p6-publishing/spec.md
**Status:** Approved
**Date:** 2026-09-13

## Objective

Build §4.3's published track — the checklist that gates it, the job that writes
it, the snapshot P7 will read, the edit lock that protects it, and the unpublish
that withdraws it — without a schema migration, and close §4.2's state machine
while doing it.

## Approach

**One service owns the checklist, and it batch-loads.** The spec says the
checklist "calls" the existing staleness derivations at `narration.service.ts:262`
and `audio.service.ts:446`. Those are per-lesson methods that each run several
queries; calling them across a forty-lesson course is roughly two hundred
round-trips for one screen. **The plan refines this: the checklist reuses the
pure functions those methods are built from** — `computeStatus`
(`narration.service.ts:127`, already exported), `computeAudioStatus`
(`audio.service.ts:515`, to be exported) and `narrationStaleness`
(`packages/content/src/narration.ts:209`) — over a course tree loaded in a
handful of queries. The §6.5 rule stays single-sourced in the same three
functions; only the loading changes. Re-deriving the rule inline would be the
thing the spec forbids, and this is not that.

**The transition machine is data, in `packages/shared`.** §4.2's edges go in one
table beside `roles.ts` for the reason §3's matrix is there: an enforcement rule
recorded twice drifts. Six endpoints read it; none of them restates an edge.

**A failed publish restores the status the course held going in.** `publishing`
is a lock, so every path out of it must be defined. Success goes to `published`;
every failure — a checklist that drifted, a write that threw, an enqueue that
never landed — returns the course to its previous status, which travels in the
job payload rather than being re-read or stored in a new column. Without this, a
failed re-publish of a live course would drop it to `draft` and silently withdraw
content learners are reading. §4.2 draws none of these edges; the transition
table names them and says so.

**The publish job follows P5's shape exactly.** Fifth `QueueDefinition` with
`idPrefix: 'publish:'`, a `BaseJobQueue` subclass producer, a worker service
under `withJobLifecycle`. The in-flight lock is
`publication_status = 'publishing'`, taken in the same transaction as the
`generation_jobs` row, with the enqueue outside it and the compensating catch
`audio.service.ts:253` documents. **Nothing about the queue substrate is new
work** — P5's extraction into `queueDefinitions` was built to absorb exactly this.

**Reads happen before the write transaction.** The worker re-evaluates the
checklist first, outside any transaction, and only then opens one transaction
that does nothing but write. A forty-lesson copy plus a snapshot upsert must not
share a transaction with two hundred read queries, or it will hit Prisma's
interactive-transaction timeout on a realistic course.

**No change to the SSE layer.** `CourseStreamController.rowsForCourse` already
includes `courseId` in its `targetEntityId` filter and its comment names P6's
publish job as the case it was written for. Adding the `job-permissions.ts` row
is the whole of the integration: `mayWatch('publish_course', 'admin')` is false,
so an admin watching the stream correctly never sees the owner's publish job.

**The UI arrives in two halves, not at the end.** The checklist panel lands
immediately after the checklist endpoint, so the first end-to-end feedback comes
at task 5 rather than task 15; the publish and unpublish actions land after the
job works.

**The browser scenario seeds prior phases through Prisma.** This is the house
rule the P5 suite states outright — "driving the editor for it would be testing
P2". The scenario drives the publish panel through the UI and applies earlier
phases' fixtures directly, asserting the checklist re-reads and flips. The spec's
step 2 ("fix every item through the real UI and API") is satisfied by the
checklist reflecting real state, not by re-testing P2 through P5 in a browser.

## Affected files

**New**

| File | Change |
|---|---|
| `packages/shared/src/publication.ts` | §4.2 edges as data; `canTransition(from, to)`; `structurePayloadSchema` (zod) and its type |
| `packages/shared/test/publication.spec.ts` | Every §4.2 edge allowed; representative non-edges refused |
| `apps/api/src/content/publishing.service.ts` | Checklist (batch-loaded), lifecycle transitions, publish/unpublish, the `publishing` lock |
| `apps/api/src/content/publishing.controller.ts` | `publish-checklist`, `publish`, `unpublish`, `submit-review`, `return-to-draft`, `archive` |
| `apps/api/src/content/snapshot.ts` | Pure `buildStructurePayload(tree)` → the §4.3 snapshot |
| `apps/api/src/jobs/publish.queue.ts` | `BaseJobQueue` subclass; `PUBLISH_JOB_ID_PREFIX` |
| `apps/worker/src/jobs/publish.processor.ts` | Re-check, copy both tracks, set `content_status`, upsert snapshot, set course fields |
| `apps/worker/src/jobs/publish.worker.ts` | BullMQ worker, `PUBLISH_CONCURRENCY = 1`, NFR-07 logging |
| `apps/worker/src/jobs/publish-worker.service.ts` | Lifecycle wiring under `withJobLifecycle` |
| `apps/admin-web/components/publish-panel.tsx` | Checklist, status, transition actions, SSE progress |
| `apps/admin-web/lib/publish-types.ts` | Checklist and status types shared by the panel |
| `apps/api/test/publishing.e2e-spec.ts` | Checklist matrix, transitions, 422/409/403, unpublish preservation |
| `apps/api/test/unpublished-changes.e2e-spec.ts` | FR-PUB-03 across every admin write path |
| `apps/worker/test/publish-processor.spec.ts` | The run, its transaction, idempotency and the drift refusal |
| `apps/admin-web/e2e/publishing.spec.ts` | The spec's seven-step browser scenario |

**Modified**

| File | Change |
|---|---|
| `packages/shared/src/queues.ts` | Fifth `QueueDefinition` (`publish`, `publish:`, `PUBLISH_QUEUE_NAME`); `PublishCourseJobData`; `publishJobNames` |
| `packages/shared/src/errors.ts` | `PUBLISH_CHECKLIST_FAILED`, `PUBLISH_IN_FLIGHT`, `INVALID_PUBLICATION_TRANSITION` |
| `packages/shared/src/index.ts` | Export `publication.ts` |
| `apps/api/src/jobs/job-permissions.ts` | `publish_course: 'publishOrUnpublishCourse'`; stays out of `lessonTargetedJobTypes` |
| `apps/api/src/auth/published-lock.guard.ts` | Treat `publishing` as `published` (one condition) |
| `apps/api/src/content/courses.controller.ts` | `PATCH /:courseId` for `coverImageUrl` and the §8 fields import leaves empty |
| `apps/api/src/content/audio.service.ts` | Export `computeAudioStatus` so the checklist reuses it |
| `apps/api/src/content/lesson-content.service.ts` | Move its existing flag write onto the shared helper |
| `apps/api/src/content/images.service.ts`, `narration.service.ts`, `audio.service.ts`, `chapters.controller.ts`, `lessons.controller.ts`, `structure.service.ts` | Set `has_unpublished_changes` through the shared helper |
| `apps/worker/src/jobs/import.processor.ts` | Move its existing flag write onto the shared helper |
| `apps/api/src/app.module.ts` | Register `PublishingController`, `PublishingService`, `PublishQueue` |
| `apps/worker/src/worker.module.ts` | Register `PublishWorkerService` |
| `apps/admin-web/app/(portal)/courses/[courseId]/page.tsx` | Render the publish panel beside the curriculum tree |
| `apps/admin-web/lib/tree-types.ts` | Publication status and checklist types |
| `packages/shared/test/queues.spec.ts`, `apps/api/test/job-permissions.spec.ts`, `apps/api/test/rbac.e2e-spec.ts` | Extend for the fifth queue, the new job type, and R-01 over `publishing` |

**Read, not modified:** `base.queue.ts`, `job-lifecycle.ts`, `course-stream.controller.ts`,
`target-resolver.ts` (its `courseId` branch already resolves the new routes), `roles.ts`.

**Not touched:** `packages/database/prisma/`. P6 writes no migration. Every column
it needs exists; `PublishedCourseStructure` and `Course.publishedStructure` were
verified complete in `schema.prisma`.

## Risks

- **N+1 in the checklist.** Naively calling the per-lesson staleness methods is
  ~200 queries for a forty-lesson course, on an endpoint the panel polls.
  *Mitigation:* batch-load the tree and call the pure functions, as above; assert
  a query-count ceiling in the api e2e suite so a later refactor cannot quietly
  reintroduce it.
- **Transaction timeout on a large publish.** Prisma's interactive transactions
  default to a 5 s timeout; copying forty lesson bodies and upserting a snapshot
  can approach it. *Mitigation:* all reads and the re-check happen before the
  transaction opens; the transaction contains writes only; raise `timeout` and
  `maxWait` explicitly on the `$transaction` call and record the measured
  duration in tasks.md.
- **An orphaned `publishing` lock blocks the whole course.** Because R-01 now
  treats `publishing` as `published`, a course stuck there locks out every admin
  — strictly worse than P4's and P5's per-lesson version of the same gap.
  *Mitigation:* three of the four ways out are closed by the `previousStatus`
  restore — enqueue failure (compensating catch), checklist drift, and a failing
  write — and the api and worker suites test each. What remains is a process
  death between the lock transaction and the enqueue, which is the accepted gap
  the spec names and shares with P4 and P5; the task list requires the recovery
  to be a documented one-line status update rather than nothing.
- **`structure_payload` is P7's contract and is expensive to change** — altering
  it later means republishing every course. *Mitigation:* one zod schema in
  `packages/shared`, written and read through it; course metadata deliberately
  kept out so the common reason to change it does not arise.
- **A new lesson in a published course blocks republishing** until it is authored,
  because it is born `empty` and fails checklist item 2. This is correct and
  intended; it is listed here so it is not filed as a bug on first encounter.
- **Browser-suite cost.** The scenario needs a fully authored 3×2 course, and the
  suite already spawns the worker and requires ffmpeg. *Mitigation:* seed P2–P5
  artifacts through Prisma, per the house rule; drive only the panel.

## Test strategy

- **Unit** (`packages/shared`, `packages/content` conventions): the §4.2
  transition table — every edge and a representative set of non-edges; the
  snapshot builder — ordering, soft-delete exclusion, media flags, zod round-trip;
  the fifth queue definition against `queues.spec.ts`'s existing invariant that
  exactly one definition is unprefixed.
- **API e2e** (`apps/api/test/*.e2e-spec.ts`, real HTTP, real Postgres): the full
  seven-item checklist matrix, each item driven to fail and then to pass; every
  §4.2 transition and its refusal with `409 INVALID_PUBLICATION_TRANSITION`;
  `422 PUBLISH_CHECKLIST_FAILED` carrying the failures; `202` with a `publish:<n>`
  id and the course at `publishing`; `409 PUBLISH_IN_FLIGHT` on a second POST;
  `403 FORBIDDEN_COURSE_PUBLISHED` for a non-owner writing to a `publishing`
  course; unpublish leaving the snapshot and both published columns intact; the
  enqueue-failure path restoring the prior status; FR-PUB-03 across every admin
  write endpoint.
- **Worker** (`apps/worker/test/publish-processor.spec.ts`): a full run writing
  all five effects; a course that drifted to failing the checklist failing the
  job and writing nothing; an idempotency re-run leaving published content
  byte-identical with the version advanced and exactly one structure row.
- **Browser** (`apps/admin-web/e2e/publishing.spec.ts`): the spec's seven-step
  scenario, executed with `pnpm --filter @knowledge-explorer/admin-web test:e2e`.
  It is excluded from `turbo run test` by design and must be run explicitly.
- **Gate:** `pnpm verify` (typecheck + test) green, plus the browser suite.
  Requires `nvm use` (Node 22), `docker compose up -d --wait`, and ffmpeg.

## Out of scope

Restating the spec's non-goals, plus what planning added:

- The learner app and every §9.4 public endpoint (P7). Nothing reads the
  published track in P6; the snapshot is verified by asserting the row.
- Commerce (P8). Checklist item 7 queries the real `products` table and finds it
  empty; that is the whole contact with §7.
- NFR-01's static generation, revalidation and CDN — no learner app to rebuild.
  P7 owns the hook; P6 leaves the seam.
- Edit history, rollback, publishing a previous version (§13). No prior snapshot
  is retained.
- Partial, per-chapter, scheduled or embargoed publishing.
- Making `content_status = 'ready'` reachable.
- Any schema migration.
- An override that publishes past a failing checklist.
- **Added during planning:** automatic recovery from an orphaned `publishing`
  lock. The compensating catch covers enqueue failure; a process death between
  the transaction and the enqueue leaves the same gap P4 and P5 carry, and fixing
  all three belongs to one later phase, not to this one.
- **Added during planning:** any change to `CourseStreamController`. It already
  handles course-targeted jobs; touching it would be unjustified by the spec.
