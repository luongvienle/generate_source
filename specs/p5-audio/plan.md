# Plan: P5 — Audio

**Spec:** specs/p5-audio/spec.md
**Status:** Approved
**Date:** 2026-09-12

## Objective

Turn the approved narration script into a merged per-lesson audio file with
per-block millisecond offsets P7's player can trust, closing the third link of
the §6.5 staleness chain and §11's last unbuilt content-pipeline port.

## Approach

The spec fixes every product decision. What planning adds is **sequencing**, and
one structural judgement: this phase has a deep spine — port → ffmpeg → worker →
API → UI — and no honest vertical slice reaches observable behaviour before most
of it exists. Even a one-segment lesson needs the migration, the port, a fake
that emits real bytes, the merge, and a producer. So tasks 1–15 are **enabling
work verified by real tests rather than by observable feature behaviour**, and
from task 16 the feature is visible end to end. That is a deliberate departure
from vertical slicing, stated rather than disguised, and every enabling task
still carries a done-when that runs.

Three sequencing decisions follow from the spec and the impact analysis.

**The queue extraction goes first and alone.** The spec says to sequence it as
its own slice with existing job suites green before audio lands on it. It is the
only work in P5 that touches P1 and P3 code, and if it goes last it merges a
refactor into a feature diff where a regression in `image:` id resolution looks
like an audio bug. Tasks 1–3 change no behaviour and must leave every existing
job test green with no edits to those tests.

**ffmpeg is proven before anything depends on it.** The merge is the one output
nothing downstream can check, so `ffmpeg.ts` and its timing assertions land
(tasks 11–13) before the processor that calls it. If the decode→PCM→concat→
single-encode approach does not produce exact boundaries, that is discovered in a
unit test on fixture tones, not inside a worker behind a queue.

**The API's refusals land before the worker that would spend money.** Tasks
17–20 make every precondition in the spec answerable over HTTP while the
processor is still a stub, so `AUDIO_SCRIPT_NOT_APPROVED` and
`AUDIO_SCRIPT_STALE` are provably enforced before a code path exists that could
call a paid provider.

### Patterns reused rather than reinvented

| Need | Existing code that already solves it |
|---|---|
| Provider port + fake + env factory | `llm.provider.ts`, `fake-llm.provider.ts`, `provider-factory.ts` (P4) |
| OpenAI adapter over `fetch` with an `endpoint?` override for fixture testing | `openai-image.provider.ts` (P3) |
| Transactional in-flight lock + enqueue outside the transaction + compensating catch | `narration.service.ts` `generate` (P4) |
| `markFailed()` on every terminal path incl. transport failure on the last attempt | `narration.processor.ts` (P4) |
| Worker lifecycle trio (processor / worker / service) | `narration.{processor,worker}.ts`, `narration-worker.service.ts` |
| Full-width editor tab + flush-then-generate | `narration-tab.tsx`, `lesson-editor.tsx` (P4) |
| Hand-mirrored view types across the app boundary | `narration-types.ts`, `image-types.ts` |

### Corrections to the spec found during impact analysis

Four, all small, none changing a decision. They are recorded here because the
spec's *Affected files* table would otherwise send an implementer at the wrong
file.

1. **`packages/ai` does not depend on the `openai` SDK.** The spec says the TTS
   adapter "adds no dependency" because P3's images already pull the SDK in.
   `packages/ai/package.json` lists only `@anthropic-ai/sdk`;
   `openai-image.provider.ts` calls the endpoint over plain `fetch` with a
   recorded rationale. **The conclusion holds — no new dependency — but for the
   opposite reason.** The TTS adapter follows P3's `fetch` pattern, which suits
   it better anyway: the speech endpoint returns raw audio bytes, so there is not
   even a JSON body to decode.
2. **`audioStatusSchema` and `AudioStatus` already exist** in
   `packages/shared/src/enums.ts`, added by P0 from §8.1's shared row. The spec
   lists `enums.ts` as modified; **it needs no change**.
3. **Adding the `generate_audio` permission row breaks an existing test.**
   `apps/api/test/job-permissions.spec.ts:30` asserts
   `permissionForJobType('generate_audio')` is `undefined` — it is the current
   example of the deny-by-default property. That line must be **deleted**; line
   31's `publish_course` keeps the property under test, as does the generic loop
   above it. The spec's verification section assumed the fixture was agnostic. It
   is not.
4. **Worker test files are named with a hyphen** — `narration-processor.spec.ts`,
   not `narration.processor.spec.ts`. The spec's `audio.processor.spec.ts` should
   be `audio-processor.spec.ts` to match all four existing files.

### Design detail the spec leaves to planning

