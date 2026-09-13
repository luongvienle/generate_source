# Spec: P7 — Learner app

**Status:** Approved
**Date:** 2026-09-13

Derived from `knowledge-explorer-spec.md` §12 phase P7 — *"Catalog, category and
course pages, reader, player with highlight sync, progress, my courses."* That
document is the product source of truth and is locked except §14; this spec adds
only the implementation decisions P7 requires and the product spec does not make.
It assumes `specs/p0-foundation/` through `specs/p6-publishing/` are delivered,
which as of this writing they are. It opens no §14 decision and closes none —
decision 3 (number of free-preview lessons per course) becomes *configurable* here
rather than *decided*.

## Problem statement

P6 filled the published track and nothing reads it. `published_course_structures`
has rows, `lesson_contents.published_content_markdown` is populated, courses reach
`publication_status = 'published'` — and `apps/learner-web` is a two-file Next.js
shell whose page says the catalog arrives in P7. There is no public endpoint in
`apps/api` at all: every controller sits behind `SessionGuard, RolesGuard` and an
admin `@RequirePermission`. Seven phases have produced a product no learner can
open.

P7 is the phase where the two halves of the system meet, and three things about it
are unlike every phase before.

**It is the first code that serves an untrusted, unauthenticated caller.** Every
endpoint built so far denies by default and resolves an admin from the `sessions`
table. §9.4's public endpoints must serve anonymous traffic, which means the guard
chain that has held since P0 is deliberately *absent* from these controllers — a
property that must be asserted by a test rather than left as an absence someone
later mistakes for an oversight.

**It is the first phase that can leak something.** §7.3's E-01 is explicit:
`hasAccessToLesson` gates both the lesson endpoint and the media endpoint, and
"missing either one leaks paid audio". Entitlement is built here, in
`packages/commerce`, against an `access_grants` table that P8 will fill. Building
the reader first and the gate later is the shape of that leak, so the gate comes
first.

**It is the first phase whose output is judged by someone who cannot file a bug.**
Admins tolerate a rough edge; a learner closes the tab. NFR-09's "responsive from
360 px" and FR-LRN-02's resume behaviour are not polish items here.

Four concrete gaps in the existing code block §5.8 and must be closed in this
phase. Each was verified by reading the repository, not inferred.

- **`is_free_preview` has no writer.** `createLessonSchema`
  (`lessons.controller.ts:30`) and `updateLessonSchema` (`lessons.controller.ts:39`)
  both omit it, import does not set it, and no other PATCH accepts it. Every
  lesson in the database is `false`, so FR-LRN-01's free-preview branch and §7.3's
  `hasAccessToLesson` short-circuit are unreachable and untestable through the
  product. This is the same class of finding P6 recorded for
  `courses.cover_image_url`, and it is closed the same way.
- **`§9.4`'s `:mediaId` has no referent.** §8 defines no `media_assets` table.
  Audio is `lesson_audios.merged_audio_file_url` and figure images are
  `lesson_images.image_file_url`, and **both columns store object keys, not URLs**
  (`images.service.ts:51`: "Never `lesson_images.image_file_url`, which is a key").
  A reader that renders `image_file_url` into `<img src>` shows eight broken
  figures.
- **`packages/commerce` is a 0-byte `src/index.ts`.** §11 assigns it
  `PaymentProvider` *and* entitlement resolution. P7 fills the second half only.
- **CORS echoes exactly one origin.** `main.ts:21` sets
  `origin: process.env['AUTH_URL'] ?? 'http://localhost:3000'`, which is
  admin-web. Credentialed CORS cannot use `'*'`, so a learner-web on another port
  is refused by the browser today.

**P7 writes one migration or none, and the answer is none.** `lesson_progress`,
`access_grants`, `products` and every column §5.8 and §7.3 read already exist.
Playback speed, the one piece of state with no column, is a per-browser
preference and stays in `localStorage`. If an implementation reaches for SQL,
something has been misread — stop and re-check before writing it.

