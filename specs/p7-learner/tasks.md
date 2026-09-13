# Tasks: P7 — Learner app

**Plan:** specs/p7-learner/plan.md

Tick boxes as work completes, not at the end — this file is the durable progress
state and is what survives a lost session.

Four rules for this phase specifically:

- **No migration.** `packages/database/prisma/` is not edited in any task. Every
  column P7 needs exists and was verified against `schema.prisma` during
  planning. Playback speed lives in `localStorage` on purpose. If a task seems to
  need a column, stop and re-read the spec's problem statement before writing SQL.
- **One entitlement decision.** Tasks 3 onward call
  `packages/commerce`. A second access check written anywhere else in this phase —
  in a controller, in a page, in a component — is a bug, and it is the specific
  bug E-01 exists to prevent.
- **No new checksum comparison.** The audio gate composes
  `blockListChecksum` and the stored `script_checksum` / `source_script_checksum`
  columns. Task 9 compares values that already exist; it does not derive a new one.
- **Earlier phases' suites must keep passing unedited.** The only intentional test
  edits are the additions named in tasks 2 and 7. If a P0–P6 suite changes, that
  is a finding to report, not a fix to make quietly.

---

## Slice A — The gate, before anything it gates

- [x] **Task 1: §7.3 in `packages/commerce`**
  `src/entitlement.ts` exporting `isGrantActive(grant, now)`,
  `hasAccessToCourse(prisma, userId, courseId)` and
  `hasAccessToLesson(prisma, userId, lessonId)`, re-exported from `src/index.ts`.
  `userId` is `string | null` throughout — §7.3's free-course and free-preview
  branches return before consulting it. `revokedAt` is checked **before**
  `expiresAt` (FR-COM-04: revocation takes effect on the next request). The grant
  lookup reads `scope_course_id` and `scope_category_id` as two columns, not a
  synthetic `scopeId`; a category-scoped grant matches by the course's
  `category_id`, which is all §7.2's `all_current_and_future` needs. Reads only —
  E-02 forbids writing any status. Add `@knowledge-explorer/database` and a
  `test` script plus `vitest.config.mts` to the package manifest.
  **Done when:** `pnpm --filter @knowledge-explorer/commerce test` passes with
  cases for revoked, perpetual, inside grace, outside grace, `gracePeriodDays: 0`,
  anonymous, free course, free preview and category-scope bundle.

- [x] **Task 2: the `is_free_preview` writer, end to end**
  *API half verified (`unpublished-changes.e2e-spec.ts`, 13 passing). The tree
  toggle is written and typechecks, but no existing browser spec drives the
  curriculum tree, so its round-trip is asserted in task 14 instead — that
  scenario marks lesson 1 free-preview through this control.*
  `updateLessonSchema` (`lessons.controller.ts:39`) accepts
  `isFreePreview: boolean`; add it to the handler's `select`
  (`lessons.controller.ts:145`); extend the FR-PUB-03 comment at `:156` to name it
  as a third snapshot field. Add `isFreePreview: true` to `getStructure`'s lesson
  `select` (`courses.controller.ts:129`), the field to `TreeLesson`
  (`lib/tree-types.ts`), and a per-lesson toggle to `curriculum-tree.tsx`.
  No new permission — `createAndEditChaptersAndLessons`, like the rest of that
  endpoint. No publish-checklist item: §5.7's list is closed.
  **Done when:** an existing api suite extension asserts PATCH sets the column and
  that `has_unpublished_changes` flips to true on a published course (inherited
  from the existing `markUnpublishedChangesForLesson` call — verify, do not add a
  second one), and the toggle round-trips in the admin tree.