**The queue registry's shape.** `QueueDefinition` carries only what must not
drift: `key`, default `name`, env-override variable, `idPrefix`,
`retentionSeconds` and `fallbackJobType`. Producers keep their own classes — they
genuinely differ (import has two job names, a Redis `readKey` and the dry-run
TTL; the other three have one job name and no retained result) — and share a
`BaseJobQueue` that owns construction, `defaultJobOptions` and `onModuleDestroy`.

**One ordering trap.** The import queue's prefix is the empty string, and
`'anything'.startsWith('')` is always `true`. `locate()` must iterate
non-empty-prefix definitions first and fall through to the empty-prefix one last,
or every id resolves to the import queue. P1's unprefixed ids are still held by
shipped screens, so this is not cosmetic; task 3 asserts it directly.

**The audio tab reuses flush-then-generate, and should.** `lesson-editor.tsx`
already threads `requestGeneration` / `pendingGeneration` into the narration tab,
and only one tab is mounted at a time (`{tab === 'narration' ? … : null}`), so a
third consumer needs no new state machine. It is also wanted: a dirty content
buffer means the script is about to go stale, and generating audio first buys a
file the next autosave invalidates.

**The atomic write needs a transaction where P4 needed one statement.** P4
finished with a single `narrationScript.update`. P5 writes `lesson_audios` and
replaces every `audio_segments` row, so the all-or-nothing guarantee requires
`prisma.$transaction`: upsert the row, `deleteMany` its segments, `createMany`
the new set — reused segments re-inserted with their copied URL and checksum.

## Affected files

### New

| File | Change |
|---|---|
| `packages/ai/src/text-to-speech.provider.ts` | `TextToSpeechProvider`, request/response types, `TEXT_TO_SPEECH_PROVIDER` token, `maxInputCharacters` |
| `packages/ai/src/fake-tts.provider.ts` | Deterministic fake; duration and tone frequency derived from text, bytes from `ffmpeg -f lavfi -i sine` |
| `packages/ai/src/openai-tts.provider.ts` | `/v1/audio/speech` over `fetch`, `endpoint?` override, model pinned and re-verified, 4096-char limit |
| `packages/ai/test/tts-provider.spec.ts` | Fake determinism, adapter parsing against a fixture server, factory selection |
| `packages/ai/test/openai-tts.live.spec.ts` | **Costs money**; skipped unless `OPENAI_API_KEY` is set |
| `apps/api/src/jobs/base.queue.ts` | `BaseJobQueue`: construction, `defaultJobOptions`, prefixed `add`, `onModuleDestroy` |
| `apps/api/src/jobs/audio.queue.ts` | Producer, `audio:` prefix |
| `apps/api/src/content/audio.controller.ts` | `POST`/`GET /admin/lessons/:lessonId/audio`, guard split by method |
| `apps/api/src/content/audio.service.ts` | Preconditions, voice resolution, transactional lock, read model, presigned merged URL, audio staleness |
| `apps/api/test/audio.e2e-spec.ts` | Preconditions, RBAC, R-01/R-02, staleness transitions, presigned URL |
| `apps/worker/src/audio/ffmpeg.ts` | `assertFfmpegAvailable`, `probeDurationMs`, `mergeSegments`; the only process spawn in the worker |
| `apps/worker/src/jobs/audio.processor.ts` | Reuse pass, bounded synthesis, merge, offsets, atomic write |
| `apps/worker/src/jobs/audio.worker.ts` | BullMQ wiring, `AUDIO_CONCURRENCY`, NFR-07 logging |
| `apps/worker/src/jobs/audio-worker.service.ts` | Lifecycle, provider selection at startup |
| `apps/worker/test/ffmpeg.spec.ts` | Boundary exactness on fixture tones; the stream-copy drift control |
| `apps/worker/test/audio-merge.spec.ts` | The spec's §2 timing assertions, processor-level |
| `apps/worker/test/audio-processor.spec.ts` | Reuse, regeneration, voice change, mid-run failure, character counting |
| `apps/admin-web/lib/audio-types.ts` | Hand-mirrored view types and paths |
| `apps/admin-web/components/editor/audio-tab.tsx` | Generate, freshness badges, progress, plain player |
| `apps/admin-web/e2e/audio.spec.ts` | Browser suite |
| `packages/database/prisma/migrations/<new>/migration.sql` | Three `ADD COLUMN`s; **not** a regeneration |

### Modified

