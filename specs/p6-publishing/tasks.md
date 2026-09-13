# Tasks: P6 — Publishing

**Plan:** specs/p6-publishing/plan.md

Tick boxes as work completes, not at the end — this file is the durable progress
state and is what survives a lost session.

Three rules for this phase specifically:

- **No migration.** `packages/database/prisma/` is not edited in any task. Every
  column P6 needs exists and was verified against `schema.prisma` during
  planning. If a task seems to need a column, stop and re-read the spec's problem
  statement before writing SQL.
- **The §6.5 staleness rule is not reimplemented.** Tasks reuse `computeStatus`,
  `computeAudioStatus` and `narrationStaleness`. A new comparison of two
  checksums anywhere in this phase is a bug.
- **Earlier phases' suites must keep passing unedited.** The only intentional
  test edits are the extensions named in tasks 7, 8 and 16.

---

## Slice A — The state machine and course metadata

- [x] **Task 1: §4.2 as data in `packages/shared/src/publication.ts`**
  Declare the allowed transitions plus `canTransition(from, to)`, and export from
  `index.ts`. Three groups, and the comment must say which is which, because only
  the first is drawn in §4.2:

  1. **On §4.2's diagram:** `draft→in_review`, `in_review→publishing`,
     `publishing→published`, `published→unpublished`, `unpublished→archived`.
  2. **Additions this phase makes deliberately**, each commented with its reason:
     `in_review→draft` (a review a reviewer cannot reject is not a review);
     `draft→publishing` (§4.2's line is the admin-authored happy path; an owner
     authoring their own course has nobody to hand it to, and §5.7 makes the
     checklist the gate, not the review); `published→publishing` and
     `unpublished→publishing` (FR-PUB-03's publish-changes and FR-PUB-04's
     republish, both of which the spec requires).
  3. **The restore edges out of `publishing`.** A failed publish must return the
     course to the status it held *before* the run — a re-publish of a live course
     that fails belongs back at `published`, not at `draft`, or a failed job would
     silently unpublish a course learners are reading. So `publishing` may return
     to `draft`, `in_review`, `published` or `unpublished`, and the caller
     supplies which. The previous status travels in the job payload (task 7); it
     is not derived and it is not stored in a new column. Add
  `PUBLISH_CHECKLIST_FAILED`, `PUBLISH_IN_FLIGHT` and
  `INVALID_PUBLICATION_TRANSITION` to `errors.ts`, each with the comment
  convention the file already uses. Record in a header comment why the table is
  data and not six `if` statements, citing `roles.ts`.
  - done when: `pnpm --filter @knowledge-explorer/shared test publication` passes,
    asserting every edge above is allowed, that `draft→archived`,
    `draft→published` (nothing reaches `published` except through `publishing`),
    `published→draft` and every edge out of `archived` are refused, and that every
    member of `publicationStatuses` appears somewhere in the table.

- [x] **Task 2: `PATCH /admin/courses/:courseId` for course metadata**
  Owner-only under `createCategoriesAndCourses`, zod `strictObject`, accepting
  `coverImageUrl`, `overviewSummary`, `prerequisites`, `learningObjectives` and
  `estimatedTotalMinutes`. This is what makes FR-PUB-01's cover-image item
  satisfiable at all — record that in the method comment.
  - done when: `pnpm --filter @knowledge-explorer/api test publishing` passes a
    case where the owner sets `coverImageUrl` and reads it back, an admin gets
    `403`, an unknown field gets `400 INVALID_BODY`, and an unknown course gets
    `404 COURSE_NOT_FOUND`.

- [x] **Task 3: Lifecycle endpoints**
  `PublishingController` + `PublishingService` with `POST /:courseId/submit-review`
  (`submitCourseForReview`), `POST /:courseId/return-to-draft` and
  `POST /:courseId/archive` (both `publishOrUnpublishCourse`). Every transition
  goes through task 1's table; none restates an edge. Register in `app.module.ts`.
  Comment the `return-to-draft` edge as a P6 addition to §4.2 and say why.
  - done when: the api suite asserts an admin moves `draft→in_review`, an admin is
    refused `in_review→draft` with `403`, the owner performs it, the owner
    archives an `unpublished` course, and `draft→archived` returns
    `409 INVALID_PUBLICATION_TRANSITION` naming the current status and allowed
    targets.

## Slice B — The checklist, and the first thing a person can see

- [x] **Task 4: Export `computeAudioStatus`**
  Change its declaration in `apps/api/src/content/audio.service.ts` to `export`
  and note in its comment that the checklist is now a second caller. Nothing else
  changes.
  - done when: `pnpm --filter @knowledge-explorer/api test audio` passes with no
    edits to `audio.e2e-spec.ts`.

