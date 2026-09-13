# Plan: P9 — Topic requests

**Spec:** specs/p9-topic-requests/spec.md
**Status:** Approved
**Date:** 2026-09-13

## Objective

Make FR-REQ-01 real: learners submit topics, upvote each other's, and withdraw
their own; the owner rules on a queue — turning two tables that have sat unread
since P0 and two declared-but-unreferenced rows of §3's matrix into a working
surface, without letting the denormalized `upvote_count` drift, leaking a
submitter's identity onto a public page, or regenerating the initial migration.

## Approach

Five decisions shape the work. Each was taken during impact analysis, against
code that already exists, and each departs slightly from the shape the spec's
file table implied.

**1. Two public controllers, not one — the guard model forces it.**
`PublicMeController` puts `@UseGuards(LearnerSessionGuard, RolesGuard)` at the
*class* level and `@RequirePermission` on each method; `PublicCatalogController`
carries neither. P9 needs both models on the same resource, and mixing them in
one class means either a class-level guard that accidentally covers the
anonymous board, or method-level guards whose absence on the GET reads as an
oversight. Splitting by auth model is what `public/` already does:

- `public/topic-requests.controller.ts` — `PublicTopicRequestsController`, the
  anonymous `GET /topic-requests`. No `@UseGuards`, no `@RequirePermission`,
  resolving identity itself through `resolveOptionalSession`.
- `public/topic-requests-learner.controller.ts` — `TopicRequestsLearnerController`,
  class-level guards, holding `POST /topic-requests`,
  `DELETE /topic-requests/:requestId`, `POST /topic-requests/:requestId/vote`
  and `GET /me/topic-requests`.

Nest routes by method plus path, so `GET /topic-requests` in one class and
`POST /topic-requests` in the other do not collide.

**2. The admin side gets its own directory, not `content/`.** The spec's file
table put it in `apps/api/src/content/`, which holds courses, chapters, lessons
and publishing — course content. A topic request is not course content, and
`admins/` is admin *accounts*. `apps/api/src/topic-requests/` mirrors what
`admins/` does for a small owner-only feature. **This deviates from the spec's
"Affected files" table and is flagged for the gate rather than done quietly.**

**3. The migration is hand-written and applied with `migrate deploy` only.**
`prisma migrate dev` must never run in this repository. The initial migration
carries six partial unique indexes, one partial index and two CHECK constraints
appended below its generated section; they exist in the shadow database when the
migration replays but not in `schema.prisma`, so a diff-based generator has every
reason to emit `DROP INDEX` for them, and `prisma migrate diff` reports no
difference either way (CLAUDE.md invariant 1). So: write
`migrations/<ts>_add_topic_request_duplicate_of/migration.sql` by hand, mirror it
with `@@index(..., map: "...")` and the self-relation in `schema.prisma`, and
apply with `pnpm db:migrate`. `constraints.spec.ts` grows assertions for the new
foreign key, its `SET NULL` action and both indexes, because that suite is the
only guard on hand-written DDL here.

**4. The counter is a cache of the primary key, and the transaction says so.**
`upvote_count` duplicates `COUNT(topic_request_votes)`, and
`(topic_request_id, user_id)` is what actually makes one-vote-per-user true. The
toggle runs inside `prisma.$transaction`: read the vote row, then either
`create` plus `{ increment: 1 }` or `delete` plus `{ decrement: 1 }` — never a
read-modify-write of the integer. Two concurrent inserts collide on the primary
key and the loser's transaction rolls back whole, taking its increment with it.
The invariant is asserted under a burst of concurrent toggles, not just
sequentially, because sequential toggles pass with an entirely broken
implementation.

**5. The browser scenario seeds its published course directly, not through the
authoring pipeline.** `e2e/seed.ts`'s `seedCourse` authors three chapters, six
lessons, images, narration and audio through the real queues before publishing —
minutes of work and an ffmpeg merge. P9 reads none of it: the linked course
needs `slug`, `title` and `publication_status = 'published'` and nothing more.
The new suite writes that row with Prisma plus a minimal
`published_course_structures` row, and `catalog.service.ts` already tolerates a
missing or unparsable snapshot (`structure: parsed?.success ? … : null`), so the
course page renders and the link assertion is honest. The worker still spawns —
`global-setup.ts` is suite-level — so ffmpeg remains a prerequisite to run it.

Everything else follows existing shapes: zod `strictObject` in controllers,
`errorCode` on every refusal, `DEFAULT_PAGE_SIZE`/`MAX_PAGE_SIZE` reused from
`catalog.service.ts`, `serverApiFetch` for server components and the client
`apiFetch` with `credentials: 'include'` for the vote control, Vietnamese copy
inline in learner-web and English in admin-web.

## Affected files