| File | Change |
|---|---|
| `packages/shared/src/queues.ts` | `QueueDefinition` + registry for all four queues; `AUDIO_QUEUE_NAME`, `audioJobNames`, `GenerateAudioJobData`, `AUDIO_SEGMENT_CONCURRENCY`, `AUDIO_RUN_MAX_SEGMENTS`; **replace** the twice-deferred extraction note with what happened |
| `packages/shared/src/errors.ts` | `AUDIO_SCRIPT_NOT_FOUND`, `AUDIO_SCRIPT_NOT_APPROVED`, `AUDIO_SCRIPT_STALE`, `AUDIO_GENERATION_IN_FLIGHT`, `AUDIO_TOO_MANY_SEGMENTS`, `AUDIO_SEGMENT_TOO_LONG`, `AUDIO_VOICE_NOT_CONFIGURED` |
| `packages/ai/src/provider-factory.ts` | `createTextToSpeechProvider(env)` |
| `packages/ai/src/index.ts` | Re-export the three new modules |
| `packages/storage/src/keys.ts` | `audioMediaTypes`, `mintAudioSegmentKey`, `mintMergedAudioKey` |
| `packages/storage/test/keys.spec.ts` | Cover the two new minters |
| `packages/database/prisma/schema.prisma` | `Course.voiceProviderName`, `Course.voiceIdentifier`, `AudioSegment.sourceSegmentChecksum` |
| `apps/api/src/jobs/import.queue.ts`, `image.queue.ts`, `narration.queue.ts` | Extend `BaseJobQueue`; behaviour and exported prefixes unchanged |
| `apps/api/src/jobs/job-status.service.ts` | `locate()` and `fallbackJobTypes` from the registry; empty prefix last |
| `apps/api/src/jobs/job-permissions.ts` | `generate_audio: 'generateAudio'`; add to `lessonTargetedJobTypes` |
| `apps/api/test/job-permissions.spec.ts` | **Delete line 30's `generate_audio` assertion** (see correction 3) |
| `apps/api/src/content/narration.service.ts` | `StalenessView` gains `audio`; remove the P4 note explaining its absence |
| `apps/api/src/content/courses.controller.ts` | `PATCH :courseId/voice`, owner-only |
| `apps/api/src/app.module.ts` | Register controller, service, queue, `TEXT_TO_SPEECH_PROVIDER` |
| `apps/worker/src/worker.module.ts` | `AudioWorkerService` + provider binding |
| `apps/worker/src/main.ts` | `assertFfmpegAvailable()` before the ready line; **correct the stale queue list** in that line |
| `apps/admin-web/components/editor/lesson-editor.tsx` | Third tab; widen the tab union and label map |
| `.env.example` | `TTS_PROVIDER`, `OPENAI_TTS_MODEL`, `TTS_DEFAULT_VOICE` |
| `.github/workflows/ci.yml` | ffmpeg install step; `TTS_PROVIDER: fake` |
| `CLAUDE.md` | ffmpeg prerequisite; three money-costing tests |
| `.claude/harness/architecture.md` | `TextToSpeechProvider` built; queue registry extracted; ffmpeg a runtime dependency |