## Acceptance criteria

### Entitlement — §7.3, in `packages/commerce`, one implementation

- `packages/commerce/src/entitlement.ts` exports §7.3's three functions verbatim
  in behaviour: `isGrantActive(grant, now)`, `hasAccessToCourse(userId, courseId)`
  and `hasAccessToLesson(userId, lessonId)`. This is the **only** place an access
  decision is computed, for the reason §3 lives once in `roles.ts`: a rule
  recorded twice drifts.
- `isGrantActive` is pure and takes a row plus a clock, so the branch matrix
  (revoked, perpetual, within grace, past grace) is unit-tested without a
  database. **`revokedAt` is checked before `expiresAt`**, per §7.3's order:
  revocation "takes effect on the next request" (FR-COM-04) and must not be
  reachable only through an expiry comparison.
- **`userId` is `string | null`.** §7.3's `hasAccessToCourse` returns `true` for a
  free course without consulting `userId`, and `hasAccessToLesson` short-circuits
  on `isFreePreview` before any grant lookup — so anonymous access to free content
  is what §7.3 computes, not an addition. A `null` caller reaching the grant
  lookup resolves to no grants, never to an error.
- **The grant lookup bridges §7.3's pseudocode to the real schema.**
  §7.3 writes `{ scopeType: 'course', scopeId }`, but `access_grants` stores
  `scope_course_id` and `scope_category_id` as two nullable columns. The resolver
  reads the columns; it does not introduce a synthetic `scopeId`.
- §7.2's `all_current_and_future` bundle policy needs no code: a category-scoped
  grant is matched by the course's `category_id` at read time, so a course
  published later is covered with no job and no backfill.
- **E-02 holds: no status column, no expiry job, no write of any kind.** The
  package performs reads only.
- A dedicated test covers a grant whose `expiresAt` has passed but whose
  `gracePeriodDays` still covers now, and its mirror image one day later.

### Public API — §9.4, eight endpoints, no guard chain

A new `apps/api/src/public/` module. Its controllers carry **no `@UseGuards` and
no `@RequirePermission`** where §9.4 marks them public, and that absence is
asserted by a test named for it, so a later reader does not "fix" it. Where an
endpoint needs identity it resolves the session itself, described below.

| Method | Path | Auth | Behaviour |
|---|---|---|---|
| GET | `/api/categories` | anonymous | Categories with published-level counts, ordered by `display_order` |
| GET | `/api/categories/:slug` | anonymous | FR-CAT-02: levels ordered by `levelOrder`, each flagged published or in development; bundle offer if an active category product exists |
| GET | `/api/courses` | anonymous | FR-CAT-01: `publication_status = 'published'` only, filterable by category, searchable, paginated |
| GET | `/api/courses/:slug` | anonymous | FR-CAT-03: course metadata from `courses`, table of contents from the snapshot, price block if a product exists |
| GET | `/api/lessons/:lessonId` | optional | Published body, figure images, narration segments, audio timings — §7.3-gated |
| GET | `/api/media/:mediaId/signed-url` | optional | Short-lived URL for one `lesson_audios` row — §7.3-gated |
| GET | `/api/me/courses` | learner | Owned courses with progress, `expiresAt`, `daysRemaining` |
| PUT | `/api/lessons/:lessonId/progress` | learner | FR-LRN-02: completion, scroll and audio position |

- **"optional" means the endpoint resolves a session when a cookie is present and
  proceeds as anonymous when it is not.** It never rejects for lack of one; §7.3
  decides. A disabled account (`is_active = false`) resolves to anonymous rather
  than to an error, so a revoked staff account degrades to public access rather
  than a 500.
- **"learner" means `@UseGuards(SessionGuard, RolesGuard)` with
  `@RequirePermission('buyAccessReadListenTrackProgress')`.** §3 gives that action
  to `learner` alone, so a signed-in owner or admin receives `403 FORBIDDEN_ROLE`
  from `/me/courses` and from the progress write — which is what the locked matrix
  says, and is asserted rather than worked around.
