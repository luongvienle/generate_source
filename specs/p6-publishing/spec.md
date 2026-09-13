# Spec: P6 — Publishing

**Status:** Approved
**Date:** 2026-09-13

Derived from `knowledge-explorer-spec.md` §12 phase P6 — *"Checklist, publish
worker, structure snapshot, published-course edit lock, unpublish."* That document
is the product source of truth and is locked except §14; this spec adds only the
implementation decisions P6 requires and the product spec does not make. It
assumes `specs/p1-curriculum/` through `specs/p5-audio/` are delivered, which as of
this writing they are. It opens no §14 decision and closes none.

## Problem statement

Everything the product sells has been built and none of it is reachable. Five
phases produced a draft track — chapters, lessons, markdown, blocks, images,
narration segments, merged audio with per-segment offsets — and §4.3's other half
is empty. `published_course_structures` has no rows. `lesson_contents.published_content_markdown`
and `published_block_list` are null for every lesson. `courses.publication_status`
has never left `draft`. No learner can see anything, and P7 has nothing to read.

P6 is the seam between the two tracks, and it is narrow but load-bearing in three
ways.

**It is the first phase whose output another phase consumes blind.** P7's catalog
and reader read `structure_payload`, a JSONB column the product spec declares and
never describes. Whatever shape P6 writes is the shape P7 gets; there is no
negotiation later, because a snapshot is only rebuilt by a publish.

**It is the first phase that must be right about a moment rather than a
computation.** P3, P4 and P5 each turned an input into an artifact a human judges.
P6 freezes a tree of rows at an instant, and the guarantee §4.3 asks for —
learners never see half-edited content, progress never breaks — is a statement
about what can change while the freeze is running. §4.2 already names the state
(`publishing`) and no guard recognises it.

**It is the first phase since P0 that adds no column, and that is a finding, not
an assumption.** `published_course_structures` is complete as specified.
`courses` already carries `has_unpublished_changes`, `published_at` and
`publication_status`; `lesson_contents` already carries both published columns and
its own `published_at`. The in-flight lock P4 and P5 each needed a status column
for is, here, `publication_status = 'publishing'` — an §8.1 value that exists for
exactly this purpose. **P6 writes no migration.** If an implementation finds
itself reaching for one, something has been misread.

Three concrete gaps in the existing code block FR-PUB-01 and must be closed here,
each verified by reading the repository rather than inferred:

- **Nothing can write `courses.cover_image_url`.** Import does not set it and no
  PATCH accepts it; only `categories` has a cover-image field
  (`categories.controller.ts:21`). The checklist item "the course has a category
  and a cover image" cannot pass for any course that exists.
- **`lessons.content_status` is only ever written as `drafting`**
  (`lesson-content.service.ts:204`). §4.2's `ready` and `published` members have
  never been written by anything.
- **`has_unpublished_changes` is set by exactly two write paths.** A search of
  the repository finds it written only at `lesson-content.service.ts:209` (draft
  save) and `import.processor.ts:190` (re-import into a published course). Image
  selection, narration approval, audio generation, chapter and lesson CRUD, and
  the structure rewrite all leave it false, so FR-PUB-03 is today a half-truth: an owner can select a new
  illustration in a published course and see no "publish changes" action.

## Acceptance criteria

### The publication lifecycle (§4.2, closed)

P6 closes §4.2's editorial state machine entirely. Every member becomes
reachable; no member is left unwritten.

- `POST /api/admin/courses/:courseId/submit-review` (§9.3) moves `draft` →
  `in_review`. Declares `submitCourseForReview`, so admin and owner may both call
  it — the matrix row has existed since P0 with no endpoint behind it.
- `POST /api/admin/courses/:courseId/return-to-draft` moves `in_review` → `draft`.
  **This edge is an addition.** §4.2's diagram is a straight line and no FR
  describes a rejection, but a review a reviewer cannot reject is not a review,
  and `in_review` would otherwise be a state only a publish can leave. Declares
  `publishOrUnpublishCourse` — sending work back is the reviewer's half of the
  handoff, and §3 gives review authority to the owner alone.
