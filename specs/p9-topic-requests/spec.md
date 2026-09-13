# Spec: P9 — Topic requests

**Status:** Approved
**Date:** 2026-09-13

Derived from `knowledge-explorer-spec.md` §12 phase P9 — *"Submission, voting,
owner review queue."* That document is the product source of truth and is locked
except §14; this spec adds only the implementation decisions P9 requires and the
product spec does not make. It opens no §14 decision and closes none.

**It takes P9 out of §12's order, before P8.** P9 has no commerce dependency:
submitting and voting need a learner account (P7), and linking an accepted
request to a course needs `courses` (P1). Nothing in this phase reads
`access_grants`, `products` or `payment_orders`, calls `hasAccessToCourse`, or
touches `packages/commerce`. It assumes `specs/p0-foundation/` through
`specs/p7-learner/` are delivered, which as of this writing they are.

## Problem statement

Two tables have been in the schema since P0's initial migration and no line of
code has ever read or written either. `topic_requests` and
`topic_request_votes` exist with their full §8 column set and their foreign keys,
and a search for `TopicRequest` across every `.ts` and `.tsx` file in `apps/`
and `packages/` returns nothing but the Prisma model's own declaration. Two of
the sixteen rows in §3's permission matrix —
`reviewTopicRequests` and `submitAndUpvoteTopicRequests` — are declared in
`packages/shared/src/roles.ts`, asserted cell-by-cell in
`packages/shared/test/policy.spec.ts`, and referenced by no endpoint.
`requestStatuses` is declared in `packages/shared/src/enums.ts` and imported
nowhere but `enumColumns`. FR-REQ-01 is the last functional requirement in §5
with no code behind it.

So the phase is small — §12 budgets half a week — but three things about it are
new, and each is a way to get it quietly wrong.

**It is the first learner-authored content that another learner reads.** Every
learner write so far is `lesson_progress`, which is private to its author and
readable only through `/me/courses`. A topic request is shared mutable state,
written by an untrusted caller, rendered on a page an anonymous visitor can
open. Nothing in the system has had that shape before, which is why this spec
spends more of its length on what the public endpoint *refuses to serialize*
than on what it returns.

**It introduces the system's first denormalized counter.** `upvote_count` on
`topic_requests` duplicates `COUNT(*)` over `topic_request_votes`. Every other
count in the codebase is computed at read time — progress percentages, catalog
level counts, the snapshot's `totalLessonCount`. §8 put this one in the table, so
it is kept, but a stored counter that drifts from its source is a defect with no
symptom until the owner sorts the queue by it. The transaction boundary and the
test that holds it are acceptance criteria here, not implementation detail.

**It is the first public write surface with no payment in front of it.** §9.4's
closing line — "the public API contains no endpoint that calls an LLM, an image
generator or a TTS provider… it removes any path for anonymous traffic to spend
money" — still holds trivially, because P9 calls no provider at all. But
unlimited rows from an unlimited number of free accounts is the cheaper version
of the same problem, and no rate limiting exists anywhere in the system to
inherit.

## Acceptance criteria

### The endpoint surface

| Method | Path | Auth | Behaviour |
|---|---|---|---|
| GET | `/api/topic-requests` | optional | The board: open, built and closed groups with counts. **Not in §9.4** |
| POST | `/api/topic-requests` | learner | FR-REQ-01: submit a request |
| DELETE | `/api/topic-requests/:requestId` | learner | Withdraw own request while pending. **Not in §9.4** |
| POST | `/api/topic-requests/:requestId/vote` | learner | FR-REQ-01: toggle an upvote |
| GET | `/api/me/topic-requests` | learner | The caller's own requests and remaining cap. **Not in §9.4** |
| GET | `/api/admin/topic-requests` | owner | §9.2: the review queue |
| PATCH | `/api/admin/topic-requests/:requestId` | owner | §9.2: accept, reject or mark duplicate |