- **Public reads carry no permission declaration at all, so role never enters
  them.** An owner browsing the catalog is an ordinary visitor whose grants are
  empty and who therefore sees the paywall on a paid course. Previewing
  *unpublished* work remains admin-web's job. `hasAccessToCourse` gains no role
  branch — it is the function E-01 protects.
- **Nothing anywhere reads the draft track.** No public endpoint selects
  `draft_content_markdown`, `draft_block_list` or a non-`published` course. A test
  asserts an unpublished and an `unpublished`-status course are both absent from
  the catalog and 404 by slug.
- `GET /courses` search is case-insensitive substring matching (Prisma `contains`
  with `mode: 'insensitive'`) across `courses.title`, `categories.display_name`
  and `courses.overview_summary`, ordered by category `display_order` then
  `level_order`. Offset pagination with a bounded page size; the response carries
  the total. No `tsvector`, no migration, no extension — Postgres ships no
  Vietnamese text-search configuration, so `simple` would reduce to this anyway.
- Every request body and query string is validated with zod `strictObject` in the
  controller; every error carries an `errorCode` from `packages/shared/src/errors.ts`.
  New codes: `LESSON_NOT_ENTITLED`, `MEDIA_NOT_FOUND`, `COURSE_NOT_PUBLISHED`.

### FR-LRN-01 — the reader, and what `GET /lessons/:lessonId` returns

- Response carries: the lesson's `published_block_list` (parsed through the
  existing block schema), its chapter and course context, previous/next lesson
  ids from the snapshot, the figure images, the narration segments and the audio
  timings — and **never** `published_content_markdown` as a second copy of the
  same content. The renderer reads the block list; §6.1 is explicit that figure
  and table numbers come from the stored block and are not recomputed.
- **Figure images arrive presigned in this payload**, as a `blockId → { url,
  captionText, alternativeText }` map matching `FigureImages`
  (`packages/content/src/types.ts:75`). The endpoint is already entitlement-gated
  and the renderer needs every image at first paint; N round trips before a figure
  appears is the alternative. Only `is_selected = true` rows are read, and only
  those whose `block_reference_id` appears in the **published** block list.
- The reader renders through `LessonBody` from
  `@knowledge-explorer/content/render` — the same component the admin preview uses,
  which is how FR-EDIT-01's "renders exactly what the learner will see" stays true
  by construction. **No learner-only renderer is written.** `learner-web`'s
  `next.config.ts` adds `@knowledge-explorer/content` to `transpilePackages`.
- A lesson the caller is not entitled to returns `403 LESSON_NOT_ENTITLED` with
  the course slug and title, enough for the reader to render a paywall without a
  second request. It does **not** return the body with a flag; the content does
  not cross the wire.
- Table of contents and previous/next navigation come from the snapshot, so they
  match what publishing froze — including a soft-deleted lesson that §4.3 keeps in
  the last snapshot until the next publish.

### FR-AUDIO-02 — the player

- Audio is served only when the §6.5 chain resolves to the **published** text:
  `narration_scripts.source_content_checksum` equals
  `blockListChecksum(published_block_list)` **and**
  `lesson_audios.source_script_checksum` equals `narration_scripts.script_checksum`.
  Both functions already exist (`checksum.ts:72`, `narration.ts:98`); neither
  comparison needs a column or a migration.
  - **Why this and not a filter on matching blockIds.** Neither
    `narration_scripts` nor `lesson_audios` has a published track — publishing
    copies the body and nothing else — so after a publish an admin's narration
    edit reaches learners immediately, unversioned. Matching blockIds would let a
    learner hear narration written against text they are not reading, silently.
    The checksum chain is the only available proof that the audio voices the
    published words.
  - **Accepted consequence:** the player disappears from a lesson while an admin
    is mid-edit, and returns on the next publish. §6.5's `stale` is computed on
    read everywhere else in the system for the same reason; this is that rule
    applied to the learner side. Recorded as a known limitation, with the published
    narration track named as the fix if it becomes a problem in practice.
  - When the chain does not resolve, the lesson reads normally and reports no
    audio. The snapshot's `hasAudio` and `audioDurationSeconds` are treated as
    table-of-contents hints, not as the gate.
