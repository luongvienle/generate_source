# Tasks: P4 — Narration script

**Plan:** `specs/p4-narration/plan.md`
**Spec:** `specs/p4-narration/spec.md`

Ordered. Tick boxes as tasks complete — this file is the durable progress state
and is the thing that survives a lost session, so update it as you go rather
than at the end.

Slices A–H follow the plan. Slice C is the phase's walking skeleton: finish it
and an admin can generate a narration script end to end — POST, worker, fake
provider, validated rows, GET — before any UI or any API key exists.

**Node 22 is mandatory** (`nvm use`). Slices A and B need no Docker; everything
from C onward does.

---

## Slice A — Segment vocabulary and checksums

Pure functions in `packages/content`. Everything downstream reads them, and
none of it needs Docker, a queue or a provider.

- [x] **Task 1: `blockChecksum`, and pin the existing list checksum**
  Add `blockChecksum(block)` to `packages/content/src/checksum.ts`, hashing
  `canonicalJson(semanticProjection(block))` for one block with the same
  `@noble/hashes` primitive the file already uses. **Do not touch
  `blockListChecksum`** — redefining it over the new per-block hashes would
  silently restate every stored `draft_content_checksum`. In the same task, add
  hard-coded hex fixtures to `packages/content/test/checksum.spec.ts` pinning
  `blockListChecksum`'s current output for two known block lists, so that
  refactor fails a test rather than a migration.
  - done when: `pnpm --filter @knowledge-explorer/content test checksum` passes,
    including a case where a whitespace-only change leaves `blockChecksum`
    equal and a word change moves it, and the two new pinned fixtures.

- [x] **Task 2: The segment vocabulary**
  New `packages/content/src/narration.ts`: the stored envelope and segment
  types, their zod schemas, `segmentChecksum(narrationText)` over the
  whitespace-normalized text, `scriptChecksum(segments)` over the ordered
  `(blockId, segmentChecksum)` pairs, a `readScriptSegments(value: unknown)`
  JSONB reader following `readBlockList`'s shape, and
  `isFigureInputComplete({ hasSelected, captionText, alternativeText })` — the
  FR-IMG-03 predicate that Task 9 and Task 11 will both call. Re-export from
  `src/index.ts`. No Node builtins: `test/isomorphic.spec.ts` walks this.
  - done when: `pnpm --filter @knowledge-explorer/content test` passes,
    including `isomorphic.spec.ts`, with new assertions that `scriptChecksum`
    moves when any segment changes and when two segments are transposed, and
    that `readScriptSegments` returns an empty envelope for `null`, `{}` and a
    bare array.

- [x] **Task 3: Reconciliation and staleness, as pure functions**
  In the same module: `reconcileSegments(previous, generated, blocks)`
  implementing keep / replace / add / drop per the spec, and
  `narrationStaleness(blocks, segments)` returning the three disjoint sets
  `changedBlockIds`, `missingBlockIds`, `orphanedSegmentBlockIds`.
  - done when: `packages/content/test/narration.spec.ts` passes the spec's
    worked case — b3 changed, b7 untouched and hand-edited, b9 new, b4 deleted —
    asserting b7 keeps its text **and** `isEdited: true`, b3 takes generated
    text with `isEdited: false`, b9 is generated, b4 is absent; plus a test that
    the three staleness sets are pairwise disjoint.

---

## Slice B — The port, the fake, the prompt

Still pure, still no Docker. At the end of this slice the entire §6.3 contract
is testable without a network or a key.

