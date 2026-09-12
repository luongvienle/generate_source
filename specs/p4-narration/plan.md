# Plan: P4 — Narration script

**Spec:** `specs/p4-narration/spec.md`
**Status:** Approved
**Date:** 2026-09-12

## Objective

Make `narration_scripts` a table that code writes: a versioned §6.3 prompt
behind an `LlmProvider` port, a chunking generation worker whose output is
validated and reconciled against the block list, a per-block review tab with
approval, and the computed-on-read staleness that P5 and P6 both consume.

## Three findings that amend the spec

Impact analysis turned up three places where the spec's wording meets code that
argues with it. None change a product decision; all three change an
implementation instruction, so they are stated here rather than resolved
silently.

**1. ~~`fetch`, not the Anthropic SDK.~~ REVERSED during implementation — the
SDK it is.** This finding originally recommended `fetch`, on the strength of
`openai-image.provider.ts`'s documented rationale and `packages/ai` having zero
runtime dependencies. Consulting Anthropic's own API guidance before writing the
adapter reversed it: TypeScript callers are directed to the official SDK, and raw
HTTP is reserved for languages without one, because hand-written request shapes
drift as the API changes. Confirmed with the author before implementing.

`@anthropic-ai/sdk` is therefore `packages/ai`'s first runtime dependency, and
`maxRetries: 0` on the client is load-bearing — the SDK retries twice by default,
NFR-03 gives the job three attempts and §6.3 gives each chunk three tries, which
left alone would multiply into as many as 18 paid calls for one chunk, none of
them recorded in `generation_jobs.attempt_count`. The OpenAI adapter stays on
`fetch`; the two providers now differ in style, which is the accepted cost and is
recorded in `anthropic-llm.provider.ts` itself. The spec's affected-files row
naming the SDK stands as written.

**2. The enqueue cannot be one transaction.** The spec says the job row, the
`generating` status and the enqueue happen "all in one transaction, so the
in-flight lock and the job row cannot disagree". Redis is not enlisted in a
Postgres transaction, and `ImagesService.requestGeneration` already shows the
house pattern: write the row, then enqueue inside a `try`, and on failure call
`markJobAttemptFailed` to compensate. P4 does the same with one addition — the
compensating path must also clear `script_status = 'generating'`, or a failed
enqueue wedges the lesson behind its own lock. **The two database writes share a
transaction; the enqueue sits outside it with compensation.**

**3. The figure-completeness rule needs one home, not two.** The spec has the
API refuse an incomplete figure at enqueue and the worker re-check it before the
first call. The API can reuse `ImagesService`; the worker cannot — it is a
different process with no Nest services. Writing the rule twice would put
FR-IMG-03's definition of "complete" in two places that can drift. The predicate
therefore moves into `packages/content/src/narration.ts` as a pure function, and
`images.service.ts` changes by one line to call it. One rule, three callers.

## Approach

### Build order: vocabulary, then the port, then the shortest end-to-end slice

The fake provider is deterministic and free, which decides the order. Every
moving part of the pipeline — chunking, the retry ladder, validation,
reconciliation, the atomic write, the job plumbing — can be built and exercised
against the fake before a single line of the Anthropic adapter exists. The real
adapter is the isolated, low-risk piece and it lands late, exactly as P3 landed
`OpenAiImageProvider` after its walking skeleton.

| Slice | What exists at the end of it |
|---|---|
| A | Segment types and every checksum, unit-tested with no Docker |
| B | The `LlmProvider` port, the fake, the versioned prompt, response decoding |
| C | **Walking skeleton**: `POST` → worker → fake → validated rows → `GET` |
| D | Editing and approval through `PUT`, with optimistic concurrency |
| E | The staleness endpoint and chunk-level progress on the stream |
| F | The narration tab in the lesson editor |
| G | `AnthropicLlmProvider` and the live test |
| H | Browser suite, docs, harness |

Slice C is the phase's proof of life: an admin can generate a script end to end
with no key, no network and no UI. Everything after it is either a second verb
on the same data or a second surface onto it.

### Chunking, validation and the retry ladder live in one pure function

The processor is the phase's only genuinely intricate code, so the intricate
part is factored out of the job handler and away from the database.
`packages/ai/src/narration-run.ts` exports a pure orchestrator: given the input
blocks, a `complete` function and the three constants, it chunks, calls,
validates, retries and returns either a full segment list or a typed failure.
It takes no Prisma client, no job and no logger.