- [x] **Task 5: The checklist service**
  `PublishingService.checklist(courseId)` returning all seven §5.7 items, each
  with a stable id, `passed`, a human-readable `reason`, and the offending rows
  (lesson titles, figure numbers, block ids). **Loads the course tree in a handful
  of queries** and calls `computeStatus`, `computeAudioStatus` and
  `narrationStaleness` per lesson over that data — it must not call
  `narration.staleness()` or `audio.stalenessFor()` in a loop. Item 7 queries the
  real `products` table. Expose `GET /:courseId/publish-checklist`.
  - done when: the api suite drives each of the seven items from failing to
    passing and asserts item ids and reasons; a separate case seeds a 12-lesson
    course and asserts the endpoint issues fewer than 25 queries, so the N+1 the
    plan names cannot return unnoticed.

- [x] **Task 6: Publish panel, part one — status and checklist**
  `apps/admin-web/components/publish-panel.tsx` plus `lib/publish-types.ts`,
  rendered beside the curriculum tree on the course page. Shows the publication
  status, the seven items with pass/fail and reasons, and the transition actions
  the caller's role and current state allow (submit-for-review for an admin;
  return-to-draft and archive for the owner). Stable `data-testid`s throughout.
  NFR-09: 1280 px and wider.
  - done when: `pnpm --filter @knowledge-explorer/admin-web typecheck` exits 0 and
    the panel, opened against a seeded failing course, lists the failing items
    with their reasons and offers exactly the actions the caller's role allows.

## Slice C — The publish job

- [x] **Task 7: The fifth queue**
  Add the `publish` `QueueDefinition` (`publish-course`, `PUBLISH_QUEUE_NAME`,
  `idPrefix: 'publish:'`, retention 3 600, `fallbackJobType: 'publish_course'`),
  `publishJobNames` and `PublishCourseJobData` (`generationJobId`, `courseId`,
  `createdByUserId`, `previousStatus`). `previousStatus` travels with the job for
  the reason P5's voice does: it is resolved once, at enqueue, so a failed run
  restores the status the course actually held rather than one re-read after the
  fact. Add `PublishQueue` extending `BaseJobQueue`. Add the
  `publish_course: 'publishOrUnpublishCourse'` row to `job-permissions.ts` and
  leave it out of `lessonTargetedJobTypes`, updating that file's forward-looking
  comment to past tense.
  - done when: `pnpm --filter @knowledge-explorer/shared test queues` still
    asserts exactly one unprefixed definition and now covers five;
    `pnpm --filter @knowledge-explorer/api test job-permissions` asserts
    `publish_course` maps to `publishOrUnpublishCourse`, that an admin may not
    watch it, and that it is not lesson-targeted.

- [x] **Task 8: Extend R-01 to `publishing`**
  One condition in `published-lock.guard.ts`, with a comment explaining that the
  window between enqueue and completion is exactly when a non-owner edit would
  corrupt the snapshot. Extend `rbac.e2e-spec.ts` with the case.
  - done when: `pnpm --filter @knowledge-explorer/api test rbac` passes and
    asserts a non-owner write against a course in `publishing` returns
    `403 FORBIDDEN_COURSE_PUBLISHED`, while the owner's write succeeds.

- [x] **Task 9: The snapshot builder**
  Pure `buildStructurePayload(tree)` in `apps/api/src/content/snapshot.ts`
  producing the spec's shape — chapters and lessons in order with `estimatedMinutes`,
  `isFreePreview`, `hasAudio`, `audioDurationSeconds` (copied from
  `total_duration_seconds`, never converted) and `figureCount` — plus
  `structurePayloadSchema` in `packages/shared/src/publication.ts`. Course
  metadata stays out; record why in the comment.
  - done when: a unit test asserts ordering, that soft-deleted chapters and
    lessons are excluded, that the media flags match their source rows, and that
    the output parses against `structurePayloadSchema`.

- [x] **Task 10: `POST /:courseId/publish`**
  Owner-only. Runs task 5's checklist and returns `422 PUBLISH_CHECKLIST_FAILED`
  with the full checklist when any item fails. Otherwise takes the `publishing`
  lock and creates the `generation_jobs` row **in one transaction**, enqueues
  **outside** it, and restores the previous status in a compensating catch. A
  second call against a course already `publishing` returns
  `409 PUBLISH_IN_FLIGHT` with the in-flight job id, recovered from the queue as
  `audio.service.ts:325` does. The status the course held going in is captured in
  that same transaction and put in the job payload.
  - done when: the api suite asserts `422` carrying the failures, `202` with an id
    matching `/^publish:\d+$/` and the course at `publishing`, `409` on a second
    call, and — with the queue forced to throw — that the course is restored to
    its previous status rather than left locked.

