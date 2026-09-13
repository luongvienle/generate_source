# Tasks: P9 — Topic requests

**Plan:** specs/p9-topic-requests/plan.md

Tick boxes as work completes, not at the end — this file is the durable progress
state and is what survives a lost session.

Five rules for this phase specifically:

- **Never run `prisma migrate dev`, `migrate reset` or `db push`.** Task 1 writes
  its migration by hand and applies it with `pnpm db:migrate` (`migrate deploy`).
  The initial migration carries nine hand-appended objects that a diff-based
  generator has every reason to drop, and `prisma migrate diff` reports "No
  difference detected" either way (CLAUDE.md invariant 1). If a task seems to
  need a generator, stop and re-read the plan's approach note 3.
- **The counter never leaves its transaction.** Every write to `upvote_count`
  happens inside the same `prisma.$transaction` as the `topic_request_votes` row,
  as `{ increment: 1 }` / `{ decrement: 1 }`, never a read-modify-write. A
  recomputed count written from application code is the bug this phase exists to
  avoid.
- **The public service never selects a user relation.** Not
  `requestedByUser`, not `include: { requestedByUser: … }`, not a `userId` on any
  board field. Submitter identity is serialized by
  `topic-requests-admin.service.ts` and nowhere else. `viewerHasVoted` and
  `viewerIsRequester` describe the *caller* and are derived from the caller's own
  session.
- **No migration beyond task 1, and no second one.** Every other column P9 needs
  exists in `schema.prisma` and was verified during planning.
- **Earlier phases' suites must keep passing unedited.** The only intentional test
  edits are the additions in tasks 1 and 9. If a P0–P7 suite changes, that is a
  finding to report, not a fix to make quietly.

Before starting: `nvm use` (Node 22), `docker compose up -d --wait`,
`pnpm db:migrate`, and confirm `pnpm --filter @knowledge-explorer/database test`
is green — that is the baseline task 1 must not break.

---

## Slice A — The schema, before anything that reads it

- [x] **Task 1: `duplicate_of_request_id`, by hand**
  Write `packages/database/prisma/migrations/<timestamp>_add_topic_request_duplicate_of/migration.sql`
  with the column, the self-referencing foreign key `ON DELETE SET NULL ON UPDATE
  NO ACTION`, `idx_topic_requests_board` on `(request_status, upvote_count DESC)`
  and `idx_topic_requests_requested_by`. Mirror it in `schema.prisma`:
  `duplicateOfRequestId`, both sides of the `TopicRequestDuplicateOf` self-relation,
  and two `@@index` carrying `map:` names identical to the SQL. Extend
  `packages/database/test/constraints.spec.ts` with a describe block asserting the
  FK exists with `confdeltype = 'n'`, both indexes exist and are non-unique, and —
  behaviourally — that deleting a request some other row names as its duplicate
  target nulls the pointer rather than raising.
  - done when: `pnpm db:migrate` applies cleanly; `pnpm --filter
    @knowledge-explorer/database exec prisma migrate status` reports no pending
    migration and no drift; and `pnpm --filter @knowledge-explorer/database test`
    is green including the nine pre-existing hand-written-DDL assertions **and**
    the new ones — that suite passing after the migration is the proof the
    initial migration's objects survived. (A from-scratch replay on an empty
    volume is the stronger check, but `docker compose down -v` destroys the local
    development database; only do it deliberately.)

## Slice B — Submit a request and see it on the board

