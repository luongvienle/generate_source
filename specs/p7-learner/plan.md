# Plan: P7 — Learner app

**Spec:** specs/p7-learner/spec.md
**Status:** Approved
**Date:** 2026-09-13

## Objective

Make the published track reachable: build §7.3's entitlement resolver and the two
gates E-01 names, the eight public §9.4 endpoints, and the `apps/learner-web`
catalog, reader, player, progress and My Courses that consume them — so the
product P0–P6 built can be opened by a learner.

## Approach

**The gate is built before the thing it gates.** Slice A delivers
`packages/commerce` and the two entitlement-gated endpoints with E-01's
regression test, before a single learner page exists. This is the reverse of the
natural order and it is deliberate: a reader built against no gate, gated later,
is exactly the shape of the leak §7.3 warns about. Nothing in the learner app can
render paid content until the refusal is under test.

**Everything after that is a vertical slice.** Slices B through G each carry an
endpoint, its API test, the page that calls it and the behaviour a person can
see. The first visible learner page (slice C) lands on real catalog data from the
real API, not a fixture, so end-to-end feedback starts at task 5 rather than at
the Playwright suite.

**Reuse over reimplementation, verified rather than assumed.** Five existing
pieces do most of the work, and planning confirmed each by reading it:

- `LessonBody` (`packages/content/src/render.tsx:206`) renders the reader. It
  already emits `data-block-id` on every block (`render.tsx:216`), which is
  precisely what highlight sync binds to, and it already takes a `FigureImages`
  map. **No renderer change in this phase.**
- `readBlockList` (`apps/api/src/content/lesson-content.service.ts:52`) parses the
  JSONB block list; `images.service.ts` already imports it across the same
  boundary the new `public/` module will.
- `blockListChecksum` (`checksum.ts:72`) and the `narration_scripts` /
  `lesson_audios` checksum columns give the audio gate its comparison with no new
  state — see the verification below.
- `PRESIGN_EXPIRY_SECONDS = 600` (`packages/storage/src/object-storage.ts`) is
  already inside NFR-02's fifteen minutes and already signs against
  `S3_PUBLIC_ENDPOINT`. Both image and audio presigning reuse it.
- `startWorker` (`apps/api/test/helpers/worker-process.ts`) and admin-web's
  `global-setup.ts` are the model for learner-web's browser suite.

**The audio gate's comparison is sound, and this was checked rather than
inferred.** `lesson_contents.draft_content_checksum` is written as
`blockListChecksum(blockList)` (`lesson-content.service.ts:179`);
`narration_scripts.source_content_checksum` is written as that same value
(`narration.processor.ts:134`); and the publish job copies `draft_block_list`
into `published_block_list` verbatim. So `source_content_checksum ===
blockListChecksum(readBlockList(publishedBlockList))` is true exactly when the
script was generated from the text now published. The second link,
`lesson_audios.source_script_checksum === narration_scripts.script_checksum`, is
what `computeAudioStatus` already compares. **No new checksum comparison is
invented**; the phase composes two that exist.

### Four decisions planning had to make that the spec implies but does not state

**1. The session cookie must be read per-app, not per-name.** `readSessionToken`
(`session-context.ts:36`) accepts four fixed cookie names and returns the first
match found while scanning the `Cookie` header. The spec gives learner-web a
distinct cookie name so the two apps on `localhost` do not overwrite each other —
but simply adding that name to the list would make identity depend on **cookie
header order** whenever a staff user is signed into both apps, which the browser
suite will routinely produce. Resolution: `readLearnerSessionToken` reads *only*
the learner cookie name, and the existing `readSessionToken` keeps reading *only*
the admin names. The two apps stay genuinely independent, resolution is
deterministic, and the spec's staff-access rule falls out for free — an owner
signed into admin-web carries no learner cookie, so learner-web sees an anonymous
visitor, which is exactly what it should see.

**2. `publishing.service.loadCourse` must select `slug`.** It currently selects
`id, publicationStatus, hasUnpublishedChanges, publishedAt`
(`publishing.service.ts:226`). The revalidation hook addresses pages by slug.

**3. The free-preview toggle needs three touches, not one.** The spec names
`updateLessonSchema`. The toggle cannot render without `isFreePreview` in
`getStructure`'s lesson `select` (`courses.controller.ts:129`) and in `TreeLesson`
(`lib/tree-types.ts`). It needs no fourth: the PATCH handler already calls
`markUnpublishedChangesForLesson` for every field
(`lessons.controller.ts:157`), so FR-PUB-03 flagging is inherited — the comment
above it, which currently names only title and estimated minutes, gets a third
item.