- [x] **Task 3: the public module, the reader endpoint, the media endpoint, E-01**
  *No `public.module.ts`: this app has exactly one Nest module and provides
  `OBJECT_STORAGE` and `PrismaService` there, so the two controllers and
  `ReaderService` are registered in `app.module.ts` like every other. A separate
  module would have needed imports/exports plumbing nothing else here does.*
  `apps/api/src/public/` with `public.module.ts`, `lessons.controller.ts`,
  `media.controller.ts` and `reader.service.ts`; `optional-session.ts` resolving a
  session when a cookie is present and returning anonymous when it is not —
  never throwing, and treating `is_active = false` as anonymous.
  `GET /lessons/:lessonId` returns the published block list, chapter and course
  context, prev/next from the snapshot, and figure images **presigned through
  `ObjectStorage.presignGet`** (`is_selected = true`, `block_reference_id` present
  in the published list). It never selects a draft column and never returns
  `published_content_markdown`. Refusal is `403 LESSON_NOT_ENTITLED` carrying
  course slug and title and **no body content**.
  `GET /media/:mediaId/signed-url` resolves a `lesson_audios.id` and nothing else.
  Controllers carry no `@UseGuards` and no `@RequirePermission`, with a comment
  citing §9.4 and pointing at the test below. Add the three error codes; register
  the module; add `@knowledge-explorer/commerce` to `apps/api`.
  **Done when:** `apps/api/test/entitlement-gates.e2e-spec.ts` passes — both
  endpoints across anonymous, no-grant, active-grant, expired-grant and
  revoked-grant callers, plus free-course and free-preview passes — and a test
  asserts the public controllers answer an anonymous request rather than
  `FORBIDDEN_NO_POLICY`.

## Slice B — Catalog behind the API

- [x] **Task 4: the four catalog endpoints**
  `catalog.controller.ts` + `catalog.service.ts`: `/categories` with
  published-level counts; `/categories/:slug` with levels ordered by `levelOrder`,
  each flagged published or in development, plus the bundle offer when an active
  category product exists; `/courses` filtered to `publication_status =
  'published'`, case-insensitive substring search across `courses.title`,
  `categories.display_name` and `courses.overview_summary`, offset-paginated with
  a bounded page size and a total; `/courses/:slug` with metadata from `courses`,
  the table of contents parsed through `structurePayloadSchema`, and the price
  block only when an active product row exists. Prices serialize as strings.
  Query strings validated with zod `strictObject`.
  **Done when:** `apps/api/test/public-catalog.e2e-spec.ts` passes, including a
  draft course and an `unpublished` course both absent from the catalog and 404 by
  slug, search hitting each of the three fields, pagination totals, and a course
  with no product rendering no price block.

## Slice C — The learner app becomes visible

- [x] **Task 5: learner-web foundation and the catalog page**
  Replace the P0 placeholder. Tailwind v4 + typography (`globals.css`,
  `postcss.config.mjs`), root `.env` loading and `transpilePackages` gaining
  `@knowledge-explorer/content` in `next.config.ts`, `lib/api.ts` mirroring
  admin-web's client, Vietnamese copy written inline in components — the spec
  rejected a message catalogue, so there is no `copy.ts` — and the catalog
  page rendering live data from task 4 with search and pagination. Widen CORS:
  `main.ts:21`'s single-origin echo becomes an env allowlist that still echoes one
  matching origin per request and never `'*'`. Add the new variables to
  `.env.example`. Responsive from 360 px (NFR-09).
  **Done when:** `pnpm --filter @knowledge-explorer/learner-web dev` on `:3002`
  lists a published course from the real API with no CORS error in the console,
  and the page has no horizontal scroll at 360 px.

- [x] **Task 6: category and course pages with ISR**
  Both pages with `generateStaticParams` over published courses and an incremental
  revalidate interval. Category page shows in-development levels unlinked
  (FR-CAT-02) — title and level label only, never content. Course page shows
  overview, objectives, prerequisites, the snapshot table of contents with
  free-preview lessons marked, and the price block when one exists.
  **Done when:** `pnpm --filter @knowledge-explorer/learner-web build` emits
  static entries for the published course and category, and both pages render
  their content at `:3002` from a production `start`.

## Slice D — Identity

- [x] **Task 7: learner authentication**
  `apps/learner-web/auth.ts`: Auth.js with `PrismaAdapter`,
  `strategy: 'database'`, log-only delivery mirroring `admin-web/auth.ts`, and a
  **distinct session cookie name**. Self-serve magic-link sign-up; new users take
  the schema default `learner` and the app never sets a role. Add
  `readLearnerSessionToken` to `apps/api/src/auth/optional-session.ts` reading
  **only** that cookie name — `SESSION_COOKIE_NAMES` and `SessionGuard` are not
  touched, so identity never depends on `Cookie` header order.
  **Done when:** an api test signs a request carrying *both* an admin and a
  learner cookie and asserts the admin endpoint resolves the admin user while the
  learner endpoint resolves the learner user, and `scripts/verify-magic-link.sh`
  still passes.