That is what makes the ladder testable. `NARRATION_CHUNK_MAX_TRIES` and
`NARRATION_RUN_MAX_CALLS` are asserted by counting calls against a stub
`complete`, in a unit test with no Docker — where "the fourth call never
happens" is an assertion rather than an inference from a timeout. The worker
handler shrinks to: read, project, run, reconcile, write.

### The reconciliation pass is pure, and it is where the spec's edge cases live

`reconcileSegments(previous, generated, blocks)` in
`packages/content/src/narration.ts` implements the four rules — keep, replace,
add, drop — as a function of three arrays. Every case the spec names (b3
changed, b7 hand-edited and untouched, b9 new, b4 deleted) is one unit test on
one function, rather than four worker runs against a live database.

### The third queue, and the one place it is felt

The spec declines to extract a queue abstraction, so `narration.queue.ts` is a
sibling of `image.queue.ts` and no P1 or P3 producer is touched. The cost lands
in exactly one file: `job-status.service.ts::locate()` is a two-way branch on an
`isImport` boolean, and its `jobType` fallback is a two-way ternary. Both become
three-way. That file is a consumer, not a producer, so widening it honors the
spec's boundary; it is named here because it is the only place a reader will
feel the decision, and because a fourth queue in P5 should convert the boolean
to a discriminant rather than adding a third branch.

### Chunk progress is additive on `JobSnapshot`

`JobSnapshot` has no progress field today and the SSE stream serializes it
whole. P4 adds `progress: { done, total } | null`, read from BullMQ's
`job.progress` — durable state still comes from the `generation_jobs` row, which
stays authoritative for status. `apps/admin-web/lib/job-types.ts` mirrors this
interface by hand and reads a subset, so it needs no change until the tab wants
to render the bar. This is the same additive move P3 made for `targetEntityId`.

The stream's own `distinctUntilChanged` already suppresses duplicate snapshots,
so a progress bump emits exactly one extra event per validated chunk.

### `resolveEditability` is about to have a third copy

`lesson-content.service.ts` and `images.service.ts` each hold a private static
`resolveEditability` with byte-identical bodies — the mirror of
`PublishedLockGuard` then `AssignmentGuard` that lets a read-only screen explain
itself. Narration needs the same answer. Three copies of an authorization
mirror is a drift risk with a silent failure mode: change R-01 or R-02 and one
copy keeps telling admins they may edit something the API will refuse.

`lesson-content.service.ts` already exports `readBlockList` and `Editor`, and
`images.service.ts` already imports both — so the precedent for sharing across
this directory exists. The plan exports `resolveEditability` from the same file
and points all three at it. It is a move, not a rewrite; the existing RBAC e2e
matrix covers it. **This is a judgment call, not a spec requirement** — drop it
and write a third copy if you would rather P4 left P2 and P3 files alone.

### Flush-then-generate must be two-phase

The spec says Generate flushes a dirty buffer first. `useAutosave`'s `flush()`
returns `void`, not a promise, so it cannot be awaited. The editor already
solves this shape for a figure clicked while dirty: set a pending intent, call
`flush()`, and let an effect fire once `hasUnsavedWork` goes false. Narration
reuses it with one addition the figure path does not need — if the save settles
into `invalid`, `conflict` or `error`, the pending generation is **cancelled**
rather than fired, because the spec requires a failed save to enqueue nothing.

### What the worker reads, and why it re-reads

The payload carries `{ generationJobId, lessonId, createdByUserId }` and nothing
else. The worker re-reads `draft_block_list`, recomputes its checksum, and joins
the selected `lesson_images` rows by `blockId` to build the
`NarrationInputBlock[]` projection. The join is by block id and never by figure
number — P2's `figure-resolve.ts` and P3's drawer defect both exist because that
distinction was hard-won.

## Affected files

### New