- `POST /api/admin/courses/:courseId/archive` moves `unpublished` → `archived`.
  Terminal: no endpoint leaves `archived`, per §4.2. Declares
  `publishOrUnpublishCourse`. Archived courses are excluded from admin course
  lists ("hidden from admin lists", §4.2) and remain excluded from the catalog
  because they are not `published`.
  - **Only `unpublished` may be archived**, not `draft` and not `published`.
    §4.2's arrow runs `unpublished → archived` and nowhere else; archiving a live
    course would remove it from admin lists while it still served learners.
- Every transition endpoint refuses a move that is not an edge of §4.2's machine
  with `409` and `errorCode: 'INVALID_PUBLICATION_TRANSITION'`, reporting the
  current status and the allowed targets. The machine lives as **data in one
  place** — a transition table in `packages/shared/src` beside `roles.ts`, read by
  every endpoint — for the reason §3 lives as data: an enforcement rule recorded
  twice drifts.

### FR-PUB-01 — the checklist

- `GET /api/admin/courses/:courseId/publish-checklist` returns **all seven of
  §5.7's items**, each with a stable machine id, a pass/fail boolean, and a
  human-readable reason — §5.7's eighth bullet is that response shape, not an
  eighth item. A failing item names the offending rows — the lesson
  titles that are empty, the figure numbers missing a selected image, the lessons
  whose audio is stale — because a checklist that says "some lesson is empty" for
  a forty-lesson course is a worse tool than no checklist.
- The seven items, and what each reads:
  1. Every non-deleted lesson has non-empty `draft_content_markdown`.
  2. No non-deleted lesson is in `content_status = 'empty'`.
  3. Every figure block in every lesson's `draft_block_list` has a
     `lesson_images` row with `is_selected = true`, non-empty `caption_text` and
     non-empty `alternative_text`.
  4. No narration script or audio is `stale` or `failed`. **Staleness is computed,
     never read** — §6.5 is explicit that `stale` is never stored, and both
     derivations already exist (`narration.service.ts:262`,
     `audio.service.ts:446`). The checklist calls them; it does not re-derive
     them, and it does not trust `script_status` or `audio_status` for staleness.
  5. At least 3 non-deleted chapters, and every non-deleted chapter has at least
     2 non-deleted lessons.
  6. The course has a `category_id` and a non-empty `cover_image_url`.
  7. If `pricing_type = 'paid'`, at least one `products` row with `is_active = true`
     references this course or its category.
- P6 adds no item of its own. §5.7's list is the whole list.
- **Item 7 is implemented against the real `products` table, which P8 fills.**
  Free courses — the default, and every course that exists — pass it vacuously. A
  paid course fails with a reason naming the missing product, and cannot publish
  until P8. This is the honest reading of FR-PUB-01 and it is deliberate: a
  checklist that reports a pass it did not verify is worse than one that blocks.
  - *Rejected:* reporting the item as "not applicable until P8". That trades a
    truthful block for a silent lie in the one place the product spec asks for
    the truth.
- The checklist is **one service**, called from three places: the GET endpoint,
  the POST that enqueues, and the worker. There is no second implementation.

### FR-PUB-02 — the publish job

- `POST /api/admin/courses/:courseId/publish` is owner-only
  (`publishOrUnpublishCourse`) and returns `202` with the qualified BullMQ job id,
  or **`422` with the full checklist** when any item fails
  (`errorCode: 'PUBLISH_CHECKLIST_FAILED'`), exactly as §9.2 specifies.
- **The checklist is evaluated twice: at POST, and again in the worker before
  anything is written.** The POST evaluation exists to give the owner an
  immediate, useful rejection. The worker evaluation is the authoritative one: a
  lesson edited between the `202` and the job starting must not reach learners
  unchecked. A worker-side failure fails the `generation_jobs` row carrying the
  failing items, and reaches the browser over the existing SSE stream.