## Slice E — Reading

- [x] **Task 8: the reader page and the paywall**
  *Verified in a browser against the running stack: free preview renders
  anonymously with figure caption, table and an `X-Amz-Signature` URL against
  `S3_PUBLIC_ENDPOINT`; the paid lesson shows the paywall with no lesson text in
  the page source. The image OBJECT does not exist for this hand-seeded key, so
  "actually loads" is asserted in task 14 where the fake provider writes real
  bytes.*
  `app/lessons/[lessonId]/page.tsx` rendering through `LessonBody` from
  `@knowledge-explorer/content/render` — **the shared component, not a copy** —
  with the presigned `FigureImages` map from task 3, the snapshot table of
  contents, and prev/next navigation. On `LESSON_NOT_ENTITLED`, a paywall built
  from the course slug and title in the refusal body, with no second request.
  Anonymous readers see a sign-in prompt where the completion control belongs.
  **Done when:** a free-preview lesson renders signed out with `Figure 1` numbered
  and its table intact, its figure image actually loads in the browser, and a
  paid lesson shows the paywall with its body text absent from the page source.

- [x] **Task 9: the audio chain gate**
  In `reader.service.ts`: serve audio only when
  `narration_scripts.source_content_checksum === blockListChecksum(readBlockList(published_block_list))`
  **and** `lesson_audios.source_script_checksum === narration_scripts.script_checksum`.
  Both stored values already exist; compose them, do not derive a new one. When
  the chain does not resolve the lesson reads normally and reports no audio, and
  the snapshot's `hasAudio` / `audioDurationSeconds` are treated as
  table-of-contents hints rather than as the gate. Return per-segment
  `blockId`, `startMillisecond`, `endMillisecond` and the `lesson_audios.id` the
  player mints against.
  **Done when:** a `public-reader.e2e-spec.ts` case asserts audio is served for a
  freshly published lesson and withheld after a draft-only body edit, and restored
  after regeneration and republish.

- [x] **Task 10: the player**
  A client component wrapping the rendered body — **no change to
  `packages/content`**. Highlight follows `audio_segments` offsets against the
  `data-block-id` the renderer already emits; clicking a block seeks to its
  `startMillisecond`; speed is adjustable and persists across lessons in
  `localStorage`. The signed URL is minted when playback starts — not at page
  load — and re-minted when it nears expiry or a media request fails.
  **Done when:** playback highlights the correct block, a block click seeks, and a
  network log shows no signed-URL request before the first play.

## Slice F — Progress

- [x] **Task 11: the progress endpoint and the client writer**
  `PUT /lessons/:lessonId/progress` — learner-guarded with
  `@RequirePermission('buyAccessReadListenTrackProgress')` **and**
  entitlement-gated, so progress cannot be written for a lesson the caller may not
  read. Upsert on `(userId, lessonId)`. Client-side: scroll and audio position
  batched into a debounced write with a `pagehide` `sendBeacon` flush;
  mark-complete writes immediately. Anonymous readers write nothing, and nothing
  shadows `lesson_progress` in `localStorage`.
  **Done when:** an api test asserts the upsert, a `403 FORBIDDEN_ROLE` for an
  owner and for an admin, and a refusal for an unentitled lesson; and closing the
  tab mid-lesson leaves a non-zero `last_scroll_percentage` in the database.

- [x] **Task 12: `/me/courses` and the My Courses page**
  Every course the learner holds a grant for, active or not, with progress
  percentage, `expiresAt`, `daysRemaining` and a resume target (the most recently
  updated `lesson_progress` row for that course). Percentages computed from
  completed lessons over the snapshot's non-deleted published lesson count, so the
  denominator matches the table of contents. §7.4: an expired course stays listed
  with an expired badge and its progress; it is never hidden and its progress is
  never deleted. The repurchase action is the same price block — present only when
  an active product exists.
  **Done when:** an api test asserts an expired grant still lists its course with
  its progress intact, and the page resumes to the last-read lesson.

## Slice G — Keeping the cache honest