- [x] **Task 4: `LlmProvider`, the fake, and provider selection**
  `packages/ai/src/llm.provider.ts`: the interface with
  `complete(request): Promise<LlmCompletion>`, where the completion carries the
  raw text, `modelName`, `providerName`, `inputTokenCount` and
  `outputTokenCount`; plus the `LLM_PROVIDER` Symbol token.
  `fake-llm.provider.ts`: deterministic output derived from the prompt, parsing
  the block manifest back out of it and emitting one well-formed segment per
  block, with hooks that force each §6.3 rejection (short count, unknown
  `blockId`, transposed order, unparseable). Add `createLlmProvider(env)` to the
  existing `provider-factory.ts`. Re-export from the barrel.
  - done when: `pnpm --filter @knowledge-explorer/ai test` passes assertions
    that the same prompt yields identical output twice, that each hook produces
    exactly one violation, that `LLM_PROVIDER` unset yields the fake, and that
    `LLM_PROVIDER=anthropic` with no `ANTHROPIC_API_KEY` **throws at
    construction**.

- [x] **Task 5: The versioned prompt and response decoding**
  `packages/ai/src/narration-prompt.ts`: `NARRATION_PROMPT_VERSION`, the
  `NarrationInputBlock` type, `composeNarrationPrompt(...)` expressing every
  §6.3 constraint, and `decodeNarrationResponse(text, expectedBlockIds)`
  returning either segments or a typed violation. The template omits the
  learning-objective line entirely when it is null, and never includes a
  block's raw `markdown`. Table entries carry at most 5 data rows.
  - done when: `packages/ai/test/narration-prompt.spec.ts` passes — the
    composed string contains the title, language code and every chunk
    `blockId`; a 40-row table contributes exactly 5 rows; no `markdown` field
    appears; a null learning objective produces no labelled blank; and
    `decodeNarrationResponse` returns the right violation for each of the four
    malformed inputs.

- [x] **Task 6: The run orchestrator — chunking and the retry ladder**
  `packages/ai/src/narration-run.ts`: a pure
  `runNarration({ blocks, complete, onChunkDone, constants })` that chunks at
  `NARRATION_CHUNK_BLOCK_COUNT`, validates each chunk against its own manifest,
  retries in process to `NARRATION_CHUNK_MAX_TRIES` feeding the violation back
  into the retry prompt, enforces `NARRATION_RUN_MAX_CALLS`, asserts the
  stitched list against the full block list, and returns segments plus summed
  token counts — or a typed failure naming the chunk and the condition. **It
  touches no Prisma, no job and no logger**; that is what makes the ladder
  assertable by call count. A transport error from `complete` propagates
  untouched so BullMQ sees it.
  - done when: `packages/ai/test/narration-run.spec.ts` passes against a stub
    `complete` — 60 blocks produce 3 chunks and 3 calls; a chunk failing twice
    then succeeding produces a complete result in 5 calls; a chunk failing three
    times returns a failure **and makes no fourth call for that chunk**; the run
    ceiling stops a pathological case; and a thrown transport error escapes
    rather than being retried in process.

---

## Slice C — Walking skeleton: generate end to end with the fake

- [x] **Task 7: Shared constants and error codes**
  `packages/shared/src/queues.ts`: `NARRATION_QUEUE_NAME = 'narration-script'`,
  `narrationJobNames`, `GenerateNarrationScriptJobData`
  (`{ generationJobId, lessonId, createdByUserId }`), and
  `NARRATION_CHUNK_BLOCK_COUNT = 25`, `NARRATION_CHUNK_MAX_TRIES = 3`,
  `NARRATION_RUN_MAX_CALLS = 40`. **Amend the P3 note** that predicts extraction
  at the third queue: record that the third arrived at P4, that extraction was
  reconsidered and deferred to P5's audio queue, and why. Add the eight
  `SCRIPT_*` codes to `errors.ts`.
  - done when: `pnpm typecheck` passes and
    `pnpm --filter @knowledge-explorer/shared test` still passes, with the
    existing enum-coverage assertions untouched.

