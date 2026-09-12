# Tasks: P3 — Images

**Plan:** `specs/p3-images/plan.md`
**Spec:** `specs/p3-images/spec.md`

Ordered. Tick boxes as tasks complete — this file is the durable progress state
and is the thing that survives a lost session, so update it as you go rather
than at the end.

Slices A–G follow the plan. Slice B is the phase's walking skeleton: finish it
and an admin can upload an image and see it in the preview, end to end, before
any provider, queue or job exists.

---

## Slice A — Object storage substrate

- [x] **Task 1: MinIO in Compose and CI**
  Add a `minio` service to `docker-compose.yml` with a healthcheck, plus a
  short-lived `minio/mc` init container that creates the bucket and leaves it
  private — no anonymous read policy. Map host ports **9010:9000 and
  9011:9001**, not 9000/9001: `php-fpm` already listens on 9000 on the
  development machine, which is the same class of conflict the file already
  documents for Redis. Add the same service to `.github/workflows/ci.yml` on
  9000/9001, where nothing conflicts, mirroring Redis's 6380-local/6379-CI
  split. Add every `S3_*` variable to `.env.example` and to CI's `env` block,
  each with the comment saying why it exists — especially the two endpoints.
  - done when: `docker compose up -d --wait` exits 0 with `minio` healthy, and
    `docker compose run --rm mc ls local/<bucket>` exits 0 against an empty
    bucket.

- [x] **Task 2: `packages/storage` skeleton, interface and key minting**
  New workspace with `package.json` (`typecheck` and `test` scripts so turbo
  picks it up), `tsconfig.json` extending
  `packages/shared/tsconfig.base.json`, and a barrel. `src/object-storage.ts`
  declares the `ObjectStorage` interface and an `OBJECT_STORAGE` Symbol token,
  following `EMAIL_PROVIDER`'s pattern. `src/keys.ts` holds the single function
  that mints an object key from lesson id, block reference id, image id and
  extension — no caller ever concatenates one.
  - done when: `pnpm install` succeeds and
    `pnpm --filter @knowledge-explorer/storage test` passes unit tests asserting
    that two images of one figure get distinct keys, that keys for different
    lessons never collide, and that the extension follows the content type.

- [x] **Task 3: The S3/MinIO implementation**
  `src/s3-object-storage.ts` over `@aws-sdk/client-s3` and
  `@aws-sdk/s3-request-presigner`: put with content-type metadata, get, and
  presign with a 10-minute expiry. Reads and writes use `S3_ENDPOINT`;
  presigning uses `S3_PUBLIC_ENDPOINT`, because an S3 signature covers the host.
  - done when: the storage suite passes against the running MinIO — an object
    round-trips byte-identical with its content type intact, a presigned URL
    fetches it, and a URL signed against a deliberately divergent endpoint is
    rejected when requested against the public host. That last assertion is the
    one that keeps the two variables from being collapsed into one.

- [x] **Task 4: Type sniffing and the size guard**
  `src/upload-safety.ts`: detect PNG, JPEG and WebP from their magic bytes, and
  SVG by finding an `<svg>` root past any BOM, XML declaration, whitespace or
  comment. The declared `Content-Type` and the filename are never consulted.
  Enforce the 5 MB ceiling. Both failures return a discriminated result carrying
  the `errorCode`, never a thrown string.
  - done when: fixture tests pass — each of the four types is identified from
    bytes alone, a PDF renamed `.png` is rejected as unsupported, a GIF is
    rejected, and a 6 MB buffer is rejected as oversize.

- [x] **Task 5: SVG sanitization**
  Sanitize with DOMPurify over `jsdom` using its SVG profile, and return the
  cleaned bytes — the cleaned bytes are what callers store. Both dependencies
  are server-only and must not leak out of `packages/storage`.
  - done when: a fixture SVG carrying `<script>`, an `onload` attribute, a
    `javascript:` href and a `<foreignObject>` comes back with all four removed
    and its drawable content intact, and
    `pnpm --filter @knowledge-explorer/content test` still passes
    `isomorphic.spec.ts` — proving nothing server-only entered the browser graph.

## Slice B — Walking skeleton: upload, select, see it