- **"optional" means `resolveOptionalSession`** (`apps/api/src/auth/optional-session.ts`),
  exactly as the reader and media endpoints use it: a session when a learner
  cookie is present, anonymous when it is not, never a rejection. The controller
  carries **no `@UseGuards` and no `@RequirePermission`**, and that absence is
  asserted by a named test so a later reader does not "fix" it — the same
  treatment `PublicCatalogController` gets.
- **"learner" means `@UseGuards(LearnerSessionGuard, RolesGuard)` with
  `@RequirePermission('submitAndUpvoteTopicRequests')`.** §3 gives that action to
  `learner` alone, so an owner or admin signed into admin-web receives `403
  FORBIDDEN_ROLE` — and in practice `401 UNAUTHENTICATED` first, because
  admin-web's cookie has a different name and `LearnerSessionGuard` reads only
  learner-web's. Both refusals are asserted.
- **"owner" means `@UseGuards(SessionGuard, RolesGuard)` with
  `@RequirePermission('reviewTopicRequests')`** on `@Controller('admin/topic-requests')`,
  the shape `AdminsController` already has.
- **`PublishedLockGuard`, `AssignmentGuard` and `OwnerFieldGuard` are absent, and
  that is correct.** All three resolve a course from the write target through
  `WriteTargetResolver`; a topic request has no course. Setting `linkedCourseId`
  to a **published** course is not a write to that course, so R-01 does not fire
  — a point worth the comment it will get in the controller, because it looks
  like an omission.
- Every body and query string is validated with zod `strictObject` in the
  controller; every error carries an `errorCode` from `packages/shared/src/errors.ts`.

### Three endpoints §9 does not list

§9.2's two owner endpoints and §9.4's two learner endpoints are implemented as
written. Three more are added, because FR-REQ-01 is not reachable without them.
Each is recorded here rather than assumed:

1. **`GET /topic-requests`.** §9.4 gives learners `POST /topic-requests` and
   `POST /topic-requests/:requestId/vote` and no way to list anything. Without a
   read endpoint a learner can never encounter a request to upvote, and half of
   FR-REQ-01 — "learners upvote requests" — is unimplementable. It is anonymous,
   matching the rest of §9.4's read surface: a visitor seeing what other people
   have asked for is the board's argument for signing up.
2. **`DELETE /topic-requests/:requestId`.** A consequence of the per-user cap
   below. A learner who holds five pending requests and cannot withdraw one is
   stuck until the owner reviews the queue, with no recourse for a misfire.
3. **`GET /me/topic-requests`.** A consequence of the board carrying no
   attribution. With no submitter field on the public board, a learner has no
   way to find their own rows, and the DELETE above is unreachable from any UI.
   This endpoint returns only the caller's own rows and requires a learner
   session, so it adds no visibility that the board withholds.

### FR-REQ-01 — submission

- `POST /topic-requests` body: `{ requestedTopicTitle, requestDescription? }`.
  `requestedTopicTitle` is trimmed, 3–120 characters; `requestDescription` is
  trimmed, at most 1000, and stored as `null` when absent or empty. Bounds are
  the controller's, not the column's — §8 types both as `TEXT`.
- The row is created with `request_status = 'pending'`, `upvote_count = 0` and
  `requested_by_user_id` from the session. **A new request starts at zero, not
  one**, because a learner may not vote on their own request (below).
- **Cap: a learner may hold at most `TOPIC_REQUEST_PENDING_CAP` requests in
  `pending` at once, default 5.** A sixth returns `409` with
  `TOPIC_REQUEST_LIMIT_REACHED`; the response carries the cap and the caller's
  current count so the form can say what happened. Rows the owner has already
  accepted, rejected or marked duplicate do not count against it, so the cap
  clears as the queue is reviewed and again when a request is withdrawn.
- The cap is read and the row is inserted in one transaction. Two simultaneous
  submissions from one learner at the boundary may both land; the cap is an
  abuse brake, not an invariant, and a sixth row is not a correctness failure.
  Recorded so a later reader does not add a lock for it.