- Highlight sync reads `audio_segments.start_millisecond` / `end_millisecond` and
  matches the `data-block-id` the shared renderer already emits
  (`render.tsx:216`). **No renderer change.** The player is a client component
  wrapping the rendered body; the renderer stays free of click handling, exactly
  as its comment requires.
- Clicking a block seeks to that block's `startMillisecond`.
- Playback speed is adjustable and persists across lessons in `localStorage`.
  §8 defines no user-preferences table and P7 adds no column.
- **Signed URL lifecycle.** The player fetches
  `/api/media/:mediaId/signed-url` when playback starts, and re-mints when the URL
  is near expiry or a media request fails. Each mint re-checks entitlement, which
  is what E-03 is for: a long-lived URL survives the grant that produced it.
  `:mediaId` resolves a `lesson_audios.id` and nothing else — that is the row
  E-01's "leaks paid audio" names. TTL stays within NFR-02's 15 minutes.
- Without audio, or before playback starts, no signed URL is minted.

### FR-LRN-02 / FR-LRN-03 — progress, resume and My Courses

- `PUT /lessons/:lessonId/progress` accepts completion, `lastScrollPercentage`
  and `lastAudioPositionMs`, upserting on `(userId, lessonId)`. It is
  learner-only and entitlement-gated: progress cannot be written for a lesson the
  caller may not read.
- The client batches scroll and audio position into a debounced write of a few
  seconds and flushes on `pagehide` with `sendBeacon`, so closing a tab does not
  lose the position — which is the whole point of FR-LRN-02. Mark-complete writes
  immediately and is not debounced.
- **Anonymous readers get no progress and no completion control**, with a sign-in
  prompt in its place. Nothing is written to `localStorage` as a shadow of
  `lesson_progress`.
- FR-LRN-03: chapter and course percentages are computed from completed lessons
  over total non-deleted **published** lessons — the denominator comes from the
  snapshot, so it matches the table of contents the learner sees.
- `/me/courses` lists every course the learner holds a grant for, active or not,
  with progress percentage, `expiresAt`, `daysRemaining` and a resume target (the
  most recently updated `lesson_progress` row for that course).
  - §7.4: an expired course **stays listed** with an expired badge and its
    progress percentage. It is not hidden and its progress is never deleted.
  - The repurchase action is the price block described below: present when an
    active product exists, absent otherwise until P8.
  - A free course appears in `/me/courses` only if a grant exists for it;
    entitlement to free content needs no grant, so a free course a learner has
    merely read is reachable from the catalog, not from this list.

### FR-CAT-01/02/03 — catalog, category and course pages

- Catalog lists `published` courses only, grouped by category and ordered by
  `levelOrder`, paginated, with the search described above.
- Category page lists every level; unpublished levels appear as "in development"
  with no link (FR-CAT-02), which is the one place a non-published course is named
  — its title and level label only, never its content.
- Course page shows overview, objectives, prerequisites and the full table of
  contents from the snapshot, with free-preview lessons marked.
- **Price blocks query the real `products` table and render only when an active
  row exists.** No placeholder copy and no second code path: P8 inserts rows and
  the block appears with no P7 change. A paid course with no product renders a
  locked state with no call to action.

### FR-EDIT — the `is_free_preview` writer

- `updateLessonSchema` (`lessons.controller.ts:39`) accepts `isFreePreview:
  boolean`, declaring `createAndEditChaptersAndLessons` like the rest of that
  endpoint, with a toggle in the admin-web lesson list.