- [x] **Task 6: Error codes and the renderer's image types**
  Add `IMAGE_TYPE_UNSUPPORTED`, `IMAGE_TOO_LARGE`, `IMAGE_BLOCK_NOT_FOUND` and
  `IMAGE_NOT_FOUND` to `packages/shared/src/errors.ts`. Add the `FigureImage`
  shape and the `blockId → FigureImage` map type to
  `packages/content/src/types.ts`. No enum changes: `image_source` and
  `job_type` already carry every member P3 uses.
  - done when: `pnpm typecheck` passes repo-wide and
    `pnpm --filter @knowledge-explorer/shared test` passes with the §8.1
    catalogue test unchanged.

- [x] **Task 7: The renderer renders an image**
  `LessonBody` takes an optional `images` map, defaulting to empty. `Figure`
  renders an `<img>` with its alt text and a `<figcaption>` reading
  "Figure N — caption" when the map has an entry for the block, and P2's
  numbered placeholder when it does not. The figure number comes from the block,
  never recomputed. No click handling enters the renderer — it is shared with P7.
  - done when: `packages/content/test/render.spec.tsx` passes with the existing
    placeholder assertion untouched plus new cases for the image path, an entry
    keyed to a different block being ignored, and the caption text; and
    `isomorphic.spec.ts` still passes.

- [x] **Task 8: `GET /admin/lessons/:lessonId/images`**
  New `images.controller.ts` and `images.service.ts` under
  `apps/api/src/content/`. The `GET` reads the lesson's stored block list and
  returns one entry per figure block — `blockId`, `figureNumber`, candidates
  newest first, which is selected, caption, alt text — each candidate carrying a
  freshly presigned URL. Register everything in `app.module.ts` with explicit
  `@Inject` tokens; `emitDecoratorMetadata` is off.
  - done when: `apps/api/test/images.e2e-spec.ts` boots and a lesson with two
    `::figure` blocks returns two entries in document order with empty candidate
    lists, and a lesson with no figures returns an empty array.

- [x] **Task 9: `POST /admin/lessons/:lessonId/images/upload`**
  Multipart via `FileInterceptor` with the 5 MB limit set **on the interceptor**,
  so an oversize body is refused before it is fully buffered. Sniff, sanitize,
  write the object, then insert the row — object first, so a row never points at
  bytes that are not there. New rows: `image_source = 'uploaded'`, null prompt,
  model and provider, `is_selected = false`, empty caption and alt text.
  `figure_number` is left NULL and never written.
  - done when: the e2e suite passes — a valid WebP returns `201` with
    `image_source = 'uploaded'`; a PDF renamed `.png` returns `422`
    `IMAGE_TYPE_UNSUPPORTED`; a 6 MB file returns `422` `IMAGE_TOO_LARGE`; an
    unknown `blockReferenceId` returns `422` `IMAGE_BLOCK_NOT_FOUND` and writes
    nothing; and an uploaded script-bearing SVG reads back from storage with no
    `<script>`.

- [x] **Task 10: `PATCH /admin/images/:imageId` — selection**
  Clear `is_selected` on every other row for the same
  `(lesson_id, block_reference_id)` and set it on this one, inside a single
  `$transaction`, so the §6.2 invariant holds at every observable point. §8
  defines no partial unique index for this and P3 opens no migration; the
  transaction is the enforcement.
  - done when: the e2e suite passes — after switching selection three times
    exactly one row for that block has `is_selected = true`, and a selection on
    a different figure block of the same lesson leaves the first block's
    selection untouched.

- [x] **Task 11: Guard the image routes**
  Add an `imageId` branch to `WriteTargetResolver` joining image → lesson →
  chapter → course and returning the same `WriteTarget` shape. Put
  `PublishedLockGuard` and `AssignmentGuard` on all three image writes and on
  neither read, matching the method-level split `lesson-content.controller.ts`
  documents. Every endpoint declares `generateAndSelectImages`; the §3 matrix is
  not touched.
  - done when: `apps/api/test/rbac.e2e-spec.ts` passes with new rows — an
    `admin` patching an image in a `published` course gets `403`
    `FORBIDDEN_COURSE_PUBLISHED`; on a lesson assigned to another admin, `403`
    `FORBIDDEN_NOT_ASSIGNED`; on an unassigned lesson, success; the same admin's
    `GET` succeeds in every case; a `learner` gets `403` on all of them. Without
    the resolver branch these rows fail, which is the point of writing them.