### FR-REQ-01 — voting

- `POST /topic-requests/:requestId/vote` **toggles**: if the caller holds no vote
  it inserts a `topic_request_votes` row and increments `upvote_count`; if they
  do, it deletes the row and decrements. Response:
  `{ upvoteCount, viewerHasVoted }`.
- **Refused on any request that is not `pending`** — `409
  TOPIC_REQUEST_NOT_PENDING`. Once the owner has ruled on a request the count is
  a record of the demand that produced the decision, and must stop moving.
- **Refused on the caller's own request** — `409 TOPIC_REQUEST_OWN`. The count is
  what the owner reads as demand from other people; a submitter voting for
  themselves makes every request's floor 1 and measures nothing.
- Unknown `requestId` → `404 TOPIC_REQUEST_NOT_FOUND`.
- **The vote row and the counter move in one `prisma.$transaction`**, with the
  counter written as `{ increment: 1 }` / `{ decrement: 1 }` rather than a
  read-modify-write. The composite primary key `(topic_request_id, user_id)` is
  what makes "one vote per user per request" true; the counter is a cache of it.
  Under concurrent toggles a losing transaction fails on the primary key and
  rolls back whole, taking its increment with it.
- **`upvote_count === COUNT(topic_request_votes)` is an asserted invariant**, in
  the api suite after a burst of concurrent toggles and again at the end of the
  browser scenario. This is the one thing about P9 that can be wrong for months
  without a symptom.

### Withdrawal

- `DELETE /topic-requests/:requestId` succeeds only when the row's
  `requested_by_user_id` is the caller **and** its status is `pending`.
- A request belonging to someone else returns `404 TOPIC_REQUEST_NOT_FOUND`,
  indistinguishable from one that does not exist. A 403 would confirm the id is
  real and someone else's.
- A row the caller owns that is no longer pending returns `409
  TOPIC_REQUEST_NOT_PENDING`.
- Votes disappear with it: `topic_request_votes.topic_request_id` is already
  `ON DELETE CASCADE` in the initial migration.

### The board — `GET /topic-requests`

Three groups in one response, so the page renders in one round trip:

```
{
  open:   { items: [...], total, page, pageSize },   // pending
  built:  { items: [...], total },                   // accepted
  closed: { items: [...], total }                    // rejected + duplicated
}
```

- **`open`** is `pending`, ordered by `upvote_count` descending then `created_at`
  descending, paginated by `page` / `pageSize` with the catalog's bounds
  (`DEFAULT_PAGE_SIZE`, `MAX_PAGE_SIZE` from `catalog.service.ts`).
- **`built`** is `accepted`, newest first. Each item carries the linked course's
  `slug` and `title` when `linked_course_id` is set **and that course is
  `published`** — an accepted request pointing at a course still in draft shows
  as built with no link rather than as a dead link into a 404. Capped at
  `MAX_PAGE_SIZE`, not paginated.
- **`closed`** is `rejected` and `duplicated`, newest first, carrying
  `reviewerNote`. `items` is empty unless `includeClosed=true`; `total` is always
  present so the collapsed header can show a count. Capped at `MAX_PAGE_SIZE`,
  not paginated — a known bound, recorded rather than solved, and the reason
  `closed` is the group least likely to need it.
- **No submitter identity is serialized, ever.** The item shape is
  `{ id, requestedTopicTitle, requestDescription, requestStatus, upvoteCount,
  createdAt, linkedCourse?, reviewerNote?, viewerHasVoted, viewerIsRequester }`
  and contains no user id, email or display name. `users.display_name` is null
  for every magic-link learner anyway, but the reason for the rule is that the
  field will hold an email the day someone backfills it.