- [x] **Task 8: The queue producer and job plumbing**
  `apps/api/src/jobs/narration.queue.ts`, a sibling of `image.queue.ts`, with
  `NARRATION_JOB_ID_PREFIX = 'script:'` and the same NFR-03 queue defaults. Add
  the `generate_narration_script` row to `job-permissions.ts` and its entry in
  `lessonTargetedJobTypes`. Widen `job-status.service.ts::locate()` and its
  `jobType` fallback from two-way to three-way. Update the now-inaccurate "two
  job types" comment in `jobs.controller.ts`.
  - done when: `pnpm typecheck` passes and a unit assertion shows
    `permissionForJobType('generate_narration_script')` returns
    `generateAndEditNarrationScript` while an unlisted type still returns
    `undefined` — deny-by-default intact.

- [x] **Task 9: Preconditions and `requestGeneration`**
  Export `resolveEditability` from `lesson-content.service.ts` and point
  `images.service.ts` at it (see the plan — drop this half if you would rather
  P4 left P3 files alone). Add `ImagesService.incompleteFigures(lessonId)`
  returning `{ blockId, figureNumber, missing[] }` with **no presigning**, built
  on the shared `isFigureInputComplete`. Then `narration.service.ts`:
  `requestGeneration` checking empty block list, in-flight lock, incomplete
  figures and the chunk ceiling, writing the `generation_jobs` row and
  `script_status = 'generating'` **in one transaction**, then enqueueing
  **outside** it with a compensating catch that clears both.
  - done when: `pnpm --filter @knowledge-explorer/api test` passes existing
    suites, and a new case shows that pointing the producer at an unreachable
    Redis leaves `script_status` **not** `generating` and the job row failed.

- [x] **Task 10: The controller — `POST` and the read model**
  `narration.controller.ts` with guards split by method exactly as
  `images.controller.ts` does: `SessionGuard` + `RolesGuard` on the class,
  `PublishedLockGuard` + `AssignmentGuard` added per write.
  `@RequirePermission('generateAndEditNarrationScript')` throughout. `POST`
  returns `202 { jobId }`. `GET` returns the read model: computed status, both
  checksums, review and generator metadata, `canEdit` / `readOnlyReason`, one
  row per block **from the server's stored block list** carrying block type,
  text, figure or table number, its segment and freshness, then orphaned
  segments. Register in `app.module.ts`.
  - done when: `curl` against a running api returns `202` with a `script:`-
    prefixed id for a complete lesson, `422 SCRIPT_FIGURES_INCOMPLETE` naming
    the figure for an uncaptioned one, and a `GET` on an ungenerated lesson
    returns rows with null segments and `status: null`.

- [x] **Task 11: The worker processor**
  `narration.processor.ts`: re-read `draft_block_list` and recompute its
  checksum; **re-check figure completeness** via the shared predicate and fail
  without a provider call if it no longer holds; join selected `lesson_images`
  by `blockId` to build the projection; call `runNarration`; reconcile against
  the previous script; write segments, both checksums, status, token counts,
  model and prompt version **in one transaction**, clearing
  `reviewed_by_user_id` and `reviewed_at`. A run failure writes
  `script_status = 'failed'` with a reason and **changes nothing else**. Plus
  `narration.worker.ts` with bounded concurrency and `narration-worker.service.ts`
  constructing the provider once at boot; register in `worker.module.ts`.
  - done when: `pnpm --filter @knowledge-explorer/worker test` passes and the
    worker boots against Redis without error.

- [x] **Task 12: Proof of life — the processor suite**
  `apps/worker/test/narration-processor.spec.ts`, following
  `image-processor.spec.ts`: real BullMQ queue on a random name, real Postgres,
  fake provider.
  - done when: the suite passes, asserting that a 60-block lesson yields exactly
    60 segments in order from 3 chunks and 3 calls; that a run whose chunk
    exhausts its tries leaves a previously approved script's segments, checksums
    and `reviewed_at` **byte-identical** with `generation_jobs.attempt_count`
    still 1; that a thrown transport error does reach 3 attempts; that a
    successful run clears approval **even when every segment was preserved**;
    and that token counts are the sums across chunks.

---

## Slice D — Review, editing and approval