- [x] **Task 12: The drawer opens on the right figure**
  `image-drawer.tsx` plus the wiring in `lesson-editor.tsx`: keep the block list
  the content endpoint returned, attach one delegated click listener to the
  preview container, read `data-figure-number` off the closest `<figure>`, and
  resolve the server's `blockId` by matching that number in the **saved** block
  list. A click first flushes the pending autosave and waits; placeholders are
  not clickable while the markdown fails to parse; a figure never saved cannot
  be opened. On a lesson the caller may not write, the drawer opens read-only
  with every control disabled.
  - done when: a component test in `apps/admin-web/test/figure-resolve.spec.ts`
    proves the resolution rule in isolation — given a saved block list and a
    clicked `data-figure-number`, it returns the matching server `blockId`, and
    returns nothing when the buffer is dirty or the parse failed. Plus, in the
    browser: opening the drawer on Figure 2 of a two-figure lesson shows that
    figure's number, and every control is disabled when signed in as an `admin`
    on a published course.

- [x] **Task 13: Upload and select from the drawer**
  `apiUpload` in `lib/api.ts` for multipart alongside the JSON `apiFetch`.
  Candidate grid, upload control, and selection. Selecting a candidate rebuilds
  the images map the editor passes to `LessonBody`, so the preview's placeholder
  becomes the image with no reload.
  - done when: uploading a PNG through the drawer and selecting it replaces the
    preview placeholder with that image, and reloading the page shows it still
    selected.

## Slice C — Captions and completeness

- [x] **Task 14: Caption, alt text and copy-forward**
  `PATCH` accepts `captionText` and `alternativeText` on any row, selected or
  not. When selection moves, copy both from the previously selected row onto the
  new one **in the same transaction** — they describe the figure, not the
  candidate, and §5.5 feeds both to P4. Add the fields to the drawer with helper
  text stating FR-IMG-03's editorial standard.
  - done when: the e2e suite passes — write caption and alt on candidate A,
    select candidate B, and B carries both; and writing a caption on an
    unselected row is accepted and stored.

- [x] **Task 15: Image-completeness**
  A lesson is image-complete when every figure block in its stored block list
  has exactly one selected row whose caption and alt text are both non-empty
  after trimming; a lesson with no figures is complete. Computed on read, stored
  nowhere, following §6.5's rule for staleness. Returned by the images `GET` and
  shown as a per-figure marker and a lesson-level summary. **No status column is
  written** — `content_status` stays where P2 left it.
  - done when: the e2e suite passes — incomplete while the caption is empty,
    incomplete while alt text is whitespace only, complete once both are
    non-empty on the selected row, complete for a lesson with no figures; and an
    assertion that `lessons.content_status` is unchanged throughout.

## Slice D — The provider package

- [x] **Task 16: `packages/ai` wiring and the interface**
  The package has no test script, no vitest and no dependencies today. Add
  them. `src/image-generation.provider.ts` declares the request and candidate
  types, the `ImageGenerationProvider` interface and an
  `IMAGE_GENERATION_PROVIDER` Symbol token. The provider turns a prompt into
  bytes and touches nothing else — no database, no queue, no storage.
  - done when: `pnpm --filter @knowledge-explorer/ai test` runs and passes, and
    `pnpm typecheck` passes repo-wide.

- [x] **Task 17: The versioned prompt template**
  `src/image-prompt.ts`: an exported version identifier and a composer that
  wraps the admin's text with the lesson title, the course `languageCode`, the
  house illustration direction and an explicit instruction to render no text,
  labels or numerals inside the image. The composed string — version identifier
  at its head — is what gets stored in `image_prompt_text`, which is how NFR-08
  is satisfied without a `prompt_version` column. Record the neutral default
  style the spec's open question leaves to the owner, plainly, so revising it is
  a one-line change plus a version bump.
  - done when: tests assert the composed string contains the admin's text
    verbatim, the title, the language code and the no-text instruction, and that
    it begins with the version identifier so a stored prompt maps back to its
    template.