- This is the smallest change that makes §7.3's free-preview branch reachable
  through the product and makes §14 decision 3 a per-course configuration rather
  than an unimplemented idea. It is admin-side work inside a learner-side phase,
  and it is here because the phase that needs the column is this one.
- It does **not** become a publish-checklist item; §5.7's list is closed and P6
  recorded that it adds no item of its own.

### Learner authentication

- `apps/learner-web` hosts its own Auth.js instance against the same
  `PrismaAdapter` and `sessions` table as admin-web, with `strategy: 'database'`
  — FR-AUTH-01's reason for database sessions applies unchanged.
- Self-serve magic-link sign-up creates users at the schema default
  `user_role = 'learner'`. **The learner app never sets a role**; there is no code
  path from it to `admin` or `admin_owner`.
- Delivery stays dev-mode logging, mirroring `admin-web/auth.ts` and
  `LogEmailProvider`. §7.5's transactional provider is still P8's, and a second
  logging shim is cheaper than a premature choice.
- A **distinct session cookie name** from admin-web, so the two apps on
  `localhost` do not overwrite each other's sessions. Its own `AUTH_URL`
  equivalent and port (`:3002`).
- `apps/api` CORS accepts both origins. `main.ts:21`'s single-origin echo becomes
  a small allowlist read from env; credentialed CORS still echoes exactly one
  matching origin per request and never `'*'`.

### NFR-01 — ISR and the revalidation hook P6 left open

- Category, course and lesson pages are statically generated with
  `generateStaticParams` over published courses and revalidated incrementally.
  Because §7.3 permits anonymous reading of free content, those pages are
  identical for every anonymous visitor and genuinely cacheable; entitled and
  per-learner content (progress, completion state, `/me/courses`) renders on the
  client against the API.
- A publish triggers on-demand revalidation. **The hook attaches at two places,
  not one:**
  1. `apps/worker/src/jobs/publish.processor.ts`, after its transaction commits
     (`publish.processor.ts:232`) — the asynchronous publish path.
  2. `apps/api/src/content/publishing.service.ts`'s `transition()`
     (`publishing.controller.ts:93`, `:104`) — unpublish and archive are
     synchronous API transitions with no job, and a course that vanishes from the
     catalog must stop serving its cached pages. A publish that revalidates and an
     unpublish that does not is the worse of the two failures.
- The revalidate route lives in `learner-web`, authenticated by a shared secret
  from env, and takes a course slug. It is idempotent and safe to call twice.
- **A failed revalidation never fails a publish.** The transaction has committed
  and the course is published; the hook logs and moves on, and the time-based
  revalidate interval is the backstop. Callers treat it as best-effort by design.

### Presentation

- Tailwind v4 with the typography plugin, matching admin-web, added to
  `learner-web`.
- NFR-09: responsive from 360 px. The reader is the case that matters — a table
  and a figure must both survive a narrow viewport.
- Interface copy is **Vietnamese**, written as literals with no i18n framework,
  matching `lang="vi"` and the content. §13 lists no multi-language requirement
  and a message catalogue for one locale is scaffolding.

## Non-goals

- **All of §7's commerce.** No products CRUD, no `/checkout`, no
  `/webhooks/payment`, no `PaymentProvider`, no manual grants, no renewal
  stacking, no expiry reminders, no `EmailProvider` beyond the existing logging
  shim. P7 *reads* `products` and `access_grants`; it writes neither. The only
  way a grant exists during P7 is a hand-seeded row, which is how the e2e suite
  makes one.
- **Topic requests.** FR-REQ-01 and §9.4's two topic-request endpoints are P9.
- **The repurchase and checkout actions.** §7.4 describes them; they are buttons
  pointing at an endpoint P8 builds. The expired badge and preserved progress
  ship here, the action does not.
- **A published track for narration or audio.** The checksum-chain gate above is
  the P7 answer. Adding published columns is a migration, reopens P6's output
  shape, and is deliberately deferred — recorded as the fix if the
  audio-disappears-while-editing behaviour proves unacceptable.