- [x] **Task 13: Edit and approve in the service**
  `PUT` handling: `scriptChecksum` precondition returning `409 SCRIPT_CONFLICT`;
  segment edits recomputing `segmentChecksum` and `scriptChecksum`, setting
  `isEdited`, and **leaving `sourceBlockChecksum` and approval alone**; an
  unknown `blockId` refusing the **whole** request; `approve: true` recording
  `reviewedByUserId` / `reviewedAt` and refused with
  `422 SCRIPT_NOT_APPROVABLE` when the computed status is `stale`, `failed`,
  `generating` or `pending`; `404 SCRIPT_NOT_FOUND` when no row exists.
  - done when: the api suite passes cases for each of those five outcomes,
    including that a mixed body with one unknown `blockId` writes neither valid
    segment.

- [x] **Task 14: Wire `PUT` and the zod body**
  `strictObject` body in the controller —
  `{ scriptChecksum, segments?, approve? }` — with the two rule guards attached.
  - done when: `pnpm --filter @knowledge-explorer/api test narration` passes,
    and a body carrying an unknown field is rejected by zod rather than ignored.

---

## Slice E — Staleness and chunk progress

- [x] **Task 15: `GET /admin/lessons/:lessonId/staleness`**
  Script-only, computed on read, from `narrationStaleness`. Stored status is
  never `stale`; the reported status is `stale` only when the stored value is
  `ready` **and** the checksums differ, so `failed` outranks it. **No `audio`
  key in the response.**
  - done when: the api suite shows `ready` right after a run, `stale` after a
    body edit with exactly the edited block in `changedBlockIds`, `failed` (not
    `stale`) for a failed-and-outdated row, `"script": null` for an ungenerated
    lesson, and — asserted explicitly — **no `audio` property on the body**.

- [x] **Task 16: Chunk progress on the stream**
  Add `progress: { done, total } | null` to `JobSnapshot`, read from BullMQ's
  `job.progress`; the `generation_jobs` row stays authoritative for status. Have
  the processor report progress through `runNarration`'s `onChunkDone` once per
  **validated** chunk, so retries do not move the counter. Mirror the field in
  `apps/admin-web/lib/job-types.ts`.
  - done when: the worker suite asserts a 3-chunk run emits exactly 3 progress
    updates, and that a chunk which retried twice still contributes exactly one.

---

## Slice F — The narration tab

- [x] **Task 17: View types and the tab's read surface**
  `apps/admin-web/lib/narration-types.ts` mirroring the API views by hand, with
  the path helpers. `narration-tab.tsx` rendering block text read-only on the
  left and narration on the right in block-list order, with figure and table
  numbers, edited and freshness badges, orphaned segments listed after the
  blocks and clearly marked, and a read-only banner reusing the existing
  `readOnlyMessages` copy. Block text comes from the **server's** block list in
  the response, never from the local preview parse.
  - done when: the tab renders a generated lesson with correct ordering and
    badges against a running api, and renders an ungenerated lesson with an
    empty state and a Generate action.

- [x] **Task 18: Editing and approval in the tab**
  Per-segment editing posting `PUT` with the loaded `scriptChecksum`, an
  Approve action disabled with a stated reason when the script is not
  approvable, and conflict handling that surfaces rather than overwrites.
  - done when: editing a segment and saving leaves the approved badge in place
    and updates the checksum the tab holds; a stale script shows Approve
    disabled with its reason.

- [x] **Task 19: Tabs in the editor, and flush-then-generate**
  Add the Write / Narration tab strip to `lesson-editor.tsx`, leaving the images
  drawer untouched. Generate with a dirty buffer sets a pending intent, calls
  `autosave.flush()`, and fires the `POST` from an effect once
  `hasUnsavedWork` goes false — **cancelling** the pending generation if the
  save settles into `invalid`, `conflict` or `error`. Show `JobProgress` with
  the chunk counter, and reload the tab on the terminal event. Regenerating over
  hand-edited segments confirms first, naming the edited count and that approval
  will be cleared.
  - done when: `pnpm --filter @knowledge-explorer/admin-web test` passes and,
    driven by hand, typing then immediately clicking Generate issues the content
    `PUT` before the narration `POST`.