- [x] **Task 2: the submit and read endpoints**
  Add the eight error codes to `packages/shared/src/errors.ts` with the existing
  comment convention. Create `apps/api/src/public/topic-requests.service.ts` with
  `submit`, `board` (open group only for now) and the viewer-scoped field
  derivation. Create `PublicTopicRequestsController` (`GET /topic-requests`, **no
  guards, no `@RequirePermission`**, identity via `resolveOptionalSession`) and
  `TopicRequestsLearnerController` (`POST /topic-requests`, class-level
  `@UseGuards(LearnerSessionGuard, RolesGuard)`,
  `@RequirePermission('submitAndUpvoteTopicRequests')`). Title 3–120 trimmed,
  description ≤1000, both in one zod `strictObject`. Register everything in
  `app.module.ts`, extending the existing public-controllers comment. Start
  `apps/api/test/topic-requests.e2e-spec.ts` with: submit succeeds and lands
  `pending` at `upvote_count = 0`; the board lists it anonymously; the board
  payload contains **no user id and no email**; an admin-web cookie on `POST
  /topic-requests` is `401`; an anonymous POST is `401`; an owner and an admin
  with a *learner-named* cookie are `403 FORBIDDEN_ROLE`; and a test named for
  the deliberate absence of a guard on the board.
  - done when: `pnpm --filter @knowledge-explorer/api test topic-requests` green,
    and `curl localhost:3001/api/topic-requests` with no cookie returns the open
    group rather than a 403.

- [x] **Task 3: the board page and the submission form**
  `apps/learner-web/lib/request-types.ts`; `app/requests/page.tsx` as a
  `force-dynamic` server component reading through **`serverApiFetch`** (not bare
  `apiFetch` — a server fetch has no cookie jar and the failure is invisible);
  `components/requests/submit-form.tsx` as a client component surfacing the
  server's `errorCode`; a `/requests` link in `app/layout.tsx`. Vietnamese copy
  inline, no catalogue. Signed out, the form is replaced by a `/signin` link.
  NFR-09: no horizontal scroll at 360 px, side gutter from one wrapper.
  - done when: with the API and learner-web running, an anonymous visit to
    `localhost:3002/requests` renders the open group and a sign-in prompt; a
    signed-in learner submits through the form and the new title appears on
    reload; `pnpm --filter @knowledge-explorer/learner-web typecheck` green.

## Slice C — Voting

- [x] **Task 4: the toggle, and the counter invariant**
  `vote(requestId, userId)` in the public service: one `prisma.$transaction`,
  `create` + `{ increment: 1 }` or `delete` + `{ decrement: 1 }`, returning
  `{ upvoteCount, viewerHasVoted }`. `POST /topic-requests/:requestId/vote` on the
  learner controller. Refusals: `404 TOPIC_REQUEST_NOT_FOUND`, `409
  TOPIC_REQUEST_NOT_PENDING` on any non-pending request, `409 TOPIC_REQUEST_OWN`
  on the caller's own. Tests: the three refusals; a full on-off-on cycle with the
  count checked each time; and **a burst of at least eight concurrent toggles
  asserting the endpoint never 500s and `upvote_count === COUNT(topic_request_votes)`
  when they settle**.
  - done when: `pnpm --filter @knowledge-explorer/api test topic-requests` green
    including the concurrency test. Confirm the test has teeth: move the
    increment outside the transaction, watch it fail, then revert — a
    concurrency test that passes against a broken implementation is worse than
    no test.

- [x] **Task 5: the vote control**
  `components/requests/vote-button.tsx` — client component, `apiFetch` POST with
  `credentials: 'include'`, then `router.refresh()` so the server-rendered count
  re-reads. Renders as voted from `viewerHasVoted`; a `/signin` link when signed
  out; disabled with a visible reason on the caller's own request.
  - done when: in a browser, a signed-in learner clicks the control on someone
    else's request and the count moves up, clicks again and it moves back, and a
    manual reload shows the same state — proving the cookie reaches the server
    component.

## Slice D — The cap and withdrawal