**4. `packages/commerce` reads through Prisma directly, not through a new
`packages/database` helper.** `packages/database` holds the query helpers api and
worker *share* (`publish-checklist.ts`, `publication-flag.ts`). Entitlement has
exactly one consumer — `apps/api` — so it stays in `commerce`, which is where §11
puts it. `commerce` gains `@knowledge-explorer/database` as a dependency, and
`apps/api` gains `@knowledge-explorer/commerce`; the direction stays one-way.

### Rejected while planning

- **Adding the learner cookie name to `SESSION_COOKIE_NAMES`.** Non-deterministic
  under two sessions; see decision 1.
- **A `packages/database` catalog-query helper.** No second consumer.
- **Recomputing the published checksum at publish time into a new column.** That
  is the migration the spec forbids; recomputing on read is cheap and stores
  nothing.
- **A learner-only copy of the renderer.** It would break FR-EDIT-01's
  "renders exactly what the learner will see" the moment either copy changed.

## Affected files

### New

| File | Change |
|---|---|
| `packages/commerce/src/entitlement.ts` | §7.3's `isGrantActive`, `hasAccessToCourse`, `hasAccessToLesson`. `userId: string \| null`. Reads only. |
| `packages/commerce/src/index.ts` | Barrel (currently 0 bytes) |
| `packages/commerce/test/entitlement.spec.ts` | Grace boundary both sides, revoked-before-expired, perpetual, anonymous, category-scope bundle |
| `packages/commerce/vitest.config.mts` | Mirrors the api config's two include globs |
| `apps/api/src/public/public.module.ts` | The eight §9.4 endpoints; imported by `AppModule` |
| `apps/api/src/public/catalog.controller.ts` | `/categories`, `/categories/:slug`, `/courses`, `/courses/:slug` — no guards |
| `apps/api/src/public/lessons.controller.ts` | `/lessons/:lessonId` (no guards, entitlement-gated); `PUT /lessons/:lessonId/progress` (learner-guarded) |
| `apps/api/src/public/media.controller.ts` | `/media/:mediaId/signed-url` — no guards, entitlement-gated, resolves `lesson_audios.id` only |
| `apps/api/src/public/me.controller.ts` | `/me/courses` — learner-guarded |
| `apps/api/src/public/catalog.service.ts` | Published-only queries, search, snapshot reads, product lookup |
| `apps/api/src/public/reader.service.ts` | Block list, figure presigning, prev/next, the §6.5 audio chain check |
| `apps/api/src/public/progress.service.ts` | Upsert on `(userId, lessonId)`; chapter and course percentages from the snapshot |
| `apps/api/src/auth/optional-session.ts` | `readLearnerSessionToken` + `resolveOptionalSession`; never throws |
| `apps/api/src/public/revalidate.client.ts` | Best-effort POST to learner-web's revalidate route; never throws |
| `apps/worker/src/jobs/revalidate.client.ts` | The same, for the worker — api and worker may not import each other |
| `apps/api/test/entitlement-gates.e2e-spec.ts` | **E-01: both gates in one file** |
| `apps/api/test/public-catalog.e2e-spec.ts` | Anonymous reads, draft-track absence, search, pagination |
| `apps/api/test/public-reader.e2e-spec.ts` | Block list, presigned figures, audio chain gate, progress, `/me/courses` |
| `apps/learner-web/auth.ts` | Auth.js, PrismaAdapter, database sessions, distinct cookie name, log delivery |
| `apps/learner-web/app/api/auth/[...nextauth]/route.ts` | Handler export, mirroring admin-web |
| `apps/learner-web/app/api/revalidate/route.ts` | Shared-secret on-demand ISR hook, idempotent |
| `apps/learner-web/app/signin/page.tsx` | Magic-link sign-in |
| `apps/learner-web/app/(catalog)/page.tsx` | Catalog with search and pagination |
| `apps/learner-web/app/(catalog)/categories/[slug]/page.tsx` | FR-CAT-02, in-development levels unlinked |
| `apps/learner-web/app/(catalog)/courses/[slug]/page.tsx` | FR-CAT-03, ToC from snapshot, price block when a product exists |
| `apps/learner-web/app/lessons/[lessonId]/page.tsx` | Reader; paywall on `LESSON_NOT_ENTITLED` |
| `apps/learner-web/app/me/courses/page.tsx` | My Courses with expired badge and resume |
| `apps/learner-web/components/player/*` | Client player: highlight sync, seek-to-block, speed, URL re-mint |
| `apps/learner-web/components/progress/*` | Debounced writer + `pagehide` `sendBeacon` flush |
| `apps/learner-web/lib/api.ts` | Fetch client mirroring admin-web's. Vietnamese copy stays inline in components — the spec rejected a message catalogue |
| `apps/learner-web/app/globals.css`, `postcss.config.mjs` | Tailwind v4 + typography |
| `apps/learner-web/playwright.config.ts`, `e2e/global-setup.ts`, `e2e/learner.spec.ts` | Browser suite on `:3002` |