| File | Change |
|---|---|
| `packages/database/prisma/migrations/<ts>_add_topic_request_duplicate_of/migration.sql` | **New, hand-written.** `duplicate_of_request_id` column; self-referencing FK `ON DELETE SET NULL`; `idx_topic_requests_board` on `(request_status, upvote_count DESC)`; `idx_topic_requests_requested_by` |
| `packages/database/prisma/schema.prisma` | `TopicRequest` gains `duplicateOfRequestId`, the `TopicRequestDuplicateOf` self-relation (both sides), and two `@@index` with `map:` matching the SQL names |
| `packages/database/test/constraints.spec.ts` | New describe block: the FK exists with `confdeltype = 'n'` (SET NULL), both indexes exist and are non-unique, and a behavioural check that deleting a duplicate's target nulls the pointer instead of raising |
| `packages/shared/src/errors.ts` | Eight codes: `TOPIC_REQUEST_NOT_FOUND`, `_NOT_PENDING`, `_OWN`, `_LIMIT_REACHED`, `_NOTE_REQUIRED`, `_DUPLICATE_TARGET_REQUIRED`, `_DUPLICATE_TARGET_INVALID`, `_LINKED_COURSE_NOT_FOUND`, each with the comment convention already there |
| `apps/api/src/public/topic-requests.service.ts` | **New.** Board query and grouping, the toggle transaction, the pending cap, withdrawal, `/me` view, and the viewer-scoped fields |
| `apps/api/src/public/topic-requests.controller.ts` | **New.** `PublicTopicRequestsController` — anonymous `GET /topic-requests`, no guards, `resolveOptionalSession` for `viewerHasVoted` / `viewerIsRequester` |
| `apps/api/src/public/topic-requests-learner.controller.ts` | **New.** `TopicRequestsLearnerController` — class-level `@UseGuards(LearnerSessionGuard, RolesGuard)`, `@RequirePermission('submitAndUpvoteTopicRequests')` per method |
| `apps/api/src/topic-requests/topic-requests-admin.controller.ts` | **New.** `@Controller('admin/topic-requests')`, `@UseGuards(SessionGuard, RolesGuard)`, `@RequirePermission('reviewTopicRequests')`; the queue GET and the per-status PATCH |
| `apps/api/src/topic-requests/topic-requests-admin.service.ts` | **New.** Queue filtering and sorting, the four status writes, the reopen clear |
| `apps/api/src/app.module.ts` | Register three controllers and two services; the commented public block gains `PublicTopicRequestsController` and `TopicRequestsLearnerController` with their reason |
| `apps/api/test/topic-requests.e2e-spec.ts` | **New.** Roles and cookie split, cap, toggle, the concurrency invariant, refusals, the PATCH union, the no-attribution assertion on the public payload |
| `apps/learner-web/lib/request-types.ts` | **New.** Response types for the board and `/me`, mirroring `catalog-types.ts` |
| `apps/learner-web/app/requests/page.tsx` | **New.** `force-dynamic` server component: open, built and closed groups, `?closed=1` expansion, submission form gate |
| `apps/learner-web/components/requests/vote-button.tsx` | **New.** Client component: `apiFetch` POST with `credentials: 'include'`, then `router.refresh()`; a `/signin` link when signed out; disabled with a reason on the caller's own request |
| `apps/learner-web/components/requests/submit-form.tsx` | **New.** Client component: title and description, surfacing `TOPIC_REQUEST_LIMIT_REACHED` from the server |
| `apps/learner-web/app/me/requests/page.tsx` | **New.** Own requests, withdraw control on pending rows, the `n / cap` indicator |
| `apps/learner-web/app/layout.tsx` | Nav gains `/requests` |
| `apps/admin-web/app/(portal)/topic-requests/page.tsx` | **New.** Queue with status filter and sort; per-row review form whose course picker and request picker enable by the selected status |
| `apps/admin-web/lib/topic-request-types.ts` | **New.** Queue row and PATCH body types |
| `apps/admin-web/app/(portal)/layout.tsx` | Nav gains `/topic-requests` |
| `apps/learner-web/e2e/helpers.ts` | `seedLearner` and `learnerCookie`, the twins of `seedStaff` and `adminCookie` — the scenario asserts 401/404/409 straight against the API and no helper mints a learner session without a browser sign-in |
| `apps/learner-web/e2e/topic-requests.spec.ts` | **New.** The thirteen-step scenario from the spec |
| `.env.example` | `TOPIC_REQUEST_PENDING_CAP=5` |

## Risks

- **`prisma migrate dev` silently drops the initial migration's hand-written
  DDL.** The highest-consequence failure available in this repository, and it
  leaves a schema that still migrates cleanly. *Mitigation:* the migration is
  hand-written, applied only with `pnpm db:migrate` (`migrate deploy`), and
  `packages/database/test/constraints.spec.ts` is run before and after the
  change — it already asserts all nine hand-written objects.
- **`upvote_count` drifts from `topic_request_votes`.** No symptom until the
  owner sorts by it. *Mitigation:* the counter never leaves the transaction that
  writes the vote row; the invariant is asserted after a concurrent burst in the
  api suite and again at the end of the browser scenario.