- **`viewerHasVoted` and `viewerIsRequester` describe the caller, not the
  submitter.** Both are derived server-side from the caller's own session and
  are `false` for everyone when anonymous. They tell a signed-in learner whether
  their vote button is filled and why it is disabled on one row; they reveal
  nothing about anybody else. The distinction is the whole of the attribution
  decision and belongs in a comment on the serializer.

### `GET /me/topic-requests`

Returns the caller's own rows — every status, newest first — each carrying its
status, count, `reviewerNote`, linked course and whether it may still be
withdrawn, plus `{ pendingCount, pendingCap }` so the page can say "2 of 5 slots
used" before the form refuses.

### §9.2 — the owner review queue

- `GET /admin/topic-requests?status=&sort=&page=&pageSize=`.
  `status` defaults to `pending` and accepts any `requestStatuses` member or
  `all`; `sort` is `upvotes` (default, descending, then newest) or `newest`;
  pagination matches the catalog's bounds.
- **This is the only endpoint that serializes the submitter**, as
  `{ requestedByEmail }`, and the only place §3's `reviewTopicRequests` is
  exercised. The owner needs it to recognise one person filing five variations
  of the same topic. A row also carries its `duplicateOf` summary
  (`{ id, requestedTopicTitle }`) and its `linkedCourse`, so the queue renders
  the whole relationship without a second call.
- `PATCH /admin/topic-requests/:requestId` takes **one body, validated per
  status** — a zod discriminated union on `requestStatus`:

  | `requestStatus` | Required | Permitted | Refused |
  |---|---|---|---|
  | `accepted` | — | `linkedCourseId`, `reviewerNote` | `duplicateOfRequestId` |
  | `rejected` | `reviewerNote` (3–1000) | — | `linkedCourseId`, `duplicateOfRequestId` |
  | `duplicated` | `duplicateOfRequestId` | `reviewerNote` | `linkedCourseId` |
  | `pending` | — | — | `linkedCourseId`, `duplicateOfRequestId`, `reviewerNote` |

  The `pending` case reopens a request the owner has already ruled on, and
  **clears all three of `linked_course_id`, `duplicate_of_request_id` and
  `reviewer_note`** — a reopened request carries no ruling, and a stale note
  under a pending status reads as a decision that was not made. It is the one
  case where the PATCH nulls columns the body did not mention, which is why the
  body may not mention them.

  A body that fails a refinement is `400` and writes **nothing** — the whole
  request is refused rather than the valid half applied, which is
  `OwnerFieldGuard`'s principle applied inside the schema, since no guard can
  see across fields like this.
- Error codes: `TOPIC_REQUEST_NOT_FOUND`, `TOPIC_REQUEST_NOTE_REQUIRED`,
  `TOPIC_REQUEST_DUPLICATE_TARGET_REQUIRED`,
  `TOPIC_REQUEST_DUPLICATE_TARGET_INVALID` (unknown id, itself, or a request
  already `duplicated` — no chains), `TOPIC_REQUEST_LINKED_COURSE_NOT_FOUND`.
- `reviewed_by_user_id` is written from the session on every successful PATCH,
  including a reopen.
- **Marking a duplicate does not move any votes.** The two requests keep their
  own counts and the column records the relationship. Vote merging is a non-goal
  below; the column is what would make it possible later.

### The schema change — one new migration

`request_status` has the value `duplicated` and the row has nowhere to say what
it duplicates. §8 gives `linked_course_id` and `reviewer_note`; neither points at
a request. One new migration adds the column:

```sql
-- packages/database/prisma/migrations/<timestamp>_add_topic_request_duplicate_of/
ALTER TABLE "topic_requests"
  ADD COLUMN "duplicate_of_request_id" UUID;

ALTER TABLE "topic_requests"
  ADD CONSTRAINT "topic_requests_duplicate_of_request_id_fkey"
  FOREIGN KEY ("duplicate_of_request_id") REFERENCES "topic_requests"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;

CREATE INDEX "idx_topic_requests_board"
  ON "topic_requests" ("request_status", "upvote_count" DESC);
CREATE INDEX "idx_topic_requests_requested_by"
  ON "topic_requests" ("requested_by_user_id");
```