**Explicitly unchanged:** `packages/shared/src/enums.ts` (correction 2),
`packages/shared/src/roles.ts` (`generateAudio` exists), `packages/content/*`
(the checksums compared are P4's), `20260911180121_init/migration.sql`.

## Risks

- **The migration touches a file class the project forbids regenerating.**
  Mitigation: generate with `prisma migrate dev --create-only`, then read the
  emitted SQL and confirm it contains exactly three `ALTER TABLE … ADD COLUMN`
  statements and no `DROP`. `constraints.spec.ts` is the guard and must be green
  before and after. If the emitted file contains anything else, discard it and
  hand-write the three statements.
- **`source_segment_checksum` is `NOT NULL` with no default.** Safe only because
  no code has ever written `audio_segments`. Mitigation: confirm
  `select count(*) from audio_segments` is 0 on the dev database before applying;
  if any environment has rows, the column ships nullable instead and the spec
  gets an amendment.
- **The queue extraction can silently break P1's unprefixed ids.** The empty
  prefix matches everything. Mitigation: task 3's done-when asserts an unprefixed
  id resolves to the import queue *and* that `image:`/`script:`/`audio:` resolve
  to theirs; `job-stream.e2e-spec.ts` must pass with no edits.
- **Offset drift is invisible without the right assertion.** Comparing stored
  offsets against summed per-file durations would assert the code against its own
  arithmetic. Mitigation: the zero-crossing frequency probe in task 12, plus a
  stream-copy control that must fail. If the control passes, the assertion is
  wrong, not the merge.
- **ffmpeg now gates the worker's boot, so two suites that spawn the worker
  inherit the dependency.** `apps/admin-web/e2e/global-setup.ts` and
  `apps/api/test/helpers/worker-process.ts` both wait on the `Worker ready.`
  prefix; a failed probe exits before that line and surfaces as "worker exited
  early" with the captured output. That is the intended failure, but it means a
  machine without ffmpeg can no longer run either suite. Mitigation: the probe
  message names the missing binary, and `CLAUDE.md` lists ffmpeg as a
  prerequisite alongside Node 22.
- **CI has never run** — the repository has no git remote — so the ffmpeg step
  cannot be proven green by a job log. Mitigation: task 14's done-when is the
  local equivalent of the CI sequence, and the step's correctness is reviewed by
  reading, with this limitation stated rather than implied.
- **A paid provider is one environment variable away throughout.** Mitigation:
  `TTS_PROVIDER` defaults to the fake everywhere including CI, `openai` without a
  key throws at construction, and the only test that spends money is skipped
  unless a key is present.
- **Two admins, one lesson.** The in-flight lock is a row status, so a second
  `POST` gets 409 with the running job id rather than a second paid run.
  Mitigation: covered in `audio.e2e-spec.ts`; the pattern is P4's and unchanged.

## Test strategy

**Unit, no network and no database:** the provider contract
(`packages/ai/test/tts-provider.spec.ts`) — fake determinism by duration and
frequency, the OpenAI adapter parsed against a local fixture server through its
`endpoint?` override, the over-limit refusal, and factory selection including
`openai`-without-a-key throwing.

**Unit, real ffmpeg, no database:** `apps/worker/test/ffmpeg.spec.ts` — the
decisive timing work in isolation. Known-duration tones in, exact boundaries out,
contiguity from zero, ffprobe of the merged file agreeing with the last
`end_millisecond`, each window carrying its own tone and not its neighbours', and
a `-c copy` control that **must fail**.

**Integration, real Postgres and MinIO:** `audio-processor.spec.ts` and
`audio-merge.spec.ts` with a counting fake — zero provider calls on an unchanged
re-run, exactly one after a single edit, all of them after a voice change, a
mid-run throw leaving the previous row and merged URL untouched, and
`total_character_count` covering the whole script rather than the segments this
run paid for.

**End-to-end over HTTP:** `audio.e2e-spec.ts` — every precondition refusal with
its `errorCode`, the 409 carrying a job id, RBAC across three roles, R-01 and
R-02 on writes with reads still permitted, the owner-only voice `PATCH`, the four
staleness transitions (`null` → `ready` → `stale` after a narration edit →
`stale` after a voice change), and a presigned merged URL that fetches while the
stored column stays a key.

**Browser:** `apps/admin-web/e2e/audio.spec.ts` — Generate disabled with a
visible reason on an unapproved script, progress advancing after approval, an
`<audio>` element whose `src` returns `audio/mpeg` (asserted by intercepting the
response, never by playing it), a single narration edit flipping exactly one
badge, and the regeneration dialog's re-synthesize and reuse counts.

**Regression, unedited:** `job-stream.e2e-spec.ts`, `import-queue.spec.ts`,
`images.e2e-spec.ts` and `narration.e2e-spec.ts` must pass untouched after the
queue extraction. The single permitted test edit in this phase is the deletion at
`job-permissions.spec.ts:30`, and it is its own task so it cannot hide in a diff.

**The spec's end-to-end verification** runs as written at task 26: `nvm use`,
`ffmpeg -version && ffprobe -version`, `docker compose up -d --wait`,
`pnpm install --frozen-lockfile`, `pnpm db:migrate`, `pnpm verify`, then
`pnpm --filter @knowledge-explorer/admin-web test:e2e`, both exiting `0` with no
`OPENAI_API_KEY` set.

## Out of scope

From the spec's non-goals, unchanged: highlight sync and seek-to-block
(FR-AUDIO-02) including `last_audio_position_ms` and the playback-speed
preference; the FR-PUB-01 publish gate; any learner-facing exposure, including
the entitlement-gated `GET /media/:mediaId/signed-url` and E-01's regression
test; per-segment regeneration as a UI action; multiple voices per lesson or
course; editing narration text from the audio tab; reclaiming orphaned objects;
any Dockerfile or deployment configuration; cost dashboards.

Added during planning:

- **No change to `packages/content`.** The checksums this phase compares are
  P4's, already exported. Nothing audio-related belongs in a package the browser
  reaches.
- **No change to `packages/shared/src/enums.ts` or `roles.ts`** — both already
  carry what P5 needs (corrections 2 and the existing `generateAudio` action).
- **The queue extraction does not unify the producers' public APIs.**
  `ImportQueue.enqueueDryRun/enqueueCommit/readKey` stay exactly as they are;
  only construction, job options and id prefixing move to the base class. A
  wider refactor would put P1's import flow at risk for no P5 benefit.
- **No stale-lock recovery.** An orphaned `generating` lock is a recorded open
  question in both P4 and P5 and belongs with P10's job alerting, covering both
  locks at once.