- [x] **Task 11: The publish processor**
  `publish.processor.ts`, `publish.worker.ts` (`PUBLISH_CONCURRENCY = 1`, NFR-07
  logging keyed on `courseId`) and `publish-worker.service.ts` under
  `withJobLifecycle`; registered in `worker.module.ts`. **Re-evaluates the
  checklist first, outside any transaction**, throwing an `UnrecoverableError`
  carrying the failing items if the course drifted. **Any failure — drift, or a
  write that throws — restores `publication_status` to the payload's
  `previousStatus`**, so a failed re-publish leaves a live course `published` and
  never strands it in `publishing`. Then one write-only
  transaction: copy `draft_content_markdown` and `draft_block_list` into the
  published columns and set `lesson_contents.published_at`; set every non-deleted
  lesson to `content_status = 'published'`; upsert
  `published_course_structures` with an incremented `published_version_number`,
  `published_by_user_id` and `total_lesson_count`; set
  `publication_status = 'published'`, `published_at` and
  `has_unpublished_changes = false`. Set an explicit `timeout` and `maxWait` and
  record the measured duration for a 3×2 course in the notes below.
  - done when: `pnpm --filter @knowledge-explorer/worker test publish-processor`
    asserts all five effects after one run, that soft-deleted rows are excluded,
    and that a course drifted to failing the checklist fails the job with the
    failing items and writes **nothing** — no snapshot row, no published columns.
    A separate case publishes a course that is already `published`, forces the
    run to fail, and asserts the course is back at `published` with its previous
    snapshot and version intact.

- [x] **Task 12: Idempotency and the version number**
  Re-run the job against an unchanged course.
  - done when: the worker test asserts `published_content_markdown` is
    byte-identical across both runs, exactly one `published_course_structures`
    row exists, and `published_version_number` is 2 — the spec's reading of
    FR-PUB-02, asserted rather than assumed.

## Slice D — Withdrawal, the indicator, and the whole path

- [x] **Task 13: Unpublish and republish**
  `POST /:courseId/unpublish`, owner-only, setting `publication_status =
  'unpublished'` and **writing nothing else**. Republishing runs the full
  checklist and the full job, `unpublished` being an ordinary pre-publish state.
  - done when: the api suite asserts after unpublish that the
    `published_course_structures` row, both published lesson columns and every
    seeded `access_grant` and `lesson_progress` row are untouched; that the course
    leaves the catalog-eligible status; and that republishing a course whose draft
    has since broken an item returns `422` rather than restoring silently.

- [x] **Task 14: FR-PUB-03 across every write path**
  A shared helper — `markUnpublishedChanges(tx, courseId)` — that sets the flag
  only when the course is `published`. Move `lesson-content.service.ts:209` and
  `import.processor.ts:190` onto it, then add it to image selection and
  caption/alt edits, narration approval and segment edits, audio run completion,
  chapter create/edit/delete, lesson create/edit/delete, and the structure
  rewrite. Enumerate the admin write endpoints while doing this rather than
  trusting the plan's list.
  - done when: `apps/api/test/unpublished-changes.e2e-spec.ts` walks each admin
    write endpoint against a published course, asserts the flag flips to true
    after each, and asserts it stays false when the same write lands on a `draft`
    course.

- [x] **Task 15: Publish panel, part two — the actions**
  Publish, unpublish and "publish changes" (shown on a `published` course with
  `has_unpublished_changes = true`), with progress taken from the existing
  `GET /courses/:courseId/stream` SSE endpoint as the audio tab does. A `422`
  re-renders the checklist with the failures. R-01 is server-side: the panel only
  avoids offering actions that would 403.
  - done when: `pnpm --filter @knowledge-explorer/admin-web typecheck` exits 0 and
    the panel, driven against a passing course, shows progress to completion and
    then the published status without a manual reload.

- [x] **Task 16: The browser scenario**
  `apps/admin-web/e2e/publishing.spec.ts`, implementing the spec's seven steps.
  Seeds P2–P5 artifacts through Prisma per the house rule the P5 suite states;
  drives the publish panel through the UI. Asserts the failing checklist with
  reasons, the refused publish, the successful publish and all five database
  effects, the indicator returning after an edit, `published_version_number = 2`
  on the second publish, the `403` and `409` refusals, and that unpublish
  preserves the snapshot.
  - done when: `pnpm --filter @knowledge-explorer/admin-web test:e2e publishing`
    passes with Docker up, Node 22 and ffmpeg present.