---

## Slice G — The real adapter

- [x] **Task 20: `AnthropicLlmProvider`**
  Messages API over **`fetch`, not the SDK** — see the plan's finding 1;
  `packages/ai` keeps its zero runtime dependencies. Pin the model identifier as
  a named constant defaulting to `claude-sonnet-5` per §6.3, overridable by
  `ANTHROPIC_MODEL`, and **verify the identifier and its pricing against current
  documentation before committing to it**. Factor the body-to-completion mapping
  into a pure `decodeMessagesResponse` so it is testable without a network. A
  non-OK response throws with the provider's reason, which lands in
  `generation_jobs.error_message`.
  - done when: `pnpm --filter @knowledge-explorer/ai test` passes a case
    decoding a recorded response body into text plus both token counts, and a
    case mapping a non-OK response to a thrown error carrying the body text.

- [x] **Task 21: The live test**
  `anthropic-narration.live.spec.ts`, skipping unless `ANTHROPIC_API_KEY` is
  set, mirroring `openai-image.live.spec.ts`. Assertions are
  **language-neutral**: the fixture course uses the `vi` default, so the figure
  check looks for the numeral and never for the word "Figure".
  - done when: with a key exported, a real call on a 6-block fixture passes
    §6.3 validation unmodified, the figure segment carries the numeral in its
    first clause, the text contains no markdown syntax or bullet glyphs, and the
    same fixture at a second `languageCode` produces different text. Without a
    key, `pnpm verify` skips it and stays green.

---

## Slice H — Close out

- [x] **Task 22: Finish the API suite, including RBAC**
  Complete `narration.e2e-spec.ts` and extend `rbac.e2e-spec.ts`: a `learner`
  refused on all three endpoints; an `admin` on a lesson assigned to another
  admin refused both writes with `FORBIDDEN_NOT_ASSIGNED` but **succeeding on
  the `GET`**; an `admin` refused in a published course with
  `FORBIDDEN_COURSE_PUBLISHED` while `admin_owner` succeeds; an `admin` able to
  stream their own narration job and a `learner` refused.
  - done when: `pnpm --filter @knowledge-explorer/api test` is green and the
    RBAC matrix covers narration on every row it covers images.

- [x] **Task 23: The browser suite**
  `apps/admin-web/e2e/narration.spec.ts` covering the spec's six scenarios. The
  flush assertion is on **network order** — the content `PUT` completes before
  the narration `POST` is issued.
  - done when: `pnpm --filter @knowledge-explorer/admin-web test:e2e` is green
    with the new spec included.

- [x] **Task 24: Documentation and harness**
  `.env.example` gains `LLM_PROVIDER`, `ANTHROPIC_API_KEY` and
  `ANTHROPIC_MODEL`, each with the comment saying why. `CLAUDE.md`'s note that
  `openai-image.live.spec.ts` is "the only test that costs money" now names two
  files. `.claude/harness/architecture.md` moves `LlmProvider` from "no
  interface" to built, records the third queue, and stops listing narration
  among the unbuilt flows. Tick every box above.
  - done when: `pnpm verify` and the Playwright suite are both green from a
    clean checkout with no `ANTHROPIC_API_KEY` set, and `rtk proxy grep -rn
    "only test that costs money" CLAUDE.md` shows the corrected wording.

---

## Progress notes — Slices A to E (server side complete)

**`pnpm verify` is green**: 9 turbo tasks, with the api suite at 229 tests
(12 files) and the worker at 12 narration tests on top of its existing 11.

### Deviations from the plan, and why