- **A new migration, never a regeneration.** `20260911180121_init/migration.sql`
  carries six partial unique indexes, one partial index and two CHECK
  constraints hand-appended below its generated section; `prisma migrate dev`
  would drop them and `prisma migrate diff` reports no difference either way
  (CLAUDE.md invariant 1). `20260912165304_add_course_voice_and_audio_segment_checksum`
  is the shape to copy.
- **`ON DELETE SET NULL`, against §8's stated `NoAction` default, deliberately.**
  A learner may withdraw a pending request, and that request may be the target of
  a duplicate the owner recorded. Under `NoAction` the withdrawal fails with a
  foreign-key error and a 500 the learner cannot act on. Under `SET NULL` the
  duplicate keeps its status and loses its pointer. The cost is real and is
  stated rather than hidden: the PATCH refinement guarantees a `duplicated` row
  points at something *at the moment of review*, not forever, and the queue
  renders a null target as "duplicate of a withdrawn request". The rejected
  alternative — refusing the withdrawal with a 409 — was worse, because it blocks
  a learner on a relationship they cannot see and cannot undo.
- **Two indexes, because the board is uncached.** `idx_topic_requests_board`
  serves the board's and the queue's ordering; `idx_topic_requests_requested_by`
  serves the cap check and `/me/topic-requests`. Postgres creates neither
  automatically — Prisma indexes relation fields only where the connector does,
  and the initial migration created no index on this table at all.
- `packages/database/test/constraints.spec.ts` gains assertions for the new
  foreign key, its `SET NULL` action, and both indexes. That suite is the only
  guard on hand-written DDL in this repository.

### The screens

**learner-web, Vietnamese copy, inline, no catalogue** — matching
`app/layout.tsx`'s stated reason.

- `app/requests/page.tsx` — **`export const dynamic = 'force-dynamic'`**. Vote
  counts change constantly and the response varies per viewer
  (`viewerHasVoted`), so the page is server-rendered on every visit. It takes no
  ISR `revalidate`, and **publishing a course does not revalidate it** — the
  existing `/api/revalidate` hook is not extended.
  - Open requests with a vote control; built requests linking into the course;
    a closed section that expands via `?closed=1` on the same route, so the
    expansion is server-rendered and needs no client state.
  - Signed out, the vote control is a link to `/signin` rather than a disabled
    button.
  - A submission form for signed-in learners, refusing at the cap with the
    server's message.
  - NFR-09: readable and non-scrolling horizontally from 360 px.
- `app/me/requests/page.tsx` — own requests, withdraw control on pending rows,
  the cap indicator.
- `app/layout.tsx` nav gains a link to `/requests`.

**admin-web, English copy** — `app/(portal)/topic-requests/page.tsx`, the queue
with status filter and sort, each row expanding to the review form: status
radio, reviewer note, a course picker for `accepted` and a request picker for
`duplicated`, both disabled by the status the form is in so an impossible body
cannot be constructed. NFR-09: 1280 px and wider. `app/(portal)/layout.tsx` nav
gains the link.

## Non-goals

Named so the phase stays at §12's half-week and so each absence is a decision:

- **Notifying a requester of the outcome**, by email or in-app. `EmailProvider`
  is still `LogEmailProvider` writing to stdout and §7.5's real provider belongs
  to P8; P9 does not introduce the system's first outbound learner email. The
  board carries the outcome.
- **Merging votes into the original when marking a duplicate.** The column
  records the relationship; the counts stay separate. This is the follow-up the
  column makes possible, not part of this phase.
- **Rate limiting.** The per-user pending cap is the only brake. No general rate
  limiter exists anywhere in the system and P9 does not introduce the first one.
- **Editing a submitted request.** Title and description are fixed at
  submission; the remedy for a mistake is withdraw-and-resubmit while pending.
  Editing text that other people have already upvoted changes what they voted
  for.