- [x] **Task 6: cap, withdraw, and the learner's own list**
  Read `TOPIC_REQUEST_PENDING_CAP` (default 5) once; refuse a submission past it
  with `409 TOPIC_REQUEST_LIMIT_REACHED` carrying the cap and the caller's current
  pending count, in the same transaction as the insert.
  `DELETE /topic-requests/:requestId`: own **and** pending only; someone else's is
  `404`, not `403`; a non-pending own row is `409 TOPIC_REQUEST_NOT_PENDING`.
  `GET /me/topic-requests` returning every status the caller submitted plus
  `{ pendingCount, pendingCap }`. Then `app/me/requests/page.tsx` with the
  withdraw control on pending rows and the `n / cap` indicator. Add
  `TOPIC_REQUEST_PENDING_CAP=5` to `.env.example`.
  - done when: `pnpm --filter @knowledge-explorer/api test topic-requests` green,
    and in a browser a learner at five pending requests sees the form refuse with
    the server's message, withdraws one, and submits successfully.

## Slice E — The owner rules on the queue

- [x] **Task 7: the review endpoints**
  `apps/api/src/topic-requests/topic-requests-admin.{controller,service}.ts`.
  `GET /admin/topic-requests?status=&sort=&page=&pageSize=` — `status` defaults to
  `pending` and accepts any `requestStatuses` member or `all`; `sort` is `upvotes`
  (default) or `newest`; each row carries `requestedByEmail`, the `duplicateOf`
  summary and `linkedCourse`. `PATCH /admin/topic-requests/:requestId` as a zod
  discriminated union on `requestStatus` per the spec's table; a refused body
  writes **nothing**; `pending` reopens and clears `linked_course_id`,
  `duplicate_of_request_id` and `reviewer_note`; `reviewed_by_user_id` is written
  from the session on every success. `duplicateOfRequestId` is refused when
  unknown, when it is the row itself, or when that row is already `duplicated`.
  Tests: every refusal, the write-nothing guarantee, the reopen clear, and that a
  learner and a plain admin both get `403 FORBIDDEN_ROLE` on both endpoints.
  - done when: `pnpm --filter @knowledge-explorer/api test topic-requests` green,
    and marking a request duplicate of another leaves **both** `upvote_count`
    values unchanged.

- [x] **Task 8: the admin queue screen**
  `apps/admin-web/lib/topic-request-types.ts` and
  `app/(portal)/topic-requests/page.tsx`: status filter, sort control, and a
  per-row review form whose course picker and request picker enable by the
  selected status, so an impossible body cannot be constructed in the UI. A
  `duplicated` row whose target was withdrawn renders as "duplicate of a
  withdrawn request" rather than throwing. Nav link in
  `app/(portal)/layout.tsx`. English copy; NFR-09 at 1280 px and wider.
  - done when: an owner accepts, rejects and marks-duplicate three requests
    through the screen and each outcome appears on `localhost:3002/requests`;
    `pnpm --filter @knowledge-explorer/admin-web test:e2e` still green.

## Slice F — The rest of the board

- [x] **Task 9: the built and closed groups**
  Extend `board` to return all three groups with per-group totals: `built` is
  `accepted`, carrying the linked course's `slug` and `title` **only when that
  course is `published`**; `closed` is `rejected` and `duplicated` with
  `reviewerNote`, its `items` empty unless `includeClosed=true` and its `total`
  always present. `open` alone takes `page`/`pageSize`, bounded by
  `DEFAULT_PAGE_SIZE`/`MAX_PAGE_SIZE` from `catalog.service.ts`. Render the
  sections on `/requests` with `?closed=1` as a server-rendered expansion — no
  client state. Add `seedLearner` and `learnerCookie` to
  `apps/learner-web/e2e/helpers.ts`.
  - done when: `pnpm --filter @knowledge-explorer/api test topic-requests` green
    including a test that an accepted request linked to a **draft** course shows
    as built with no link; visiting `/requests?closed=1` renders the closed
    section with its reviewer notes.

- [x] **Task 10: the browser scenario**
  `apps/learner-web/e2e/topic-requests.spec.ts` — the spec's thirteen steps, with
  the published link target seeded directly through Prisma (a `courses` row plus
  a minimal `published_course_structures` row), not through `seed.ts`'s authoring
  pipeline. Step 5's concurrent burst, step 11's `SET NULL` path and step 13's
  live-not-cached reload are the three that cannot be moved to the api suite.
  - done when: `pnpm --filter @knowledge-explorer/learner-web test:e2e` green
    with both the P7 and P9 spec files running in the same suite.