### Modified

| File | Change |
|---|---|
| `apps/api/src/main.ts:21` | CORS single origin → env allowlist; still echoes one matching origin, never `'*'` |
| `apps/api/src/app.module.ts` | Register `PublicModule` and its services |
| `apps/api/src/content/lessons.controller.ts:39,145,156` | `updateLessonSchema` accepts `isFreePreview`; add to `select`; extend the FR-PUB-03 comment |
| `apps/api/src/content/courses.controller.ts:129` | `getStructure` lesson `select` gains `isFreePreview` |
| `apps/api/src/content/publishing.service.ts:226,98` | `loadCourse` selects `slug`; `transition()` fires the revalidation hook |
| `apps/worker/src/jobs/publish.processor.ts:232` | Fire the revalidation hook after the transaction commits, before returning |
| `apps/admin-web/lib/tree-types.ts` | `TreeLesson.isFreePreview: boolean` |
| `apps/admin-web/components/curriculum-tree.tsx` | Free-preview toggle per lesson |
| `apps/learner-web/next.config.ts` | `transpilePackages` gains `@knowledge-explorer/content`; load the root `.env` before the config is evaluated, as admin-web does |
| `apps/learner-web/package.json` | next-auth, Tailwind, Playwright, workspace deps, `test` / `test:e2e` scripts |
| `apps/learner-web/app/layout.tsx`, `app/page.tsx` | Replace the P0 placeholder shell |
| `packages/commerce/package.json` | `@knowledge-explorer/database` dependency, `test` script, vitest |
| `apps/api/package.json` | `@knowledge-explorer/commerce` dependency |
| `packages/shared/src/errors.ts` | `LESSON_NOT_ENTITLED`, `MEDIA_NOT_FOUND`, `COURSE_NOT_PUBLISHED` |
| `.env.example` | `LEARNER_WEB_URL`, `LEARNER_AUTH_URL`, `LEARNER_PORT`, `REVALIDATE_SECRET`, `CORS_ORIGINS` |

### Read, not modified

`structurePayloadSchema` (`packages/shared/src/publication.ts:196`);
`LessonBody` / `FigureImages` (`render.tsx:206`, `types.ts:75`);
`blockListChecksum` (`checksum.ts:72`); `scriptChecksum` / `computeAudioStatus`
(`narration.ts:98`, `:349`); `readBlockList`
(`lesson-content.service.ts:52`); `ObjectStorage` + `PRESIGN_EXPIRY_SECONDS`
(`packages/storage`); `isAllowed` (`roles.ts`).

## Risks

- **A public endpoint that accidentally serves the draft track.** The whole
  §4.3 guarantee rests on it, and a wrong `select` is invisible in a passing
  test that only checks status codes. *Mitigation:* `public-catalog.e2e-spec.ts`
  asserts a draft course and an `unpublished` course are both absent from the
  catalog and 404 by slug, and the reader test asserts the response body is the
  *published* markdown after an unpublished draft edit (verification step 10).
- **The guard chain's absence read later as an oversight.** Seven phases have
  taught every reader that a controller without `@RequirePermission` is a bug.
  *Mitigation:* a test named for the property asserts the public controllers
  answer anonymously, plus a comment on `public.module.ts` pointing at §9.4 —
  mirroring how `UndeclaredPolicyFixtureController` holds the opposite rule.
- **`SignatureDoesNotMatch` with no other symptom.** Invariant 5, and P7 is the
  first phase where every presigned URL is consumed by a browser. *Mitigation:*
  presigning goes through `ObjectStorage.presignGet` only — which already signs
  against `S3_PUBLIC_ENDPOINT` — and browser step 3 asserts the figure actually
  loads rather than merely that a URL was returned.