| File | Change |
|---|---|
| `packages/content/src/narration.ts` | Segment types and zod schemas, `segmentChecksum`, `scriptChecksum`, `reconcileSegments`, `narrationStaleness`, `isFigureInputComplete` |
| `packages/content/test/narration.spec.ts` | Checksums, reconciliation, staleness sets |
| `packages/ai/src/llm.provider.ts` | `LlmProvider`, request/response types, `LLM_PROVIDER` Symbol |
| `packages/ai/src/fake-llm.provider.ts` | Deterministic fake with forced-rejection hooks |
| `packages/ai/src/anthropic-llm.provider.ts` | Messages API over `fetch`; pure `decodeMessagesResponse` |
| `packages/ai/src/narration-prompt.ts` | Versioned template, `NarrationInputBlock`, `decodeNarrationResponse` |
| `packages/ai/src/narration-run.ts` | Pure chunk/validate/retry orchestrator |
| `packages/ai/test/llm-provider.spec.ts` | Fake determinism, decode, factory selection |
| `packages/ai/test/narration-prompt.spec.ts` | Composition, 5-row table cap, no raw markdown |
| `packages/ai/test/narration-run.spec.ts` | The ladder, by call count against a stub |
| `packages/ai/test/anthropic-narration.live.spec.ts` | Skips without `ANTHROPIC_API_KEY` |
| `apps/api/src/jobs/narration.queue.ts` | Producer, `script:` prefix |
| `apps/api/src/content/narration.controller.ts` | `GET` / `POST` / `PUT`, split guards |
| `apps/api/src/content/narration.service.ts` | Preconditions, read model, approval, staleness |
| `apps/api/test/narration.e2e-spec.ts` | The API suite |
| `apps/worker/src/jobs/narration.processor.ts` | Read, project, run, reconcile, atomic write |
| `apps/worker/src/jobs/narration.worker.ts` | BullMQ wiring, bounded concurrency |
| `apps/worker/src/jobs/narration-worker.service.ts` | Lifecycle, provider construction at boot |
| `apps/worker/test/narration-processor.spec.ts` | Real queue, real Postgres, fake provider |
| `apps/admin-web/components/editor/narration-tab.tsx` | The review screen |
| `apps/admin-web/lib/narration-types.ts` | Hand-mirrored view types and paths |
| `apps/admin-web/e2e/narration.spec.ts` | Browser suite |

### Modified

