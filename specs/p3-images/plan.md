# Plan: P3 — Images

**Spec:** specs/p3-images/spec.md
**Status:** Approved
**Date:** 2026-09-12

## Objective

Fill P2's empty `::figure` slot: give an admin a way to generate or upload an
illustration, choose one, and write the caption and alt text that P4's narration
generator will read — and, in doing so, stand up the object storage, the second
queue producer and the first real provider adapter that P4, P5, P6 and P8 all
inherit.

## Approach

### Build order: substrate, then the shortest vertical slice, then generation

The spec's scope divides into three substrates (object storage, the provider
package, the queue's second producer) and three features (upload, generation,
selection with captions). Building all three substrates first would postpone
every observable behavior to the end of the phase, so the order here is:

1. **Object storage only** — the one substrate nothing else can proceed without.
   Kept deliberately thin: put, get, presign, and a byte-safety module.
2. **Upload → select → visible in the preview.** This is the shortest complete
   path through the whole stack — storage, an endpoint, the shared renderer, the
   drawer — and it needs no provider, no queue and no job at all. It is the first
   thing that can be demonstrated, and it de-risks the drawer's hardest
   mechanic (resolving the server's `blockId`) before any AI work starts.
3. **Captions, copy-forward and completeness**, closing FR-IMG-03 on the path
   that already works.
4. **Provider package, then the generation pipeline**, which re-uses the drawer,
   the storage module and the row shape that steps 2 and 3 already proved.
5. **Job-stream widening and the course stream**, which only have a second
   producer to serve once generation exists.

FR-IMG-02 is not a fallback in build order even though §5.4 frames it as a
fallback in product terms. It is the synchronous, dependency-free path, so it
makes everything downstream cheaper to test.

### `packages/storage`, and why the sanitizer lives in it

The spec settles the new workspace and records the §11 deviation. Two
implementation consequences:

- The AWS S3 SDK and `jsdom`/DOMPurify are heavyweight, server-only
  dependencies. Confining them to a package that only `apps/api` and
  `apps/worker` import is what keeps them out of the browser bundle.
  `packages/shared` and `packages/content` are both reachable from `admin-web`,
  and P2's `isomorphic.spec.ts` asserts the parser's transitive import graph
  contains no `node:` builtin — which transitively guards `shared` too, since
  `content` imports it. That test is the tripwire if either package is polluted.
- Upload safety — sniff the type, enforce the size, sanitize SVG — lives beside
  the code that writes bytes rather than in `apps/api`, so "bytes that reach
  storage have been validated" is a property of one module rather than a rule
  callers must remember. P5 and P8 both write media and inherit it.

SVG sanitization uses DOMPurify over `jsdom` with its SVG profile, not a
hand-rolled allowlist. Writing a novel sanitizer for a format designed to be
extensible is how holes get shipped; this is the one place in the project where
a well-trodden dependency beats the codebase's usual preference for explicit
local code.

Type detection is hand-rolled and reads magic bytes: PNG, JPEG and WebP have
unambiguous signatures, and SVG is detected by parsing for an `<svg>` root
after any BOM, XML declaration, whitespace or comment. No dependency is needed
and every case is a fixture test. The declared `Content-Type` and the filename
are never consulted.

### Resolving the clicked figure to the server's `blockId`

The spec's rule is "by the figure's ordinal position among figure blocks in the
saved block list". The implementation is simpler than that phrasing suggests:
`figureNumber` **is** that ordinal, assigned by the parser and counted from 1
within the lesson. So the drawer looks up the saved block list's figure block
whose `figureNumber` equals the one the clicked placeholder rendered.

That equality only holds when the buffer and the server agree, which is why a
click first flushes the pending autosave. The preview parses the live buffer
with no previous block list (P2's deliberate choice — its ids are display-only),
so before the flush the local figure 2 may be the server's figure 1.

The click handler does **not** go into `LessonBody`. The renderer is shared with
P7 and an editor interaction has no business in it; the preview container in
`lesson-editor.tsx` attaches one delegated listener and reads
`data-figure-number` off the closest `<figure>`, which P2's markup already
emits. The renderer's only change is the optional images map.

### The two S3 endpoints

`S3_ENDPOINT` is what `apps/api` and `apps/worker` use to read and write;
`S3_PUBLIC_ENDPOINT` is what presigned URLs are signed against, because an S3
signature covers the host and a URL signed for an internal hostname fails in a
browser with an opaque `SignatureDoesNotMatch`.

Locally the two are the same value — `apps/api` and `apps/worker` run on the
host via pnpm, not inside Compose, so both they and the browser reach MinIO on
localhost. The split therefore buys nothing in development and everything in
production, which is precisely why it is a risk rather than a convenience (see
Risks).

### Job plumbing: extend P1's shapes, do not parallel them

`apps/api/src/jobs/import.queue.ts` and `apps/worker/src/jobs/import.worker.ts`
are both written as one-queue-specific modules. P3 adds a sibling image queue
rather than generalizing them into a queue factory: two instances is not yet
enough evidence for an abstraction, and P5 will add a third, which is the point
at which the shared shape will be obvious. The pieces that genuinely must be
shared — retry policy, backoff, max attempts, queue names — already live in
`packages/shared/src/queues.ts` and are reused as-is.

`JobStatusService` is the exception: it takes a single `ImportQueue` today and
must resolve a job across both queues. It is generalized to hold a list of
queues and try each, keeping `JobSnapshot`'s shape byte-identical so
`apps/admin-web/lib/job-types.ts` — which mirrors it by hand — needs no change.

`generation_jobs` lifecycle, structured logging and the `createQueuedJob` helper
all already exist in `packages/database/src/generation-jobs.ts` and are called
unchanged. The image processor is wrapped in P1's `withJobLifecycle`.

### The `imageId` guard target

`WriteTargetResolver` resolves R-01 and R-02 targets from route params in order:
`chapterId`, `lessonId`, `courseId`. `PATCH /admin/images/:imageId` carries none
of them, so today the resolver would return `undefined` and both rule guards
would stand aside — silently unguarded writes. An `imageId` branch is added that
joins image → lesson → chapter → course, returning the same `WriteTarget` shape.
This is a correctness fix, not a convenience, and `rbac.e2e-spec.ts` gains rows
that would fail without it.

## Affected files

| File | Change |
|---|---|
| `docker-compose.yml` | MinIO service, healthcheck, and a `minio/mc` init container that creates the private bucket. Host ports **9010/9011**, not 9000/9001 — see Risks |
| `.github/workflows/ci.yml` | MinIO service on 9000/9001 (no conflict on a runner), mirroring how Redis maps 6380 locally and 6379 in CI; the S3 env block |
| `.env.example` | `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `IMAGE_PROVIDER`, `OPENAI_API_KEY`, `IMAGE_QUEUE_NAME`, each with the comment explaining why it exists |
| `packages/storage/package.json`, `tsconfig.json` | **New workspace.** `test` and `typecheck` scripts so turbo picks it up; `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `dompurify`, `jsdom` |
| `packages/storage/src/object-storage.ts` | **New.** `ObjectStorage` interface, `OBJECT_STORAGE` Symbol token |
| `packages/storage/src/keys.ts` | **New.** The one function that mints an object key from lesson, block reference, image id and extension |
| `packages/storage/src/s3-object-storage.ts` | **New.** MinIO/S3 implementation; presigns against the public endpoint |
| `packages/storage/src/upload-safety.ts` | **New.** Magic-byte sniffing, size guard, DOMPurify SVG sanitization |
| `packages/storage/src/index.ts` | **New.** Barrel |
| `packages/ai/package.json` | Add `vitest`, a `test` script and the `openai` dependency — the package currently has neither tests nor deps |
| `packages/ai/src/image-generation.provider.ts` | **New.** Interface, request/candidate types, `IMAGE_GENERATION_PROVIDER` token |
| `packages/ai/src/image-prompt.ts` | **New.** Versioned template, exported version id, composer |
| `packages/ai/src/fake-image.provider.ts` | **New.** Deterministic PNG per (prompt, index) |
| `packages/ai/src/openai-image.provider.ts` | **New.** Real adapter; model id pinned against current docs |
| `packages/ai/src/provider-factory.ts` | **New.** Env-driven selection; throws when `IMAGE_PROVIDER=openai` and no key |
| `packages/ai/src/index.ts` | Barrel, currently 0 bytes |
| `packages/shared/src/queues.ts` | `IMAGE_QUEUE_NAME`, `imageJobNames`, the job payload type. Reuses the existing attempt/backoff constants |
| `packages/shared/src/errors.ts` | `IMAGE_TYPE_UNSUPPORTED`, `IMAGE_TOO_LARGE`, `IMAGE_BLOCK_NOT_FOUND`, `IMAGE_NOT_FOUND` |
| `packages/content/src/types.ts` | `FigureImage` shape and the `blockId → FigureImage` map type |
| `packages/content/src/render.tsx` | `LessonBody` takes an optional `images` map; `Figure` renders `<img>` + `<figcaption>` when present, P2's placeholder when not |
| `apps/api/src/content/images.controller.ts` | **New.** `GET /lessons/:id/images`, `POST .../generate`, `POST .../upload`, `PATCH /images/:imageId` |
| `apps/api/src/content/images.service.ts` | **New.** Figure view assembly, presigning, selection transaction, caption copy-forward, completeness, NFR-05 counts |
| `apps/api/src/auth/target-resolver.ts` | `imageId` branch joining image → lesson → chapter → course |
| `apps/api/src/jobs/image.queue.ts` | **New.** Producer, mirroring `import.queue.ts` |
| `apps/api/src/jobs/job-status.service.ts` | Hold a list of queues; resolve a job across all of them. `JobSnapshot` unchanged |
| `apps/api/src/jobs/job-permissions.ts` | **New.** `job_type` → `PermissionAction` map, and whether a type is lesson-targeted (for R-02) |
| `apps/api/src/jobs/jobs.controller.ts` | Replace the hardcoded `importCurriculumOutline` with the mapping; apply R-02 for lesson-targeted jobs |
| `apps/api/src/jobs/course-stream.controller.ts` | **New.** `GET /admin/courses/:courseId/stream`, filtered per snapshot |
| `apps/api/src/app.module.ts` | Register the two controllers, the images service, the image queue, the storage client and the provider |
| `apps/api/package.json` | `@knowledge-explorer/storage`, `@knowledge-explorer/ai`, `multer`, `@types/multer` |
| `apps/worker/src/jobs/image.worker.ts` | **New.** BullMQ consumer, bounded concurrency, NFR-07 failure logging |
| `apps/worker/src/jobs/image.processor.ts` | **New.** Compose prompt, call provider, write objects, insert rows |
| `apps/worker/src/jobs/image-worker.service.ts` | **New.** Owns the consumer for the process lifetime, mirroring `import-worker.service.ts` |
| `apps/worker/src/worker.module.ts` | Register the image worker service and the provider |
| `apps/worker/src/main.ts` | Ready log now names both queues |
| `apps/worker/package.json` | `@knowledge-explorer/storage`, `@knowledge-explorer/ai` |
| `apps/api/test/helpers/worker-process.ts` | Match on the stable `Worker ready.` prefix instead of the import-specific sentence |
| `apps/admin-web/e2e/global-setup.ts` | Same change, same reason |
| `apps/admin-web/components/editor/image-drawer.tsx` | **New.** Candidates, prompt, count, generate, upload, caption, alt, progress, read-only state |
| `apps/admin-web/components/editor/lesson-editor.tsx` | Keep the server block list; delegated click on the preview; flush-then-open; pass the images map to `LessonBody` |
| `apps/admin-web/lib/image-types.ts` | **New.** Mirrors the API's figure and candidate view types |
| `apps/admin-web/lib/api.ts` | `apiUpload` for multipart, alongside the JSON `apiFetch` |
| `apps/admin-web/e2e/images.spec.ts` | **New.** The spec's fourteen-step browser journey |

## Risks

- **Host port 9000 is already taken on the development machine** — `php-fpm` is
  listening on it [verified with `lsof`], so a MinIO service mapped to 9000
  would fail to start and look like a MinIO bug. *Mitigation:* map **9010:9000**
  and **9011:9001** locally, exactly as the existing compose file maps Redis to
  6380 for the same class of reason, and keep 9000/9001 in CI where nothing
  conflicts. `S3_ENDPOINT` and the port mapping must be changed together.

- **The worker's ready-log string is hard-coded in two test helpers.**
  `apps/api/test/helpers/worker-process.ts` and
  `apps/admin-web/e2e/global-setup.ts` both wait for the literal
  `Consuming the curriculum import queue`. Changing the log line to mention the
  image queue without updating both makes every e2e suite hang for its timeout
  and then fail with "worker did not become ready" — a message that points
  nowhere near the cause. *Mitigation:* in the same task, change both helpers to
  match the stable `Worker ready.` prefix, which survives P5 adding a third
  queue.

- **`S3_ENDPOINT` and `S3_PUBLIC_ENDPOINT` hold the same value locally and in
  CI**, because the API and worker run on the host rather than inside Compose.
  Code that presigns against the wrong one is therefore invisible in every
  automated run and fails only in production. *Mitigation:* the storage suite
  constructs the divergence deliberately — sign against one endpoint, request
  against the other, assert the failure — so the distinction is under test even
  though the environment does not naturally produce it. `.env.example` carries
  the explanation.

- **Nest DI is token-based because `emitDecoratorMetadata` is `false`.** Every
  new provider — the storage client, the image provider, the images service, the
  image queue — needs an explicit `@Inject(Token)`. Omitting one compiles
  cleanly and fails at runtime with an unhelpful resolution error.
  *Mitigation:* follow `EMAIL_PROVIDER`'s Symbol-token pattern exactly; the
  first e2e test to boot the module catches it immediately.

- **A retried generation job can append duplicate candidates.** If the provider
  call succeeds and a later object write fails, the retry generates a fresh set
  and the block ends up with more candidates than requested. This is a
  consequence of the append rule, not a defect, and no cleanup is in scope.
  *Mitigation:* record it in the processor's comment so a future reader does not
  "fix" it into a destructive replace.

- **Nothing in the schema enforces one selected candidate per block.** §8 defines
  no partial unique index for it and P3 adds no migration, so the invariant is
  held by an interactive transaction that clears then sets. Two concurrent
  `PATCH`es could in principle interleave. *Mitigation:* clear-and-set inside one
  `$transaction`; the e2e asserts the invariant after a sequence of switches.
  A partial unique index is the right long-term answer and belongs to whichever
  phase next opens a migration.

- **Multer wiring on NestJS 12.** `FileInterceptor` needs `multer` and
  `@types/multer` present and the size limit set at the interceptor, not in the
  handler, so an oversize upload is refused before the whole body is buffered.
  *Mitigation:* assert the 6 MB rejection in the e2e suite, which fails if the
  limit was placed too late.

- **The live OpenAI test spends money.** *Mitigation:* it skips unless
  `OPENAI_API_KEY` is set, requests `candidateCount: 2`, and is never invoked by
  CI.

- **Scope is larger than §12's one-week estimate.** The four cross-phase items
  the spec adopts are individually small but collectively a second front.
  *Mitigation:* the task order puts every one of them after the first working
  vertical slice, so if the phase is cut short, what ships is coherent rather
  than half-built.

## Test strategy

Unit-level, no I/O: key minting, magic-byte sniffing, SVG sanitization fixtures,
prompt composition, fake-provider determinism, provider selection, and the
renderer's figure cases (`packages/storage`, `packages/ai`, `packages/content`).

Integration against live services: the storage round-trip and presigning suites
need MinIO; `apps/api/test/images.e2e-spec.ts` boots the API against PostgreSQL
and MinIO; `apps/worker/test/image-processor.spec.ts` drives the processor
directly with a fake provider and a real storage client; the job-stream suites
extend P1's `job-stream.e2e-spec.ts` and run a real worker child process.

RBAC additions go into the existing `rbac.e2e-spec.ts` rather than a new file,
so the eleven-row matrix the harness calls out stays the single place role
behavior is asserted.

Browser: `apps/admin-web/e2e/images.spec.ts` runs the spec's fourteen-step
journey. Steps 9, 12 and 13 are the load-bearing ones — caption follows the
figure, the image follows the `blockId`, the number follows the block list.

The spec's end-to-end verification is executed as written:

```
docker compose up -d --wait
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm test
pnpm --filter @knowledge-explorer/admin-web run test:e2e
```

Expected: exit code 0 from both, with no `OPENAI_API_KEY` set — the fake
provider is the default and the only one CI exercises. The live adapter test
(`packages/ai/test/openai-image.live.spec.ts`) is run by hand before shipping
and whenever the pinned model changes.

## Out of scope

Restated from the spec, plus what planning added:

- Narration, audio, and any `LlmProvider` or `TextToSpeechProvider`.
- The `drafting → ready` transition, the publish checklist, and any status-column
  write. P3 computes image-completeness and displays it; P6 acts on it.
- `GET /lessons/:lessonId/staleness` — P4's, with the first artifact that can be
  stale.
- The learner app. The shared renderer gains the image path; no learner route
  consumes it.
- `GET /media/:mediaId/signed-url` and entitlement gating — P8's.
- §9.2's `GET /courses/:courseId/usage` and the cost dashboard. §3 has no
  permission row for viewing cost data and `roles.ts` denies by default; P3 ships
  the count derivation and P10 raises the gap.
- CDN, production object storage, lifecycle rules, replication, backups.
- Deleting anything: orphaned rows, superseded candidates, or their objects.
- Reattaching an orphan to a different figure block.
- Image editing, thumbnails, variants, `srcset`, format conversion.
- AI-written captions or alt text; LLM-assisted prompt suggestion.
- Style presets, moderation, bulk generation, a second real vendor.
- Changing the `::figure` dialect or touching the parser.
- A linter; mobile layouts.

**Added during planning:**

- **No queue-factory abstraction.** `import.queue.ts` and `image.queue.ts` stay
  as sibling concrete modules. Two instances is not enough evidence; P5's third
  queue is when the shape will be obvious.
- **No partial unique index on `(lesson_id, block_reference_id)` for
  `is_selected`.** It would be the right enforcement, and it needs a migration
  that P3 is not opening.
- **No change to `JobSnapshot`'s shape**, so `admin-web`'s hand-mirrored copy
  stays valid without edits.