- **Text moderation** — no profanity filter, no spam classification, no
  duplicate-title detection at submission time. The owner's queue is the filter.
- **Anonymous submission or voting.** Both columns are `NOT NULL` references to
  `users`; §3 gives both actions to `learner` alone.
- **Attribution on the public board**, including a pseudonym, an avatar or a
  vote-count-by-user view.
- **Comments, discussion or replies** on a request.
- **Owner-authored requests**, and owner editing of a learner's title or
  description. The owner rules on requests; they do not write them.
- **Sorting or filtering the public board** by anything beyond its fixed
  grouping and ordering.
- **Any commerce coupling.** No entitlement check, no product, no grant, no
  `packages/commerce` import. Requesting a topic is not gated on owning
  anything, and P9 adds nothing P8 must later unpick.
- **A `topic_request` job type or queue.** P9 calls no provider, spawns no job,
  and adds no row to `apps/api/src/jobs/job-permissions.ts`.

## Constraints

- **Node 22 is mandatory** (`nvm use`); under Node 20 vitest dies with a rolldown
  native binding error. **ffmpeg and ffprobe** are required for the browser
  suite, which spawns `apps/worker`, and the worker refuses to boot without
  them.
- **CLAUDE.md invariant 1**: never regenerate
  `20260911180121_init/migration.sql`. The `duplicate_of_request_id` column
  arrives in a new migration directory.
- **CLAUDE.md invariant 4**: `emitDecoratorMetadata` is `false`; every injection
  is an explicit `@Inject(Token)`.
- Deny-by-default holds: both admin endpoints declare a permission; the public
  GET declares none **and a test named for that absence asserts it**, alongside
  `UndeclaredPolicyFixtureController`'s permanent `FORBIDDEN_NO_POLICY` check
  (invariant 2).
- Database columns `snake_case`, TypeScript and JSON `camelCase`, bridged by
  `@map`. Enum-like columns stay `String`; `requestStatusSchema` in
  `packages/shared/src/enums.ts` is the only definition of the four values and is
  imported rather than re-declared.
- Every error carries an `errorCode`; new codes are added to
  `packages/shared/src/errors.ts` with the comment convention already there —
  what happened and which spec section says so.
- Request bodies and query strings are zod `strictObject` in the controller, so
  a typo'd field fails loudly.
- Tests live in a per-workspace `test/` directory, never beside the source;
  `*.e2e-spec.ts` for suites that boot an app. Both globs are listed explicitly
  in the api vitest config and `fileParallelism` is `false` there.
- `pnpm lint` matches no package script and does nothing; `pnpm verify` —
  typecheck plus test — is the gate.
- CORS, the two session cookie names, and `apps/api/src/main.ts`'s allowlist are
  unchanged. P9 adds no origin and no cookie.
- No new environment variable except `TOPIC_REQUEST_PENDING_CAP`, which defaults
  to 5 and is documented in `.env.example`.

## Affected files and interfaces

**New**

| Path | Purpose |
|---|---|
| `packages/database/prisma/migrations/<ts>_add_topic_request_duplicate_of/migration.sql` | The column, its `SET NULL` foreign key, two indexes |
| `apps/api/src/public/topic-requests.controller.ts` | `GET /topic-requests` (no guard), `POST`, `DELETE`, `POST /:id/vote`, `GET /me/topic-requests` |
| `apps/api/src/public/topic-requests.service.ts` | Board query and grouping, the toggle transaction, the cap, the viewer-scoped fields |
| `apps/api/src/content/topic-requests-admin.controller.ts` | §9.2's queue and review PATCH |
| `apps/api/src/content/topic-requests-admin.service.ts` | Queue filtering and sorting, the per-status write |
| `apps/api/test/topic-requests.e2e-spec.ts` | Roles, cap, toggle, own-request and non-pending refusals, the counter invariant under concurrency, the no-attribution assertion |
| `apps/learner-web/app/requests/page.tsx` | The board, `force-dynamic` |
| `apps/learner-web/app/me/requests/page.tsx` | Own requests, withdraw, cap indicator |
| `apps/learner-web/e2e/topic-requests.spec.ts` | The cross-app scenario below |
| `apps/admin-web/app/(portal)/topic-requests/page.tsx` | The review queue and form |