| File | Change |
|---|---|
| `packages/content/src/checksum.ts` | Export `blockChecksum`; **`blockListChecksum` untouched** |
| `packages/content/src/index.ts` | Re-export `narration.ts` |
| `packages/ai/src/provider-factory.ts` | `createLlmProvider(env)` beside the image factory |
| `packages/ai/src/index.ts` | Re-export the four new modules |
| `packages/shared/src/queues.ts` | Queue name, job names, payload, three constants; **amend the P3 extraction note** |
| `packages/shared/src/errors.ts` | Eight `SCRIPT_*` codes |
| `apps/api/src/content/lesson-content.service.ts` | Export `resolveEditability` |
| `apps/api/src/content/images.service.ts` | Use the shared `resolveEditability` and `isFigureInputComplete`; add `incompleteFigures()` with no presigning |
| `apps/api/src/jobs/job-permissions.ts` | Add the `generate_narration_script` row and its lesson-targeted entry |
| `apps/api/src/jobs/job-status.service.ts` | Three-way `locate()`; `progress` on `JobSnapshot` |
| `apps/api/src/jobs/jobs.controller.ts` | Comment: two job types becomes three |
| `apps/api/src/app.module.ts` | Register controller, service, queue |
| `apps/worker/src/worker.module.ts` | Register `NarrationWorkerService` |
| `apps/admin-web/components/editor/lesson-editor.tsx` | Tabs; pending-generation flush |
| `apps/admin-web/lib/job-types.ts` | Mirror `progress` |
| `.env.example` | `LLM_PROVIDER`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` |
| `CLAUDE.md` | Money-costing tests: two files, not one |
| `.claude/harness/architecture.md` | `LlmProvider` built; third queue; P4 no longer unbuilt |

## Risks

- **A model that will not produce exactly N segments.** The whole §6.3 contract
  rests on it, and the fake cannot tell you whether a real model complies.
  *Mitigation:* the ladder fails closed and cheap — a bad chunk costs 25 blocks,
  not a lesson, and the run ceiling bounds the worst case. The live test in
  Slice G is the first real evidence; run it before trusting the chunk size.
  If compliance is poor, the knob is one constant.
- **`blockListChecksum` accidentally changing.** Adding `blockChecksum` beside
  it invites a tidy-minded refactor that redefines the list hash over the
  per-block hashes, which would silently restate every stored
  `draft_content_checksum`. *Mitigation:* Slice A pins the existing output with
  hard-coded hex fixtures, so the refactor fails a test instead of a migration.
- **A `generating` lock that never clears.** Known and accepted by the spec, but
  a failed *enqueue* would wedge a lesson on day one rather than in an edge
  case. *Mitigation:* the compensating catch clears the lock, and Slice C tests
  it by pointing the producer at an unreachable Redis.
- **The tab renders the wrong text while the buffer is dirty.** The preview's
  blockIds are display-only; the narration rows are keyed by the server's.
  *Mitigation:* the tab reads block text from the **server's** block list in the
  narration `GET` response, never from the local parse — the mistake P2's
  `figure-resolve.ts` documents and P3's drawer defect still pays for.
- **Chunk-boundary incoherence.** Accepted by the spec and untestable.
  *Mitigation:* none. It surfaces as admin edits; carried context is additive.
- **Three new suites need Docker and a worker child process.** Slower feedback,
  and `fileParallelism: false` means they serialize.
  *Mitigation:* Slices A, B and the run orchestrator are pure and Docker-free,
  which is most of the phase's logic.

## Test strategy

**Pure, no Docker** — `packages/content` and `packages/ai`. Checksum stability
and the pinned `blockListChecksum` fixtures; reconciliation's four rules; the
three staleness sets; prompt composition including the 5-row table cap and the
absence of raw markdown; fake determinism; `decodeMessagesResponse` against a
recorded body; factory selection including `anthropic`-without-a-key throwing;
and the retry ladder asserted **by counting calls** against a stub `complete`.
This is where most of the phase's logic is proven.

**API e2e** — `apps/api/test/narration.e2e-spec.ts`, real HTTP against the
migrated database: every precondition refusal with its `errorCode` and an
assertion that nothing was enqueued; the 409 in-flight path; `PUT` conflict,
edit-keeps-approval, approve-refused-when-stale, and the all-or-nothing
unknown-`blockId` case; the staleness endpoint including **the explicit absence
of an `audio` key**; and RBAC rows extending `rbac.e2e-spec.ts`.

**Worker** — `apps/worker/test/narration-processor.spec.ts`, following
`image-processor.spec.ts`: a real BullMQ queue on a random name, real Postgres,
the fake provider. Chunk arithmetic on a 60-block lesson, the failed-run
invariants (previous segments and `reviewed_at` byte-identical, BullMQ attempt
count still 1), transport errors reaching 3 attempts, and approval cleared even
when every segment was preserved.

**Browser** — `apps/admin-web/e2e/narration.spec.ts`, in the suite excluded from
`turbo run test` on purpose. The flush-then-generate assertion is on **network
order**: the content `PUT` completes before the narration `POST` is issued.

**Live** — `anthropic-narration.live.spec.ts`, skipped unless
`ANTHROPIC_API_KEY` is set. Assertions are language-neutral: the course fixture
runs at the `vi` default, so the figure check looks for the numeral, never for
the word "Figure".

**The spec's end-to-end verification** is `pnpm verify` plus
`pnpm --filter @knowledge-explorer/admin-web test:e2e`, from a clean checkout
with Docker up, with no `ANTHROPIC_API_KEY` present.

## Out of scope

From the spec, unchanged: TTS, audio and timing of any kind; the publish
checklist gate; any learner-facing exposure; per-segment regeneration; a shared
queue abstraction; multiple voices, languages or scripts per lesson; editing the
prompt template from the UI; cost dashboards.

Added during planning:

- **No migration.** Every column P4 writes exists. If a task appears to need
  one, the plan is wrong — re-read the spec's Constraints.
- **No change to `blockListChecksum`'s algorithm**, and no refactor that
  redefines it in terms of `blockChecksum`.
- **No queue-factory extraction**, and no edit to `import.queue.ts`,
  `image.queue.ts` or either existing processor. `job-status.service.ts` and
  `job-permissions.ts` are consumers and are in scope.
- **No stale-lock sweep or job-recovery tooling** (P10).
- **No rendering of narration in the preview pane.** The tab is its own surface;
  `LessonBody` is shared with P7's reader and stays free of editor concerns.