- **Cookie collision between the two Next apps on `localhost`.** Resolved by
  decision 1 above; the risk is that an implementation "simplifies" it back into
  one shared list. *Mitigation:* task 7 carries a test signing in on both apps
  and asserting each resolves to its own user.
- **ISR serving a stale or missing page after unpublish.** A course that vanishes
  from the catalog while its page still renders is worse than a slow publish.
  *Mitigation:* the hook fires from the synchronous `transition()` as well as the
  worker, and browser step 11 asserts the 404 without waiting out the interval.
- **A revalidation failure failing a publish.** The transaction has already
  committed. *Mitigation:* both clients swallow and log; a worker test asserts the
  job still succeeds when the learner-web URL is unreachable.
- **The browser suite's third process making it flaky or slow.** It already boots
  api, admin-web and the worker; learner-web makes four. *Mitigation:* learner-web
  gets its own config and `global-setup`, `fullyParallel: false` and one worker
  like admin-web's, and the `next build` timeout is set to admin-web's 180 s.
- **Scope.** This is the largest phase since P0 and §12 budgets two weeks.
  *Mitigation:* the slices below are ordered so A–C is a demonstrable product
  (catalog + free reading) even if D–G slip; nothing in A–C depends on anything
  in D–G.

## Test strategy

**Unit, no database.** `isGrantActive`'s branch matrix in
`packages/commerce/test/entitlement.spec.ts`: revoked, perpetual, inside grace,
outside grace, and grace `0`. Pure function, injected clock, no fixtures.

**Integration over real HTTP, Postgres and MinIO** — the pattern every api suite
already uses: `Test.createTestingModule` + `supertest`, users and sessions seeded
directly through Prisma (`publishing.e2e-spec.ts:50`), a random run suffix per
suite, `fileParallelism: false`.

- `entitlement-gates.e2e-spec.ts` — **E-01's regression test.** Both
  `GET /lessons/:lessonId` and `GET /media/:mediaId/signed-url`, each across five
  callers: anonymous, learner with no grant, learner with an active grant, learner
  with an expired grant, learner with a revoked grant. Plus free-course and
  free-preview passes. One file, because §7.3 asks for one.
- `public-catalog.e2e-spec.ts` — anonymous access; draft and `unpublished`
  courses absent and 404; search across all three fields; pagination totals;
  price block present only with an active product.
- `public-reader.e2e-spec.ts` — block list matches the published copy; figure URLs
  presigned; the audio chain gate in both directions; progress upsert and
  percentages; `/me/courses` including an expired grant; owner and admin refused
  at `/me/courses` with `FORBIDDEN_ROLE`.

**Browser, `pnpm --filter @knowledge-explorer/learner-web test:e2e`** — the
spec's eleven-step scenario, split across two tasks: steps 1–6 (seed, publish,
catalog, free preview, paywall, E-01, sign in and read) and steps 7–11 (player,
progress, expiry, audio staleness, unpublish). Its own `playwright.config.ts`
booting api, admin-web and learner-web through `webServer` and the worker through
`global-setup.ts`, excluded from `turbo run test` because its script is
`test:e2e`.

**Regression.** Every P0–P6 suite must pass unedited. The only intentional test
edits are additions; if an existing suite changes, that is a finding to report,
not a fix to make quietly.

**Gate.** `pnpm verify` green, then the browser suite.

## Out of scope

Restating the spec's non-goals, plus what planning added:

- All of §7's commerce: products CRUD, `/checkout`, `/webhooks/payment`,
  `PaymentProvider`, manual grants, renewal stacking, expiry reminders, a real
  `EmailProvider`. P7 reads `products` and `access_grants` and writes neither.
- Topic requests (P9); the repurchase and checkout actions (P8).
- A published track for narration or audio — the checksum gate is the P7 answer.
- **Any schema migration.** Playback speed is `localStorage`; every other piece of
  state has a column. `packages/database/prisma/` is not edited in any task.
- Making `content_status = 'ready'` reachable; offline audio, export, notes,
  quizzes (§13); staff preview of unpublished courses in the learner app.
- CDN, production object storage, deployment configuration; seed or demo data
  (P10); cost dashboards, error tracking, job alerting (P10).
- **Added during planning:** no new BullMQ queue and therefore no
  `job-permissions.ts` row and no `JobStatusService` instance — revalidation is a
  direct HTTP call, not a job, so P6's "silent 404" note does not apply here. No
  change to `SESSION_COOKIE_NAMES` or to `SessionGuard`. No new
  `packages/database` helper. No renderer change in `packages/content`.