- **Any schema migration.** Playback speed lives in `localStorage`; every other
  piece of state has a column. If SQL appears necessary, the problem statement has
  been misread.
- **Making `content_status = 'ready'` reachable.** Still unwritten, as P6 recorded.
- **Offline audio, downloads, PDF or markdown export, learner notes and
  highlights, quizzes.** §13 excludes all of them.
- **Staff preview of unpublished courses in the learner app.** admin-web already
  renders the draft through the same component.
- **A CDN, production object storage, or any deployment configuration.** Still
  local Docker Compose and the CI runner, as every phase since P0 has held.
  NFR-01's CDN clause is infrastructure, not code; the ISR and revalidation halves
  ship here.
- **Seed or demo data.** P10 owns it; the e2e suite creates what it needs.
- **Cost dashboards, error tracking, job alerting.** P10.

## Constraints

- **`knowledge-explorer-spec.md` outranks this document.** §5.8's FRs, §7.2 and
  §7.3's entitlement model including E-01/E-02/E-03, §9.4's routes, §3's matrix
  and §4.3's two tracks are locked and are not reopened here.
- **Never regenerate `20260911180121_init/migration.sql`** (CLAUDE.md invariant 1).
  P7 needs no migration at all.
- **Deny-by-default stays intact where it applies.** Admin endpoints are
  untouched; `UndeclaredPolicyFixtureController` keeps declaring nothing and
  keeps returning `403 FORBIDDEN_NO_POLICY` (invariant 2). The public module's
  *absence* of a guard chain is a declared decision with its own test, not a
  weakening of the rule.
- **`emitDecoratorMetadata` stays `false`**; injection is explicit
  `@Inject(Token)` (invariant 4).
- **`S3_ENDPOINT` and `S3_PUBLIC_ENDPOINT` are two variables** (invariant 5). Every
  URL P7 presigns is consumed by a browser, so it signs against the public
  endpoint. Getting this wrong fails with an opaque `SignatureDoesNotMatch` and no
  other symptom — the first phase where every presigned URL is learner-facing is
  the phase where this invariant is most likely to bite.
- **Prisma 7.10.0 and next-auth 5.0.0-beta.32 stay pinned** (invariant 6). The
  learner-web Auth.js instance uses the version admin-web already pins; after any
  next-auth change, `scripts/verify-magic-link.sh` re-runs (invariant 3).
- Enum-like values stay `String` columns with members in
  `packages/shared/src/enums.ts`. `scope_type`, `access_source` and
  `progress_status` already have theirs.
- **Dependency direction is one-way.** `packages/commerce` imports `database` and
  `shared` and is imported by `apps/api`; no package imports an app, and api and
  worker still never import each other. The worker's revalidation call is an HTTP
  request to learner-web, not an import.
- Money is `Decimal(12,2)`; a price crossing the wire is serialized as a string,
  never as a JavaScript number.
- NFR-02: signed URL TTL ≤ 15 minutes. NFR-04 is unaffected — no public request
  waits on a provider, because §9.4 contains no AI, image or TTS endpoint, which
  is itself deliberate: it removes any path for anonymous traffic to spend money.
- Tests live in per-workspace `test/`, named `*.spec.ts` / `*.e2e-spec.ts` — both
  globs are listed explicitly in the api vitest config, and a file matching
  neither silently never runs. `learner-web` gets both globs in its own config
  from the start.
- Node 22 and a running Docker stack; ffmpeg present, because the browser suite
  spawns the worker.

## Affected files and interfaces

**New**