- [x] **Task 18: The fake provider and env-driven selection**
  `src/fake-image.provider.ts` returns deterministic PNGs derived from a hash of
  the prompt and the candidate index — same input, same bytes; different indexes,
  different bytes. `providerName` is `fake` and `modelName` carries the fake's
  version, so its rows are never mistaken for real ones.
  `src/provider-factory.ts` selects by `IMAGE_PROVIDER`: anything but `openai`,
  including unset, gives the fake; `openai` with no `OPENAI_API_KEY` throws at
  construction rather than downgrading silently.
  - done when: tests assert exact candidate counts for 2, 3 and 4; byte-identical
    output across two calls with the same prompt and index; different bytes
    across indexes; and both selection rules, including the throw.

- [x] **Task 19: The OpenAI adapter**
  `src/openai-image.provider.ts` calls OpenAI's image API with `n =
  candidateCount` and decodes the base64 payloads. Pin the model identifier
  against current OpenAI documentation and record it, with its pricing, in the
  adapter — the discipline §6.3 applies to the narration model.
  - done when: a recorded response body decodes to the expected number of images
    with model and provider names mapped correctly (no network), **and**
    `packages/ai/test/openai-image.live.spec.ts` — which skips unless
    `OPENAI_API_KEY` is set — returns 2 decodable images of a supported type when
    run by hand.

## Slice E — The generation pipeline

- [x] **Task 20: Queue constants**
  Add `IMAGE_QUEUE_NAME`, `imageJobNames` and the job payload type to
  `packages/shared/src/queues.ts`, reusing the existing `JOB_MAX_ATTEMPTS` and
  `JOB_BACKOFF_DELAY_MS` so producer and consumer cannot drift.
  - done when: `pnpm --filter @knowledge-explorer/shared test` passes and
    `pnpm typecheck` is clean repo-wide.

- [x] **Task 21: `POST /admin/lessons/:lessonId/images/generate`**
  `image.queue.ts` mirroring `import.queue.ts`. The endpoint validates
  `candidateCount` as an integer in 2–4 defaulting to 4, rejects a
  `blockReferenceId` that is not a figure block in the **stored** block list,
  composes the prompt, writes a `generation_jobs` row through
  `createQueuedJob` with `job_type = 'generate_image'` and
  `target_entity_id = lessonId`, enqueues, and returns `202 { jobId }`.
  - done when: the e2e suite passes — `202` with a job row carrying the right
    type and target; `422` for counts of 1 and 5; absent count defaults to 4;
    `422` `IMAGE_BLOCK_NOT_FOUND` for an unknown block, writing no row and
    enqueuing nothing.

- [x] **Task 22: The worker consumes the image queue**
  `image.worker.ts`, `image-worker.service.ts` and module registration,
  mirroring the import trio, with bounded concurrency set low because every job
  is a paid call, and NFR-07 failure logging. Update `main.ts` so the ready log
  names both queues — **and in this same task** change
  `apps/api/test/helpers/worker-process.ts` and
  `apps/admin-web/e2e/global-setup.ts` to wait on the stable `Worker ready.`
  prefix instead of the import-specific sentence. Both currently match a literal
  that is about to become false; missing either makes every e2e suite hang until
  timeout and fail with a message that points nowhere near the cause.
  - done when: `pnpm test` passes repo-wide — specifically P1's
    `import.e2e-spec.ts` and `job-stream.e2e-spec.ts`, which both spawn a real
    worker and would hang if a helper were missed.

- [x] **Task 23: The image processor**
  `image.processor.ts` wrapped in P1's `withJobLifecycle`: call the provider,
  write every object, then insert all rows together. A provider call that throws
  writes nothing at all. New rows are unselected, `ai_generated`, with empty
  caption and alt text and the composed prompt, model and provider recorded.
  Comment the append-on-retry consequence — a retry after a partial object write
  adds a fresh set rather than replacing — so a later reader does not "fix" it
  into a destructive replace.
  - done when: `apps/worker/test/image-processor.spec.ts` passes — a successful
    job writes N objects and N rows with the right shape; a throwing provider
    writes neither and the `generation_jobs` row records the attempt and message;
    after three failed attempts the row is `failed` with `attempt_count = 3`; and
    a second job for the same block appends rather than replacing.

## Slice F — Job streams

- [x] **Task 24: Widen job-stream authorization**
  `job-permissions.ts` maps `job_type` to its §3 action —
  `import_course_outline` → `importCurriculumOutline`, `generate_image` →
  `generateAndSelectImages` — and marks which types are lesson-targeted.
  `JobStatusService` holds a list of queues and resolves across all of them,
  with `JobSnapshot`'s shape byte-identical so `admin-web`'s hand-mirrored copy
  needs no edit. `jobs.controller.ts` drops the hardcoded
  `importCurriculumOutline` and applies R-02 for lesson-targeted jobs.
  - done when: `apps/api/test/job-stream.e2e-spec.ts` passes — an assigned
    `admin` receives snapshots for a `generate_image` job through to a terminal
    event; an unassigned `admin` gets `403` `FORBIDDEN_NOT_ASSIGNED`; the
    existing import-stream assertions still pass; and a subscriber connecting
    *after* the job finished still receives the terminal snapshot.

- [x] **Task 25: `GET /admin/courses/:courseId/stream`**
  New `course-stream.controller.ts` emitting a `JobSnapshot` for every
  non-terminal `generation_jobs` row whose target resolves to this course, and
  completing when none remain. It declares the broader action,
  `generateAndSelectImages`, then filters each snapshot through the same
  job-type mapping and R-02 check the per-job stream applies — so an `admin`
  watching a course sees their own image jobs and not the owner's import job.
  - done when: the e2e suite passes — the stream carries both an import job and
    an image job on one course for the owner and completes when neither is
    outstanding, while an `admin` on the same course receives the image job and
    never the import job.

## Slice G — Close out

- [x] **Task 26: Generate from the drawer**
  Prompt box, candidate-count selector defaulting to 4, generate button, and
  `JobProgress` wired to the job stream. Candidates append newest first on
  completion; earlier rounds stay visible and selectable. A failed job surfaces
  its `errorMessage` with a retry. The left pane stays editable throughout —
  FR-IMG-01 requires generation not to block editing.
  - done when: generating from the drawer shows progress, lists the new
    candidates on completion, and typing in the editor during the job still
    autosaves.

- [x] **Task 27: NFR-05 image counts**
  The derivation on `images.service.ts`: count `lesson_images` rows with
  `image_source = 'ai_generated'`, per lesson and rolled up per course. No
  endpoint — §9.2's `/courses/:courseId/usage` is deferred because §3 has no
  permission row for viewing cost data and `roles.ts` denies by default. Leave
  the derivation ready and tested for P10.
  - done when: a test asserts the count ignores uploads, counts every generated
    candidate rather than only selected ones, and rolls up from lesson to course
    across two chapters.

- [x] **Task 28: The browser journey**
  `apps/admin-web/e2e/images.spec.ts`, the spec's fourteen steps. Steps 9, 12
  and 13 are the load-bearing ones: caption follows the figure across a
  selection change, the image follows the `blockId` when a figure is inserted
  above it, and the figure number follows the block list when one is deleted.
  - done when: `pnpm --filter @knowledge-explorer/admin-web run test:e2e` passes
    with the new spec and P1's and P2's suites all green.

- [x] **Task 29: Full verification and documentation**
  Run the spec's end-to-end verification from a clean checkout. Confirm no
  `OPENAI_API_KEY` is needed. Refresh `.env.example` comments, and note in
  `.claude/harness/` that `packages/storage` exists as a sixth workspace and why
  — the harness currently records five packages and three of them empty.
  - done when: `docker compose up -d --wait && pnpm install --frozen-lockfile &&
    pnpm db:migrate && pnpm test` exits 0, then
    `pnpm --filter @knowledge-explorer/admin-web run test:e2e` exits 0, with no
    `OPENAI_API_KEY` set in the environment.

---

## Progress notes — Slice A

**The bucket is created by the storage layer, not a Compose init container.**
Task 1 specified a one-shot `mc` container. Two facts killed it, both measured
rather than assumed:

- `docker compose up -d --wait` exits **1** when any service exits, even with
  code 0 — verified with a scratch compose file. That command is step 1 of the
  spec's end-to-end verification and is `[verified]` in the harness, so breaking
  its exit code was not acceptable.
- GitHub Actions `services:` cannot set a container command, and the MinIO image
  does nothing without `server /data`. An init container cannot be expressed
  there at all.

`S3ObjectStorage.ensureBucket()` does it instead: HeadBucket, and CreateBucket
if absent, memoized per process. It works identically under Compose and in CI,
and a bucket created through the S3 API has no public policy — nothing in the
codebase ever sets one, which is what keeps it private per §11.

**MinIO comes from quay.io, not Docker Hub.** `docker pull minio/minio` returns
"pull access denied ... repository does not exist" for an unauthenticated
client, while `docker pull hello-world` succeeds — so it is the repository, not
the daemon. `quay.io/minio/minio` and `quay.io/minio/mc` pull anonymously and
are MinIO's own published images. Both are pinned to exact `RELEASE.*` tags,
matching how this project pins `postgres:16` and `redis:7`.

**MinIO is a CI step, not a CI service**, for the command reason above. It runs
under `docker run -d` with an explicit readiness loop against
`/minio/health/live`.

**Host ports 9010/9011.** Confirmed with `lsof` that `php-fpm` holds 9000 on
this machine, exactly as the plan predicted. CI maps 9000/9001, mirroring the
Redis 6380-local/6379-CI split this repository already uses.

**Error codes landed early.** Task 6 was to add the four image error codes to
`packages/shared/src/errors.ts`; Task 4 needed two of them, and
`conventions.md` forbids inventing a bare string. They went in with Task 4, and
`packages/storage` took `@knowledge-explorer/shared` as a real dependency rather
than a dev one. Task 6 is correspondingly smaller.

**The endpoint-divergence assertion is real.** `s3-object-storage.spec.ts` signs
a URL for `http://internal-minio:9000`, rewrites the origin to the endpoint a
browser can reach, and asserts `403 SignatureDoesNotMatch`. Locally both
endpoint variables hold the same value, so without constructing the divergence
deliberately the distinction would be untested — and a wrong-client bug would
surface only in production.