- **The Anthropic SDK, not `fetch`.** The plan's finding 1 recommended `fetch`;
  Anthropic's own API guidance directs TypeScript callers to the official SDK
  because hand-written request shapes drift. Reversed with the author before any
  adapter code was written, and finding 1 in `plan.md` has been rewritten to
  record it. `maxRetries: 0` on the client is load-bearing — the SDK's default of
  2 would have multiplied against NFR-03's 3 attempts and §6.3's 3 tries into as
  many as 18 paid calls for one chunk.

- **`withJobLifecycle` now honours `UnrecoverableError`** (a two-line change in
  `apps/worker/src/jobs/job-lifecycle.ts`). It was not in the plan, and without
  it P4 could not both skip BullMQ's retries for a §6.3 violation *and* leave the
  `generation_jobs` row in a terminal state: a first-attempt throw was recorded
  as a non-final attempt, so the row stayed `running` forever and the SSE stream
  never terminated. Behaviour is unchanged for P1 and P3, neither of which throws
  one.

- **`inFlightJobId` searches the queue rather than reading a column.** The 409
  must carry the BullMQ id the SSE stream is keyed by; `generation_jobs` has no
  column for it and §8 is not being migrated. It returns null when the lock is
  set but no job exists, which is exactly the orphaned-lock case the spec records
  as a known gap.

- **The worker takes the STORED `draft_content_checksum`** for
  `source_content_checksum` rather than recomputing it. That column is what §6.5
  compares against on read, and the content service writes it in the same
  transaction as the block list; storing a recomputation would risk every script
  being permanently stale against a value it should equal.

### A pre-existing flake, found and NOT introduced here

`turbo run test --force` fails roughly one run in three, in whichever api e2e
file loses a race — `images.e2e-spec.ts` failing its `beforeAll` `saveContent`
with a 400, or `rbac.e2e-spec.ts` getting a 404 where it expects a 401. The api
suite run alone is green 4 times out of 4.

**Confirmed pre-existing**: the P4 work was stashed and `turbo run test --force`
run three times against HEAD, which failed once in the same way. It is a
concurrency defect in the shared-database e2e suites, not something this phase
introduced, and it is left alone — fixing it is not P4 scope. Worth a ticket.

## Progress notes — Slices F to H (complete)

`pnpm verify` green (9 turbo tasks, api at 246 tests) and the Playwright suite
green at 12 tests, 5 of them new.

- **`ApiFailure` now carries the parsed error body.** The browser suite caught
  this: `apiFetch` copied only `errorCode`, `issues`, `errors` and `reason`, so
  the `figures` list on a SCRIPT_FIGURES_INCOMPLETE 422 and the `jobId` on a
  SCRIPT_GENERATION_IN_FLIGHT 409 never reached the tab — the refusal rendered
  with no explanation and the 409 could not attach to the running job. A `body`
  field was added rather than one named field per endpoint. Every unit test
  passed while this was broken; only the browser assertion found it.

- **The flush-then-generate effect checks `conflict`/`invalid` BEFORE
  `hasUnsavedWork`.** Neither state advances `savedValue`, so the buffer stays
  dirty forever and waiting for it to go clean would have left Generate disabled
  with no explanation. `retrying` is deliberately not terminal — the save may
  still land.

- **Task 21 is written but its live assertions are NOT VERIFIED.** No
  `ANTHROPIC_API_KEY` is set in this environment, so
  `anthropic-narration.live.spec.ts` skipped. It is the only evidence that a real
  model satisfies §6.3 one-segment-per-block-in-order; run it by hand before
  trusting `NARRATION_CHUNK_BLOCK_COUNT = 25`.

### Task 20 note

The adapter shipped early, in Slice B, because `createLlmProvider` could not
compile without it. Its "non-OK response throws with the provider's reason" is
now the SDK's typed `APIError` rather than hand-rolled code; it propagates
through `runNarration` untouched to `generation_jobs.error_message`, and the
worker suite's `ExplodingProvider` case covers that propagation. What remains for
Slice G is the live test.