- [x] **Task 11: full verification and notes**
  `pnpm verify` across the monorepo; both browser suites; re-run
  `packages/database` to confirm task 1's DDL survived every later change. Record
  implementation notes at the foot of this file: what was decided while building
  that the plan did not anticipate, anything the spec got wrong, and any gap left
  open.
  - done when: `pnpm verify` exits 0, `pnpm --filter
    @knowledge-explorer/learner-web test:e2e` and `pnpm --filter
    @knowledge-explorer/admin-web test:e2e` both green, and this file carries its
    notes section.

---

## Implementation notes

Recorded at completion. Five things were decided while building that the plan
did not anticipate, and one test was wrong before it was right.

**The concurrency test had a blind spot, and the mutation check is what found
it.** The first version fired eight simultaneous toggles from ONE learner and
asserted the counter. It passed against a deliberately broken implementation —
a read-modify-write of `upvote_count` outside the transaction — because the vote
row's primary key `(topic_request_id, user_id)` already serializes every write
for a single voter, so the counter never actually races. The test that bites uses
EIGHT DIFFERENT learners on one request: no key stands between them, and the
broken version recorded 3 votes out of 8. Both tests are kept — the single-caller
one covers the P2002 collision path, the multi-caller one covers the counter.
Task 4's "confirm the test has teeth" step is the only reason this was caught.

**The course picker had to become searchable.** The plan assumed a dropdown of
courses. There is no admin course-list endpoint in §9 (the public catalog exposes
slugs, not the ids `linked_course_id` needs), so `courseOptions` was added to the
owner-only queue response — and then the development database turned out to hold
**3093 courses**, which a fixed top-N picker can never contain the right one of.
It is now bounded at the 50 NEWEST courses with a `courseSearch` query parameter
for everything older. Newest-first is the right default on its own terms:
accepting a request usually follows publishing the course that answers it.

**Two controllers in `public/`, not one.** As planned, split by auth model:
`PublicTopicRequestsController` (anonymous board, no guards) and
`TopicRequestsLearnerController` (class-level guards). Confirmed necessary —
`PublicMeController`'s pattern puts `@UseGuards` on the class, which would have
covered the board.

**The admin side went to `apps/api/src/topic-requests/`**, as the plan proposed
rather than the spec's `content/`. Nothing about the build changed that judgement.

**Two refusals report `INVALID_BODY`, not a topic-request code.** Sending
`linkedCourseId` with a non-accepted status, or `duplicateOfRequestId` with a
non-duplicated one, is a malformed body — not a missing course and not an invalid
duplicate target. Reusing `TOPIC_REQUEST_LINKED_COURSE_NOT_FOUND` there would
tell a client the course is gone when it is fine.

**`mine()` counts pending rows rather than deriving the number from the list it
returns.** The list is capped at `MAX_BOARD_PAGE_SIZE`; a learner with more
reviewed requests than that would otherwise be shown a pending count lower than
the truth and then refused on submit with no explanation.

**Unchanged, as predicted:** `packages/shared/src/roles.ts` and `enums.ts` needed
no edit — both permission actions and all four `requestStatuses` members were
already declared and had simply never been referenced. No queue, no job type, no
`job-permissions.ts` row, no `packages/commerce` import, no revalidation hook, no
CORS or cookie change.

**Verification at completion:** `pnpm verify` green (10 turbo tasks, 461 api
tests across 21 files); `packages/database` 40 tests including the five new DDL
assertions; `pnpm --filter @knowledge-explorer/learner-web test:e2e` 13 passed
(12 from P7, 1 from P9); `pnpm --filter @knowledge-explorer/admin-web test:e2e`
17 passed; `prisma migrate status` reports no drift.