**Slice A state:** 34 storage tests; 18 turbo tasks green repo-wide; 425 tests
across 8 workspaces. `isomorphic.spec.ts` still passes, so neither the AWS SDK
nor jsdom reached the browser graph.

## Progress notes — Slices B to F (server side complete)

**Everything server-side is done and verified. Not done: the admin-web drawer
(Tasks 12, 13, 26) and the Playwright journey (Task 28), so the feature has no
user interface yet.** The API, worker, provider, storage and streams are
complete and under test.

**Image job ids are qualified, `image:<n>`.** BullMQ ids are a per-queue
counter, so the moment a second queue existed "job 1" stopped being unique and
`/admin/jobs/1/stream` became ambiguous. `ImageQueue.enqueueGenerate` returns a
prefixed id and `JobStatusService.locate` routes on it. Import ids stay
unprefixed, so P1's flow and its screens are untouched.

**`JobSnapshot` gained `targetEntityId`.** The plan promised not to change the
shape; this is additive, and `apps/admin-web/lib/job-types.ts` mirrors a subset
by hand so it needed no edit. It exists so `JobWatchGuard` can apply R-02
without a second lookup.

**The job stream is authorized in two stages.** RolesGuard can only test one
declared action, and the stream now carries types with different ones. It
declares the broader `generateAndSelectImages`; `JobWatchGuard` then applies the
job type's own action and, for a lesson-targeted job, R-02. The §3 map is
PARTIAL and denies unmapped types, so P4/P5/P6 adding a producer without adding
its row fails closed.