**Modified**

| Path | Change |
|---|---|
| `packages/database/prisma/schema.prisma` | `TopicRequest` gains `duplicateOfRequestId`, its self-relation, and the two `@@index` declarations |
| `packages/database/test/constraints.spec.ts` | Assertions for the new foreign key, its `SET NULL` action, and both indexes |
| `packages/shared/src/errors.ts` | `TOPIC_REQUEST_NOT_FOUND`, `TOPIC_REQUEST_NOT_PENDING`, `TOPIC_REQUEST_OWN`, `TOPIC_REQUEST_LIMIT_REACHED`, `TOPIC_REQUEST_NOTE_REQUIRED`, `TOPIC_REQUEST_DUPLICATE_TARGET_REQUIRED`, `TOPIC_REQUEST_DUPLICATE_TARGET_INVALID`, `TOPIC_REQUEST_LINKED_COURSE_NOT_FOUND` |
| `apps/api/src/app.module.ts` | Four registrations: two controllers, two services. The public controller joins the commented public block, and the comment gains it |
| `apps/learner-web/app/layout.tsx` | Nav link to `/requests` |
| `apps/admin-web/app/(portal)/layout.tsx` | Nav link to `/topic-requests` |
| `apps/learner-web/e2e/helpers.ts` | `seedLearner` and `learnerCookie`, the twins of `seedStaff` and `adminCookie`. The scenario asserts refusals (409, 404, 401) straight against the API, and no helper mints a learner session without driving a browser sign-in |
| `.env.example` | `TOPIC_REQUEST_PENDING_CAP=5` |

**Read, not modified**

`isAllowed` / `permissionMatrix` (`packages/shared/src/roles.ts:107,112`) — both
actions are already declared and need no change; `requestStatusSchema`
(`packages/shared/src/enums.ts:78`); `LearnerSessionGuard`
(`apps/api/src/auth/learner-session.guard.ts`), `SessionGuard`, `RolesGuard`,
`RequirePermission`; `resolveOptionalSession`
(`apps/api/src/auth/optional-session.ts`); `DEFAULT_PAGE_SIZE` / `MAX_PAGE_SIZE`
(`apps/api/src/public/catalog.service.ts`); `apps/learner-web/e2e/helpers.ts`'s
`seedStaff`, `signInAsLearner` and `adminCookie`, and `e2e/seed.ts`'s
authoring-and-publishing helper, for the linked course.

## End-to-end verification

**`pnpm --filter @knowledge-explorer/learner-web test:e2e`** — a new
`e2e/topic-requests.spec.ts` in the learner browser suite, which already boots
api (`:3001`), admin-web (`:3000`) and learner-web (`:3002`) through `webServer`
and spawns the worker in `global-setup.ts`. P9's verification spans both apps —
a learner submits, an owner rules, the learner sees the outcome — so it belongs
in the only suite that runs both.

One scripted scenario, asserted end to end:

1. **Seed.** An owner, a plain admin, and two learners (A and B) through
   `helpers.ts`. One published course through `seed.ts`, for the accept step.
   Open `/requests` anonymously — the empty state renders, no error.
2. **Submit.** Learner A submits "Korean TOPIK I" with a description. Assert the
   row is `pending` with `upvote_count = 0` — **zero, not one**. Reload
   `/requests` anonymously: the title and description appear under open
   requests, and **assert neither learner's email nor any user id appears
   anywhere in the page source**.
3. **Own-request refusal.** A votes on their own request → `409
   TOPIC_REQUEST_OWN`; assert the count is still 0.