| Path | Purpose |
|---|---|
| `packages/commerce/src/entitlement.ts` | §7.3's three functions; the only access decision in the system |
| `packages/commerce/src/index.ts` | Barrel; currently 0 bytes |
| `packages/commerce/test/entitlement.spec.ts` | Grace-period boundary, revocation-before-expiry, perpetual, anonymous, bundle-by-category |
| `apps/api/src/public/public.module.ts` | The eight §9.4 endpoints, wired into `AppModule` |
| `apps/api/src/public/catalog.controller.ts` | `/categories`, `/categories/:slug`, `/courses`, `/courses/:slug` |
| `apps/api/src/public/lessons.controller.ts` | `/lessons/:lessonId`, `/lessons/:lessonId/progress` |
| `apps/api/src/public/media.controller.ts` | `/media/:mediaId/signed-url` |
| `apps/api/src/public/me.controller.ts` | `/me/courses` |
| `apps/api/src/public/catalog.service.ts`, `reader.service.ts` | Snapshot reads, search, the published-track joins, the §6.5 audio chain check |
| `apps/api/src/auth/optional-session.ts` | Resolves a session when present, anonymous when not; never rejects |
| `apps/api/test/public-catalog.e2e-spec.ts` | Anonymous access, draft-track absence, search, pagination |
| `apps/api/test/entitlement-gates.e2e-spec.ts` | **E-01's regression test: both gates, one file** |
| `apps/learner-web/auth.ts`, `app/api/auth/[...nextauth]/route.ts`, `app/signin/` | Learner Auth.js instance |
| `apps/learner-web/app/` | Catalog, category, course, reader and my-courses routes |
| `apps/learner-web/app/api/revalidate/route.ts` | On-demand ISR hook, shared-secret authenticated |
| `apps/learner-web/components/player/` | Client player: highlight sync, seek-to-block, speed, URL re-mint |
| `apps/learner-web/components/progress/` | Debounced progress writer with `pagehide` flush |
| `apps/learner-web/app/globals.css`, `postcss.config.mjs` | Tailwind v4 + typography |
| `apps/learner-web/playwright.config.ts`, `e2e/`, `e2e/global-setup.ts` | Its own browser suite on `:3002` |

**Modified**

| Path | Change |
|---|---|
| `apps/api/src/main.ts:21` | CORS single-origin echo → env-driven allowlist covering admin-web and learner-web |
| `apps/api/src/content/lessons.controller.ts:39` | `updateLessonSchema` accepts `isFreePreview` |
| `apps/api/src/content/publishing.service.ts` | Revalidation hook on `transition()` for unpublish and archive |
| `apps/worker/src/jobs/publish.processor.ts:232` | Revalidation hook after the transaction commits |
| `apps/admin-web/app/(portal)/courses/[courseId]/` | Free-preview toggle in the lesson list |
| `apps/learner-web/next.config.ts` | `transpilePackages` gains `@knowledge-explorer/content`; root `.env` loading |
| `apps/learner-web/package.json` | Auth.js, Tailwind, Playwright, the workspace packages, `test`/`test:e2e` scripts |
| `packages/shared/src/errors.ts` | `LESSON_NOT_ENTITLED`, `MEDIA_NOT_FOUND`, `COURSE_NOT_PUBLISHED` |
| `.env.example` | Learner-web port and auth URL, cookie name, revalidation secret, CORS origins |

**Read, not modified**

`published_course_structures.structure_payload` through
`structurePayloadSchema` (`packages/shared/src/publication.ts:196`) — P6 wrote it
to be parsed by this phase; `LessonBody` and `FigureImages`
(`packages/content/src/render.tsx:206`, `types.ts:75`); `blockListChecksum`
(`checksum.ts:72`) and `scriptChecksum` (`narration.ts:98`); `ObjectStorage`
(`packages/storage`) for presigning; `isAllowed` / `permissionMatrix`
(`packages/shared/src/roles.ts`).

## End-to-end verification

**`pnpm --filter @knowledge-explorer/learner-web test:e2e`** — a Playwright suite
on its own config, excluded from `turbo run test` like admin-web's, booting api
(`:3001`), admin-web (`:3000`) and learner-web (`:3002`) through `webServer` and
spawning the worker in `global-setup.ts`, waiting on `Worker ready.`