- The job:
  - Copies `draft_content_markdown` → `published_content_markdown` and
    `draft_block_list` → `published_block_list` for every non-deleted lesson, and
    sets `lesson_contents.published_at`.
  - Sets `lessons.content_status = 'published'` for every non-deleted lesson.
    This is what closes §4.2's lesson machine: the draft-save path already writes
    `drafting` (`lesson-content.service.ts:204`), so the next edit reverts it with
    no new code. **`ready` remains unreachable and P6 does not invent an action to
    reach it** — no FR asks for it and nothing would consume it. Recorded here so
    a later reader knows it is a decision, not an oversight.
  - Upserts the `published_course_structures` row, incrementing
    `published_version_number` and setting `published_by_user_id`,
    `published_at` and `total_lesson_count`.
  - Sets `courses.publication_status = 'published'`, `courses.published_at`, and
    `has_unpublished_changes = false`.
  - Excludes every row with `deleted_at IS NOT NULL`. §4.3's "deleted lessons stay
    in the last published snapshot until the next publish" needs no code: the
    previous snapshot was built before the deletion and is not rewritten until
    this job replaces it.
  - **Runs in one transaction.** A partially published course is the one outcome
    §4.3 forbids.
- **`published_version_number` increments on every successful publish**, including
  one that changes nothing. FR-PUB-02's "idempotent" is read as: re-running the
  job after a crash converges on the same published *content*, writes no duplicate
  rows and corrupts nothing. The version counts publish events, which is what
  makes it an audit trail of when the owner published.
  - *Rejected:* incrementing only when content changed. It requires a full
    content comparison on every publish to answer a question nothing asks, and it
    makes the version number mean something different from what P7 would assume.

### The structure snapshot

- `structure_payload` is a table of contents **plus the per-lesson media facts a
  catalog needs**, and nothing else:

```
{ courseId, publishedVersionNumber,
  chapters: [ { chapterId, order, title, description,
                lessons: [ { lessonId, order, title, estimatedMinutes,
                             isFreePreview, hasAudio, audioDurationSeconds,
                             figureCount } ] } ],
  totalLessonCount }
```

- `audioDurationSeconds`, not milliseconds: `lesson_audios.total_duration_seconds`
  is the stored column and the snapshot copies it rather than converting, so the
  two cannot disagree. Per-segment offsets stay in `audio_segments` where P7's
  highlight sync reads them; they are not snapshot material.
- The media flags are in because their absence forces P7's learner path to join
  `lesson_audios` and `lesson_images` — admin-owned tables — to render a course
  page. §4.3 puts learners on the published track; a snapshot that makes them
  leave it defeats the split.
- **Course metadata is deliberately NOT denormalized into the payload.** Title,
  slug, overview, prerequisites, objectives and cover image stay on `courses`,
  which §9.4's `GET /courses/:slug` reads directly. Copying them here would put
  course metadata in two places, and §4.3's stated reason for a separate table is
  that the snapshot stays a few KB — not that it becomes the whole page.
- The payload is written and read through **one zod schema in
  `packages/shared/src`**, so P7 parses what P6 wrote rather than a hand-copied
  interface.

### FR-PUB-03 — the unpublished-changes indicator

- **Every write path that can change what a learner would see sets
  `has_unpublished_changes = true` on a `published` course.** Today two do. P6
  closes the remaining seven: image selection and caption/alt edits, narration
  approval and segment edits, audio generation completing, chapter create/edit/
  delete, lesson create/edit/delete, and the structure rewrite.
  - The flag is set **only when the course is `published`**. Setting it on a draft
    course is meaningless and the existing two paths already guard this way.
  - Enforced by a single shared helper rather than nine copies of the same
    update, and held under test by a suite that walks the admin write endpoints
    and asserts the flag after each.
- A `published` course with `has_unpublished_changes = true` shows the owner a
  "publish changes" action, which runs the same checklist and the same job.

### FR-PUB-04 — unpublish, and republishing