4. **Toggle.** B votes → `{ upvoteCount: 1, viewerHasVoted: true }` and the
   control renders as voted. B votes again → `{ upvoteCount: 0, viewerHasVoted:
   false }`. B votes once more → 1. After each, assert
   `upvote_count === COUNT(topic_request_votes)`.
5. **Counter under concurrency.** Fire eight simultaneous toggles from B against
   the same request. Assert the endpoint never 500s and that
   `upvote_count === COUNT(topic_request_votes)` when they settle. This is the
   assertion the denormalized counter exists to need.
6. **Cap.** A submits four more (five pending), then a sixth → `409
   TOPIC_REQUEST_LIMIT_REACHED` carrying the cap and the current count.
   `/me/requests` shows "5 / 5".
7. **Withdraw.** A withdraws one pending request → `204`. Assert it is gone from
   the board, its vote rows are gone, and the sixth submission now succeeds.
   B attempts to withdraw one of A's → `404`, indistinguishable from a
   non-existent id, and the row still exists.
8. **Duplicate, and its refusal.** B submits a near-duplicate. The owner opens
   admin-web `/topic-requests`: the queue is sorted by upvotes with A's request
   on top and shows A's email. Marking B's as `duplicated` with no target →
   `400 TOPIC_REQUEST_DUPLICATE_TARGET_REQUIRED`; pointing it at itself → `400
   TOPIC_REQUEST_DUPLICATE_TARGET_INVALID`; pointing it at A's → `200`. Assert
   **both counts are unchanged** — votes are not merged.
9. **Reject.** The owner rejects a third request with no note → `400
   TOPIC_REQUEST_NOTE_REQUIRED` **and assert the row is untouched**, still
   `pending`. With a note → `200`, and the note appears in the board's closed
   section after `?closed=1`.
10. **Accept and link.** The owner accepts A's request with the seeded published
    course. The board's built section shows it, **and the link opens that
    course's page on `:3002`**. Voting on it now → `409
    TOPIC_REQUEST_NOT_PENDING`.
11. **`SET NULL`, exercised.** The owner marks request C duplicate of pending
    request D. Learner A withdraws D. Assert the delete **succeeds**, that C is
    still `duplicated`, and that its `duplicate_of_request_id` is null — the
    failure mode `NoAction` would have produced is a 500 with no other symptom.
12. **Roles.** The plain admin calls `GET /api/admin/topic-requests` → `403
    FORBIDDEN_ROLE`. A learner calls it → `403`. The owner, signed into
    admin-web, calls `POST /api/topic-requests` → `401 UNAUTHENTICATED`,
    because they carry no learner cookie — the two-cookie split from P7, still
    holding. An anonymous `POST /api/topic-requests` → `401`.
13. **Live, not cached.** Cast a vote and reload `/requests` immediately. The
    count is current with no wait, proving `force-dynamic` and that no ISR
    window sits in front of the board.

Plus **`pnpm verify`** (typecheck + test) green across the monorepo, including
`apps/api/test/topic-requests.e2e-spec.ts` and the extended
`packages/database/test/constraints.spec.ts`, and
`pnpm --filter @knowledge-explorer/admin-web test:e2e` still green.

## Open questions

None blocking. Four items are recorded as deliberately deferred rather than
unresolved:

- **Vote merging when marking a duplicate.** The column added here is what makes
  it possible; the phase does not do it. Revisit if the owner finds the queue's
  ordering misleading because demand is split across near-identical rows.
- **A `duplicated` row whose target was later withdrawn** holds a null pointer.
  The write-time refinement is not a durable constraint, by the `SET NULL`
  decision above. Revisit only if the queue's "duplicate of a withdrawn request"
  state proves confusing in practice.
- **Pagination for the built and closed groups.** Both are capped at
  `MAX_PAGE_SIZE` with no page parameter. A named bound, not an oversight.
- **§14 is untouched.** P9 opens no decision and closes none; decisions 1–4 are
  unaffected by anything in this phase.