One scripted scenario, asserted end to end:

1. **Seed and publish.** Through the admin API: create a category and a paid
   course, three chapters of two lessons, bodies with a figure and a table,
   select an image with caption and alt text, generate narration and audio with
   the fake providers, mark lesson 1 `isFreePreview` **through the endpoint added
   in this phase**, publish. Assert the course reaches `published` and a snapshot
   row exists.
2. **Catalog, anonymous.** Open `:3002`. The course appears under its category.
   Search its title — it is found; search a string in another course's overview —
   that one is found and this one is not. The course page shows the table of
   contents from the snapshot, and **no price block**, because no product exists.
3. **Free preview, anonymous.** Open lesson 1 signed out. The body renders with
   `Figure 1` numbered and the table intact. **Assert the figure's `<img src>` is
   a presigned URL against `S3_PUBLIC_ENDPOINT` and actually loads** — the
   `SignatureDoesNotMatch` failure mode has no other symptom. No completion
   control; a sign-in prompt in its place.
4. **Paywall, anonymous.** Open lesson 2. The body does not render, the response
   was `403 LESSON_NOT_ENTITLED`, and **assert the lesson text is absent from the
   page source**, not merely hidden.
5. **E-01, directly.** Request `/api/media/:mediaId/signed-url` for lesson 2's
   audio with no session and with a signed-in learner holding no grant. Both are
   refused. This is the assertion §7.3 says a regression test must cover.
6. **Sign in and read.** Magic-link sign-in as a learner (link read from the log,
   as `verify-magic-link.sh` does). Insert an active course-scoped grant directly.
   Reload lesson 2 — it renders. Assert `/api/me/courses` lists the course with
   `daysRemaining`.
7. **Player.** Start playback. Assert a signed URL was minted at play time and not
   at page load. As time advances, the highlighted `data-block-id` follows the
   `audio_segments` offsets; clicking a later block seeks to its
   `startMillisecond`. Change speed, open another lesson, assert the speed
   persisted.
8. **Progress and resume.** Scroll, pause mid-audio, navigate away. Assert
   `lesson_progress` holds a non-zero `last_scroll_percentage` and
   `last_audio_position_ms`. Mark lesson 2 complete; assert the course percentage
   moved by one lesson over the snapshot's `totalLessonCount`, and that
   `/me/courses` resumes to lesson 2.
9. **Expiry, then §7.4.** Backdate the grant past `expiresAt + gracePeriodDays`.
   Lesson 2 is refused again; **lesson 1 still reads**, because free preview
   survives expiry; the course **remains** in `/me/courses` with an expired badge
   and its progress intact — assert `lesson_progress` was not deleted.
10. **Audio staleness.** Edit lesson 2's body through the admin API without
    republishing. Assert the learner page still shows the previously published
    text, and that the player is now absent because the checksum chain no longer
    resolves. Republish after regenerating; the player returns.
11. **Unpublish.** Unpublish the course. Assert it leaves the catalog, its course
    page 404s, and **that this happened without waiting out the revalidate
    interval** — proving the synchronous transition path fires the hook, not only
    the worker path.

Plus `pnpm verify` (typecheck + test) green across the monorepo, including the new
`packages/commerce` unit suite and `apps/api/test/entitlement-gates.e2e-spec.ts`.

## Open questions

None blocking. Three items are recorded as deliberately deferred rather than
unresolved:

- **§14 decision 3 — number of free-preview lessons per course.** P7 makes it
  per-lesson configurable and picks no number. Still §14's to decide.
- **§14 decision 2 — grace period length.** `gracePeriodDays` defaults to 0 and
  the resolver honours whatever a grant carries. No P7 behaviour depends on the
  value.
- **A published track for narration and audio.** Not needed for P7 under the
  checksum-chain gate; named here as the fix if the player's disappearance during
  an edit proves unacceptable in practice. It would be a migration and a change to
  P6's publish job, so it belongs in its own phase, not in this one.