- `POST /api/admin/courses/:courseId/unpublish` is owner-only, sets
  `publication_status = 'unpublished'`, and **writes nothing else**. The
  `published_course_structures` row, both published lesson columns, every
  `access_grant` and every `lesson_progress` row are untouched — which is what
  makes FR-PUB-04's preservation guarantee structural rather than a promise.
- **Republishing an `unpublished` course runs the full checklist and the full
  publish job**, bumping the version like any other publish. `unpublished` is
  treated as an ordinary pre-publish state, because the draft may have been edited
  during the window and a status flip would serve content the checklist never saw.
  - *Rejected:* a cheap "restore" that only flips the status back. It is correct
    exactly when nothing changed, and silently wrong otherwise.

### R-01 and the publishing window

- **`PublishedLockGuard` is extended to treat `publishing` exactly like
  `published`.** It today keys on `published` alone, so during the job a non-owner
  admin can edit the very lessons being copied. Same `403`, same
  `FORBIDDEN_COURSE_PUBLISHED` error code.
- **`publication_status = 'publishing'` is the in-flight lock.** It is taken in
  the same transaction that creates the `generation_jobs` row, following the
  pattern `audio.service.ts:253` records; the enqueue stays outside that
  transaction, with the house compensating catch that must also restore the
  previous status or a failed enqueue wedges the course behind its own lock.
- A second `POST /publish` against a course already in `publishing` returns `409`
  with `errorCode: 'PUBLISH_IN_FLIGHT'` and the in-flight job id, matching
  `SCRIPT_GENERATION_IN_FLIGHT` and `AUDIO_GENERATION_IN_FLIGHT`.
- The owner is **not** locked out during `publishing`. R-01 exists to keep
  non-owners out of published courses, and locking the owner out of the course
  they just published serves nobody; the job's single transaction is what makes
  the snapshot consistent, not a freeze on the owner.

### Queue, job and progress plumbing

- A **fifth queue**, `publish-course`, joins `queueDefinitions` in
  `packages/shared/src/queues.ts` with `idPrefix: 'publish:'`, `envVar:
  'PUBLISH_QUEUE_NAME'` and `fallbackJobType: 'publish_course'`. The producer is a
  `BaseJobQueue` subclass in `apps/api/src/jobs/`; the consumer is
  `apps/worker/src/jobs/` under `withJobLifecycle`.
- `publish_course` gains its row in `apps/api/src/jobs/job-permissions.ts` mapped
  to `publishOrUnpublishCourse`. That file already names this phase as the one
  that adds it, and its deny-by-default contract means forgetting fails closed.
  The job is **not** lesson-targeted: `target_entity_id` is the course id, so it
  is absent from `lessonTargetedJobTypes` and R-02 does not apply.
- Progress rides the existing `GET /courses/:courseId/stream` SSE endpoint (§9.3),
  which is already course-scoped. No new stream.

### The admin screen

- A publish panel on the course page (`apps/admin-web/app/(portal)/courses/[courseId]/`),
  matching the phase's delivery surface to P5's: the checklist with per-item pass/
  fail and reasons, the current publication status, and the transition actions the
  caller's role and the current state allow.
- Owner sees publish, unpublish, return-to-draft and archive; an admin sees
  submit-for-review and a read-only checklist. **Server-side enforcement is the
  guarantee** (R-01 is explicit that it is "not enforced by hiding buttons"); the
  UI merely avoids offering actions that would 403.
- A "publish changes" action appears on a `published` course with
  `has_unpublished_changes = true`.
- Publish progress and terminal state come over the course SSE stream, as P5's
  audio tab does.
- NFR-09: works at 1280 px and wider.

## Non-goals

- **The learner app.** Nothing reads the published track in P6. `GET /courses`,
  `GET /courses/:slug` and `GET /lessons/:lessonId` (§9.4) are P7. P6's snapshot is
  verified by asserting the row, not by rendering it.
- **Commerce.** No products, no prices, no grants. Checklist item 7 queries the
  `products` table and finds it empty; that is the whole of P6's contact with §7.