- **The anonymous board silently gains a guard, or silently loses its deny-by-
  default sibling.** Adding `@UseGuards` to the wrong class breaks the public
  board; adding `@RequirePermission` without a guard does nothing. *Mitigation:*
  two controllers split by auth model, plus a test named for the absence, the
  way `entitlement-gates.e2e-spec.ts` holds the same property for the reader.
- **A submitter's identity reaches the public payload.** One `include: { requestedByUser: true }`
  for the admin queue, reused by the board serializer, is all it takes.
  *Mitigation:* separate serializers in separate services — the public service
  never selects a user relation — plus an assertion that no learner email
  appears in the rendered page source.
- **The board's server component forgets to forward the learner cookie.**
  `viewerHasVoted` is then always false and the board looks completely healthy;
  `lib/server-api.ts` carries a comment warning about exactly this. *Mitigation:*
  use `serverApiFetch`, never bare `apiFetch`, in the page; the browser scenario
  votes and reloads, asserting the control renders as voted.
- **`ON DELETE SET NULL` leaves a `duplicated` row pointing at nothing.**
  Accepted by the spec, but the admin queue must render it rather than throw on
  a null target. *Mitigation:* step 11 of the browser scenario exercises exactly
  this path and asserts the queue still renders.
- **The harness is stale on phase status.** `.claude/harness/INDEX.md` was
  generated at commit `cae5a03` and says P4 onward is unbuilt; P4–P7 have since
  landed, and `architecture.md` still describes `packages/commerce` as an empty
  placeholder. *Mitigation:* plan from the spec and the code, which is what this
  analysis did; the harness's conventions and invariants sections are current
  and were used.
- **Two concurrent submissions can cross the pending cap.** Known and accepted
  by the spec — the cap is an abuse brake, not an invariant. *Mitigation:* none;
  recorded so a reviewer does not add a lock for it.

## Test strategy

No new unit-test surface: nothing in P9 is pure logic in a package. The cap, the
toggle and the grouping are all database behaviour, so they are tested where
they run.

- **Database — `packages/database/test/constraints.spec.ts`** (`pnpm --filter
  @knowledge-explorer/database test`). Catalog presence of the new FK and both
  indexes, `confdeltype = 'n'` for `SET NULL`, and one behavioural test that
  deleting a duplicate's target nulls the pointer. Needs Docker up and
  `pnpm db:migrate` applied.
- **Integration — `apps/api/test/topic-requests.e2e-spec.ts`** (`pnpm --filter
  @knowledge-explorer/api test topic-requests`), over real HTTP with supertest
  against a booted `AppModule`, following `public-catalog.e2e-spec.ts`. Covers:
  every role against every endpoint including the admin-cookie-on-a-learner-
  endpoint 401; the pending cap and its 409 payload; the toggle's three
  refusals; **a burst of concurrent toggles with the counter invariant asserted
  after**; the PATCH discriminated union's five refusals and the guarantee that
  a refused PATCH writes nothing; the reopen clearing all three columns; and an
  assertion that the public board payload contains no user id or email. The api
  vitest config sets `fileParallelism: false` — these suites share one database.
- **Browser — `apps/learner-web/e2e/topic-requests.spec.ts`** (`pnpm --filter
  @knowledge-explorer/learner-web test:e2e`), the spec's thirteen-step scenario
  spanning admin-web and learner-web. It is the only place the two apps meet, and
  the only place the no-attribution and live-not-cached properties can be checked
  as rendered output. Excluded from `turbo run test` by being a `test:e2e`
  script, like admin-web's.
- **Gate — `pnpm verify`** (typecheck + test) green across the monorepo, plus
  `pnpm --filter @knowledge-explorer/admin-web test:e2e` still green, since this
  phase edits admin-web's portal layout.

## Out of scope

The spec's non-goals stand unchanged: no outcome notification by email or
in-app; no vote merging when marking a duplicate; no rate limiting beyond the
per-user pending cap; no editing of a submitted request; no text moderation; no
anonymous submission or voting; no attribution on the public board; no comments
or replies; no owner-authored requests; no public sorting or filtering beyond
the fixed grouping; no commerce coupling; no queue, job type or
`job-permissions.ts` row.

Discovered during planning and added:

- **No revalidation hook.** `/requests` is `force-dynamic`, so
  `apps/learner-web/app/api/revalidate/route.ts`, `publishing.service.ts` and
  `publish.processor.ts` are not touched. Publishing a course does not
  revalidate the board.
- **The built and closed groups are capped at `MAX_PAGE_SIZE` and not
  paginated.** Only `open` takes `page`/`pageSize`.
- **No `packages/commerce` import anywhere in P9**, and no `hasAccessToCourse`
  call. Requesting a topic is not gated on owning anything.
- **`packages/shared/src/roles.ts` and `enums.ts` are not modified.** Both
  permission actions and all four `requestStatuses` members are already
  declared; P9 is the first code to reference them.
- **No change to CORS, cookie names or `main.ts`.**