- [x] **Task 17: Green gate**
  - done when: `pnpm verify` exits 0 and
    `pnpm --filter @knowledge-explorer/admin-web test:e2e` passes in full, with no
    edits to any earlier phase's suite beyond the extensions named in tasks 7, 8
    and 16.

---

## Implementation notes

<!-- Record here as work proceeds: the measured publish-transaction duration from
     task 11, the actual query count from task 5, any write path task 14 found
     that the plan did not list, and anything a later phase needs to know. -->

**Task 5 — checklist query count: 7, flat.** A 12-lesson course (4 chapters × 3)
evaluates in seven client operations: course, chapters, lessons, contents,
scripts+audios+images (issued together), products. It does not grow with lesson
count, which is the whole point of loading per course. Asserted at `< 25` in
`publishing.e2e-spec.ts` so a later refactor back to the per-lesson services
fails the suite instead of quietly costing two hundred round-trips.

**Where the checklist ended up, and why it moved.** The plan put it in
`apps/api/src/content/publishing.service.ts`. It could not stay there: task 11's
worker re-check needs the identical verdict and `apps/worker` never imports
`apps/api`. It is now split — `loadPublishChecklistInput` in
`packages/database/src/publish-checklist.ts` (batched Prisma reads, plain data
out) and `evaluatePublishChecklist` in
`packages/content/src/publish-checklist.ts` (pure, no database). Both apps call
the pair. This also forced §6.5's `computeStatus` and `computeAudioStatus` out of
the api services and into `packages/content/src/narration.ts`, beside
`narrationStaleness`, which is the first link of the same chain; the api services
re-export them under their original names, so P4's and P5's suites pass unedited.

**`GET /publish-checklist` is owner-only.** §9.2 lists it among the owner
endpoints, so an admin gets 403. The phase spec's UI sentence ("an admin sees a
read-only checklist") is overridden by §9.2, which is the locked contract. The
admin half of the panel shows publication status and submit-for-review only.

**Task 11 — publish transaction duration.** A 3×2 course (six lessons) publishes
well inside a second; the whole six-test worker suite, which performs eight
publish runs, completes in about 1.5 s. The transaction ceiling is set at 30 s
with a 10 s `maxWait`, which is headroom for a few hundred lessons rather than a
measured need. The assertion in the happy-path test is `< 30 s`, so a future
change that moves reads back inside the transaction fails rather than merely
slowing down.

**Task 14 — the write paths that were missing the flag.** The plan listed the
known set and warned it might not be exhaustive. Enumerating the admin write
endpoints found exactly the listed ones and no more: chapter create/edit/delete,
lesson create/edit/delete, structure rewrite, image patch (select/caption/alt)
and narration update (edit/approve). Three endpoints were deliberately LEFT OUT
and the reason is worth keeping:

- `PATCH /courses/:courseId` (cover image, overview), `PATCH .../pricing-type`
  and `PATCH .../voice` do not flag. §9.4 reads course metadata and pricing live
  from `courses`, not from the snapshot, so those changes are already visible to
  learners — there is nothing pending for a publish to catch up on.
- Generating image candidates does not flag; only selecting one does. An
  unselected candidate changes nothing a learner sees.

A related fact worth recording for P7: **§8 gives narration and audio no
published copy.** §9.4 serves script segments and audio timings live from
`narration_scripts` and `lesson_audios`, so an approved narration edit reaches a
learner immediately, without a publish. The flag is still set, because it
truthfully says the course has moved since it was published, but the draft/
published split genuinely covers lesson bodies and the table of contents only.

**A silent 404 the plan did not predict: `JobStatusService`.** Its `instances()`
map is partial by design and *skips* a queue definition it has no instance for,
falling through to the unprefixed import queue. Registering `PublishQueue` in
`app.module.ts` was therefore not enough — `GET /admin/jobs/publish:3/stream`
404'd, the panel hung on `draft`, and the run had meanwhile succeeded and
published the course. Nothing failed; the browser simply never heard. Fixed by
adding the instance, with the cost of forgetting written into the file's comment,
and guarded by an api test asserting the id returned by the 202 actually
resolves. **P8's `send_expiry_reminder` will hit this too.**

**Two §6.5 functions moved, and one voice resolver.** `computeStatus` and
`computeAudioStatus` are now `computeScriptStatus`/`computeAudioStatus` in
`packages/content/src/narration.ts`, and `resolveCourseVoice` is in
`packages/ai/src/text-to-speech.provider.ts` (it replaced a private duplicate of
`DEFAULT_OPENAI_VOICE` in apps/api). All three moved for the same reason: the
publish worker re-checks the checklist and `apps/worker` cannot import
`apps/api`. The api services re-export the first two under their original names,
so P4's and P5's suites pass unedited.