- **NFR-01's static generation, revalidation and CDN.** A publish does not
  trigger a rebuild or purge a cache, because there is no learner app to rebuild.
  P7 owns the revalidation hook; P6 leaves the seam where it will attach.
- **Edit history, rollback, or publishing a previous version.** §13 excludes it.
  `published_version_number` counts publishes; it does not address a stored
  version, and no prior snapshot is retained.
- **Partial or per-chapter publishing.** The course is the unit (§4.1).
- **Scheduled or embargoed publishing.** No FR asks for it.
- **Making `content_status = 'ready'` reachable.** Explicitly left unwritten; see
  FR-PUB-02 above.
- **Any schema migration.** If one appears necessary, the finding in the problem
  statement has been misread — stop and re-check before writing SQL.
- **An override that publishes past a failing checklist.** §5.7 is locked:
  "Publishing is blocked until every item passes."

## Constraints

- **`knowledge-explorer-spec.md` outranks this document.** FR-PUB-01 through
  FR-PUB-04, §4.2's states, §4.3's two tracks, §9.2/§9.3's routes and §3's
  owner-only publishing are locked and are not reopened here.
- **Never regenerate `20260911180121_init/migration.sql`** (CLAUDE.md invariant 1).
  P6 needs no migration at all, which makes this cheap to honour.
- **Deny-by-default everywhere.** Every new endpoint declares a §3 action; every
  new job type gets its `job-permissions.ts` row. An endpoint or job type with no
  declaration is refused, and `UndeclaredPolicyFixtureController` must keep
  declaring nothing (CLAUDE.md invariant 2).
- **`emitDecoratorMetadata` stays `false`**; injection is explicit `@Inject(Token)`
  (CLAUDE.md invariant 4).
- **Enum-like values are `String` columns** whose members live in
  `packages/shared/src/enums.ts` as zod schemas. `publication_status` and
  `content_status` already do; the transition table joins them there.
- Request bodies validated with zod `strictObject` in the controller; every error
  carries an `errorCode` from `packages/shared/src/errors.ts`.
- NFR-03: the publish job retries with exponential backoff, max 3 attempts, via
  `withJobLifecycle`. NFR-04: no HTTP request waits on the job. NFR-07: structured
  logging with `jobType`, `targetEntityId`, `attemptCount`.
- Tests live in per-workspace `test/`, named `*.spec.ts` / `*.e2e-spec.ts` — both
  globs are listed explicitly in the api vitest config, and a file matching
  neither silently never runs.
- Node 22 and a running Docker stack; ffmpeg present, because the browser suite
  spawns the worker.

## Affected files and interfaces

**New**

| Path | Purpose |
|---|---|
| `packages/shared/src/publication.ts` | §4.2 transition table as data, plus `canTransition`; the `structure_payload` zod schema |
| `apps/api/src/content/publishing.service.ts` | The checklist (one implementation), lifecycle transitions, publish/unpublish |
| `apps/api/src/content/publishing.controller.ts` | `publish-checklist`, `publish`, `unpublish`, `submit-review`, `return-to-draft`, `archive` |
| `apps/api/src/jobs/publish.queue.ts` | `BaseJobQueue` subclass for `publish-course` |
| `apps/worker/src/jobs/publish.processor.ts`, `publish.worker.ts`, `publish-worker.service.ts` | Re-check the checklist, copy both tracks, build the snapshot |
| `apps/admin-web/app/(portal)/courses/[courseId]/` publish panel | Checklist, status, transition actions, SSE progress |
| `apps/api/test/publishing.e2e-spec.ts` | Checklist matrix, transitions, 422/409/403, idempotency re-run |
| `apps/admin-web/e2e/publishing.spec.ts` | The end-to-end scenario below |

**Modified**