**An unknown job id is deliberately NOT refused by the guard.** P1's contract is
that the stream opens and emits a JOB_NOT_FOUND event rather than 404ing — the
first version of the guard broke that, and `job-stream.e2e-spec.ts` caught it.

**`rbac.e2e-spec.ts`'s stream row moved from owner-only to owner-or-admin.**
§9.3 lists the streams as admin endpoints; P1 could declare the narrower action
because import was the only producer. The narrowing is now per job, and
`job-stream.e2e-spec.ts` asserts an admin is still refused an import job.

**The per-course stream reports generation_jobs rows, not BullMQ jobs**, and its
event type is `CourseJobSnapshot` rather than `JobSnapshot`. "What is happening
on this course" is a question about the course; there is no BullMQ id in play
and putting two id spaces behind one field would be worse than a second type.

**The processor tolerates a missing `createdByUserId`.** §8 makes the column
nullable. The worker test found that an empty value failed the whole job three
times with an opaque Postgres uuid-syntax error, which is a bad way to learn a
payload was incomplete.

**`readBlockList` and `editorOf` are now exported** from the P2 modules that
owned them, rather than copied — `conventions.md` asks for reuse over
duplication.

**Oversize uploads answer 422, not Nest's 413.** Nest's multer bridge maps
`LIMIT_FILE_SIZE` to PayloadTooLargeException, a bare 413 with no errorCode.
`UploadTooLargeFilter` remaps it onto the same 422 and `IMAGE_TOO_LARGE` the
byte-level check produces: 413 is the more conventional status, but a caller
should not branch on two answers for one condition, and conventions.md requires
a machine-readable code. Catching what Nest actually throws also removed the
`multer` and `@types/multer` dependencies added while chasing it.