- [x] **Task 13: revalidation, both hooks**
  *The shared call lives in `packages/shared/src/revalidation.ts` rather than as
  two clients: api and worker may not import each other, but both may import
  shared, and one copy cannot drift from the other.*
  `app/api/revalidate/route.ts` in learner-web: shared-secret authenticated, takes
  a course slug, idempotent. Two callers, because api and worker may not import
  each other: `apps/worker/src/jobs/revalidate.client.ts` fired after the publish
  transaction commits (`publish.processor.ts:232`), and
  `apps/api/src/public/revalidate.client.ts` fired from
  `publishing.service.transition()` for unpublish and archive —
  `loadCourse` (`publishing.service.ts:226`) gains `slug` to make that possible.
  **Both swallow and log; neither may fail a publish.** No queue, no job type, no
  `job-permissions.ts` row.
  **Done when:** a worker test asserts the publish job still succeeds with the
  learner-web URL unreachable, and an unpublish removes the course page without
  waiting out the revalidate interval.

## Slice H — The end-to-end proof

- [x] **Task 14: browser suite scaffolding and steps 1–6**
  `playwright.config.ts` booting api (`:3001`), admin-web (`:3000`) and
  learner-web (`:3002`) through `webServer` with admin-web's 180 s build timeout,
  `fullyParallel: false`, one worker; `e2e/global-setup.ts` spawning the worker and
  waiting on `Worker ready.`, modelled on admin-web's. Scenario steps 1–6: seed and
  publish a paid course through the admin API (marking lesson 1 free-preview
  **through task 2's endpoint**); anonymous catalog and search; free-preview read
  asserting the figure's `<img src>` is presigned against `S3_PUBLIC_ENDPOINT` and
  **actually loads**; paywall with body text absent from the page source; E-01 on
  the media endpoint directly; magic-link sign-in, a hand-seeded grant, and a
  successful paid read.
  **Done when:** `pnpm --filter @knowledge-explorer/learner-web test:e2e` passes
  steps 1–6.

- [x] **Task 15: browser steps 7–11**
  Player (URL minted at play not at load, highlight follows offsets, click seeks,
  speed persists across lessons); progress and resume (non-zero scroll and audio
  position persisted, completion moving the course percentage, `/me/courses`
  resuming to the right lesson); expiry (backdated grant refuses the paid lesson,
  free preview still reads, course stays listed with its progress intact); audio
  staleness (draft edit leaves the published text and removes the player;
  republish restores it); unpublish (course leaves the catalog and its page 404s
  without waiting out the revalidate interval).
  **Done when:** the full eleven-step suite passes.

- [x] **Task 16: gate and record**
  `pnpm verify` green across the monorepo — including the new `packages/commerce`
  suite and every P0–P6 suite unedited — then the browser suite. Append
  implementation notes to this file: what was found that the plan did not predict,
  decisions taken during implementation, and anything P8 inherits. P6's notes are
  the model.
  **Done when:** `pnpm verify` and
  `pnpm --filter @knowledge-explorer/learner-web test:e2e` both pass from a clean
  checkout with Docker up and the migration applied, and the notes are written.

---

## Implementation notes

Written at completion, as P6's were. What the plan did not predict, what was
decided during implementation, and what P8 inherits.

### Four findings the plan did not predict

**`AUTH_URL` is global, and a second Auth.js instance silently inherits it.**
The repository keeps one `.env` at the root and `AUTH_URL` in it is admin-web's
`http://localhost:3000`. learner-web's Auth.js built every sign-in and callback
URL from that value, so `/api/auth/providers` advertised port 3000 while the app
served 3002 and every magic link 404'd. **`trustHost: true` did not fix it** — an
explicitly set `AUTH_URL` wins over host inference. The fix is one assignment at
the top of `apps/learner-web/auth.ts`, before `NextAuth()` is constructed:
`process.env['AUTH_URL'] = process.env['LEARNER_AUTH_URL']`. It is there rather
than in `next.config.ts` because that module is what reads it, and a dev server
evaluating route handlers in another worker would not see a config-time
mutation. **P8 will hit this again** if it adds a third Auth.js surface.

**The symptom was a Next 404 page, which looks exactly like a missing route.**
Half an hour went into checking `routes-manifest.json` before
`/api/auth/providers` gave the answer in one line. If a future auth route 404s,
read that endpoint first — it prints the base URL Auth.js actually believes.

**`sendBeacon` cannot carry the progress flush.** The spec named it; it is fixed
to POST and cannot be given `credentials: 'include'`, and apps/api is a different
origin (:3001 against :3002), so a beacon would arrive as an unauthenticated POST
to a credentialed PUT. `fetch(..., { keepalive: true })` survives the document
the same way and keeps both the method and the cookie.

**The api suites are sensitive to concurrent load on Postgres, and the failures
lie.** Running `pnpm test` while dev servers were up produced 4 failures across
different files on each run — `images`, then `narration`, one taking 26 s — all
of which passed in isolation. Killing the three dev servers dropped the run from
155 s to 32 s and all 411 passed. **A flaky api suite is a resource problem
before it is a test problem**; check for a running api, admin-web or learner-web
before investigating the test.

### Decisions taken during implementation

- **No `public.module.ts`.** The plan called for one; this app has exactly one
  Nest module and provides `OBJECT_STORAGE` and `PrismaService` there, so a
  separate module would have needed imports/exports plumbing nothing else in the
  app does. The four public controllers and three services are registered in
  `app.module.ts` like every other.
- **`LearnerSessionGuard` is a new guard, not a parameter on `SessionGuard`.**
  The plan anticipated `readLearnerSessionToken`; it did not anticipate needing
  a whole guard. `/me/courses` and the progress write declare a §3 permission, so
  they need a guard that populates `sessionContext` — and it must read only the
  learner cookie, for the ordering reason in `learner-session.e2e-spec.ts`.
- **The revalidation call lives in `packages/shared`, not as two clients.** The
  plan specified one client per app because api and worker may not import each
  other. Both may import `shared`, and one copy cannot drift from the other.
- **`packages/commerce` has a `vitest.config.mts` for the timeout only**, not for
  the glob the plan mentioned: packages have no `*.e2e-spec.ts`, and
  `packages/storage` sets the same timeout for the same reason.
- **`GET /lessons/:lessonId/progress` was added.** The plan listed only the PUT.
  The reader needs the learner's completion state and resume position on first
  paint, and it is deliberately NOT entitlement-gated — it returns only what this
  learner already wrote, and §7.4 keeps progress readable after expiry precisely
  so they can see what they would be coming back to.
- **Per-test sign-in in the browser suite.** Playwright gives every test its own
  context, so a session does not survive from one test to the next even in serial
  mode. Each test that needs a learner establishes one through a real magic link.

### What P8 inherits

- **`packages/commerce` holds entitlement and nothing else.** §11 also assigns it
  `PaymentProvider`; that half is untouched. `isGrantActive`,
  `hasAccessToCourse` and `hasAccessToLesson` are the only access decision in the
  system and P8 must call them rather than write a second one — that is the
  specific bug E-01 exists to prevent.
- **Nothing writes `access_grants`.** P7 reads them; the browser suite hand-seeds
  one because no endpoint creates one. Checkout, the webhook, manual grants and
  renewal stacking are all P8's, and §7.4's early-renewal case still needs its
  dedicated unit test.
- **The price block and the repurchase action are already wired.** Both query the
  real `products` table and render only when an active row exists, so P8 inserts
  products and they light up with no learner-web change. `data-testid="price-block"`,
  `bundle-offer` and `repurchase` are the hooks.
- **`active_product_for_paid` blocks publishing a paid course.** The browser suite
  publishes as `free` and restores `paid` afterwards, because no product can exist
  yet. Once P8 ships products, that workaround in `learner.spec.ts` test 1 can go.
- **The expiry-reminder job will need `JobStatusService.instances()`** — P6's
  note about the silent 404 applies to `send_expiry_reminder`. P7 added no queue,
  so it did not hit it.

### Known limitation, recorded deliberately

**The player disappears from a lesson while an admin is mid-edit.** §8 gives
`narration_scripts` and `lesson_audios` no published track, so the only available
proof that audio voices the published words is the §6.5 checksum chain. When an
admin regenerates narration against an edited draft, the chain stops resolving
and the lesson reads without audio until the next publish. Asserted in
`public-reader.e2e-spec.ts` and in browser test 11. The fix, if this proves
unacceptable, is a published track for narration and audio — a migration and a
change to P6's publish job, so it belongs in its own phase.

### Two files this phase did not intend to create

`apps/learner-web/AGENTS.md` and `apps/learner-web/CLAUDE.md` are generated by
`next dev` (Next 16's `generate-agent-files.js`) and reappear whenever the dev
server runs. admin-web does not have them. They are build artifacts rather than
source; gitignore them or commit them, but they are not P7's work.