| Path | Change |
|---|---|
| `packages/shared/src/queues.ts` | Fifth `QueueDefinition`, `publish:` prefix, `PublishCourseJobData` |
| `packages/shared/src/errors.ts` | `PUBLISH_CHECKLIST_FAILED`, `PUBLISH_IN_FLIGHT`, `INVALID_PUBLICATION_TRANSITION` |
| `apps/api/src/jobs/job-permissions.ts` | `publish_course: 'publishOrUnpublishCourse'`; stays out of `lessonTargetedJobTypes` |
| `apps/api/src/auth/published-lock.guard.ts` | Treat `publishing` as `published` |
| `apps/api/src/content/courses.controller.ts` | `PATCH /:courseId` for `coverImageUrl` and the §8 course fields import leaves empty |
| `apps/api/src/content/images.service.ts`, `narration.service.ts`, `audio.service.ts`, `chapters.controller.ts`, `lessons.controller.ts`, `structure.service.ts` | Set `has_unpublished_changes` through the shared helper |
| `apps/api/src/content/lesson-content.service.ts`, `apps/worker/src/jobs/import.processor.ts` | Move their existing flag writes onto the shared helper |
| `apps/admin-web/lib/tree-types.ts` | Publication status and checklist types |

**Consumed unchanged:** `narration.service.ts:262` and `audio.service.ts:446`
(staleness, §6.5), `job-lifecycle.ts`, `base.queue.ts`, `course-stream.controller.ts`,
`roles.ts`, `structure.service.ts`'s draft reordering.

## End-to-end verification

A Playwright scenario in the admin-web browser suite
(`pnpm --filter @knowledge-explorer/admin-web test:e2e`), which owns the api and
admin-web processes and spawns the worker in `global-setup.ts`. It must:

1. Seed a course that fails the checklist in at least four distinct ways — a
   lesson with empty content, a figure block with no selected image, a lesson
   whose narration is stale against an edited body, and only two chapters. Open
   the publish panel and assert each failing item is listed with its reason, and
   that publish is refused with `422`.
2. Fix every item through the real UI and API: write the missing body, select and
   caption the image, regenerate the stale script and its audio, add the third
   chapter with two lessons, set a cover image.
3. Publish as the owner. Assert `202`, watch the SSE stream to a terminal
   `succeeded`, and assert in the database:
   - a `published_course_structures` row with `published_version_number = 1`,
     `total_lesson_count` matching the non-deleted lessons, and a
     `structure_payload` that parses against the shared schema with every chapter
     and lesson in order;
   - `published_content_markdown` equal to `draft_content_markdown` for every
     non-deleted lesson;
   - `courses.publication_status = 'published'`, `published_at` set,
     `has_unpublished_changes = false`;
   - every non-deleted lesson at `content_status = 'published'`.
4. Edit one lesson body and assert `has_unpublished_changes` returns to `true`,
   that lesson returns to `drafting`, and the panel offers "publish changes".
5. Publish again; assert `published_version_number = 2` and that the snapshot now
   reflects the edit.
6. Assert the refusals, as R-01 is enforced server-side: a non-owner admin writing
   to the published course gets `403 FORBIDDEN_COURSE_PUBLISHED`, and a second
   `POST /publish` during `publishing` gets `409 PUBLISH_IN_FLIGHT`.
7. Unpublish, and assert the `published_course_structures` row and both published
   columns still exist untouched.

The api e2e suite carries what the browser should not: the full seven-item
checklist matrix, every §4.2 transition and every rejected non-edge, and an
idempotency check that re-runs the publish job against an unchanged course and
asserts the published content is byte-identical while the version advanced.

`pnpm verify` must pass.

## Open questions

None. Every decision this spec needed was taken during the interview; §14 remains
untouched, with decision #1 (payment gateway) still the only item blocking P8 and
decisions #2 and #3 still configuration owned by P7 and P8.

Two things are recorded as **deliberate gaps** rather than open questions, so a
later reader does not reopen them as oversights:

- `content_status = 'ready'` stays unreachable. No FR asks for it and nothing
  consumes it.
- The orphaned-lock case P4 and P5 both record — a status left at `publishing`
  because a process died between the transaction and the enqueue — applies here
  too and is not solved here either. It is the same known gap, in the same shape,
  and a later phase that fixes it should fix all three at once.