**Integration test timeouts were raised to 30s** in `apps/api` and
`packages/storage`. This was measured, not guessed: a clean worktree at HEAD ran
green 3/3 at default turbo concurrency while this branch failed 2 of 3, and
`--concurrency=1` was green 2/2 — so the failures were vitest's 5s default
expiring under load, in P2 suites this phase never touched, not anything
failing. 5s is a unit-test budget and these suites cross HTTP, Postgres and
MinIO.

**One unexplained intermittent failure remains.** A single run saw
`PATCH /admin/images/:imageId` answer 400 in the completeness test, under full
turbo concurrency. It did not recur in eight subsequent full runs nor in five
isolated runs of that suite, and the cause is NOT established. A diagnostic is
left in `images.e2e-spec.ts` that prints the response body if it happens again.

**Slice B-F state:** 19 turbo tasks green; 8 workspaces; `apps/api` 196 tests,
`apps/worker` 11, `packages/storage` 34, `packages/ai` 18 (+1 skipped live),
`packages/content` 102.

## Progress notes — Slice G, and a defect the browser suite found

**All 29 tasks are done.** Final state: 506 tests across 8 workspaces plus 7
Playwright tests, with no `OPENAI_API_KEY` set.

**The preview joins images by FIGURE NUMBER, not by blockId.** This was the
bug step 12 existed to find, and the first implementation had it. The images API
is keyed by the SERVER's blockIds; the preview renders blocks from a LOCAL parse
whose ids P2 makes display-only. The two coincide by accident until a figure is
inserted above an illustrated one, at which point the picture is drawn on the
wrong figure. §6.1's figure number means the same thing in both parses, so it is
the correct join key.

**The images view is reloaded on a figure signature.** It carries each figure's
number, so a save that renumbers makes it stale. Refetching on
`blockId:figureNumber` for the lesson's figures refetches when it matters and
not on every keystroke.

**Candidate ordering needed a tiebreaker.** `orderBy: createdAt desc` alone is
unstable, because a generation writes its whole candidate set in one
`createMany` and those rows share a timestamp — the drawer reshuffled between
reads. Now `[{createdAt: desc}, {id: desc}]`, with a regression test that reads
the same figure five times.

### Known defect: deleting a figure can orphan a DIFFERENT figure's image

Verified directly against `packages/content`:

| Step | Server block ids |
|---|---|
| One figure, illustrated | `fig2` |
| Insert a figure **above** it | `fig4` (Figure 1, new), `fig2` (Figure 2, illustrated) — correct |
| Delete the **upper** figure | survivor is `fig4`, the imageless one; `fig2` retires |

Every figure block flattens to empty `text`, so P2's identity matcher cannot
tell two figures apart and matches them positionally. Deleting a figure that
sits above an illustrated one therefore re-keys the survivor, and the
illustration becomes an orphan: not destroyed — the never-delete rule holds —
but no longer shown, and with no UI to recover it.

The spec's step 13 assumed the image would follow. It cannot, and the browser
suite now asserts the real behavior so it cannot change silently.

**This is not fixable inside P3's scope.** The fix is to give figure blocks
distinguishable identity, which means changing `packages/content` — explicitly a
non-goal ("the parser is not touched"). Options for a spec amendment:

- give `::figure` an optional stable key (`::figure{#stroke-order}`), which
  changes the §5.3 dialect P2 locked;
- have the identity matcher treat figures as distinguishable by ordinal among
  figures rather than by flattened text;
- have P3's orphan rule reattach on delete — rejected here as too magical to do
  silently.

It also raises the value of the "reattach an orphan" UI that the spec's
interview deliberately declined, since that would give an admin a way back.

