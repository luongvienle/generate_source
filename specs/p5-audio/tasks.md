# Tasks: P5 — Audio

**Plan:** specs/p5-audio/plan.md

Tick boxes as work completes, not at the end — this file is the durable progress
state and is what survives a lost session.

Two rules for this phase specifically:

- **Tasks 1–3 change no behaviour.** Every existing job test must pass with no
  edits. If one needs editing, stop: the extraction has changed something it
  should not have.
- **The only permitted test edit in P5 is task 16's single deletion.** It is its
  own task so it cannot hide inside a larger diff.

---

## Slice A — Queue registry (refactor only, no audio)

- [x] **Task 1: Declare the queue registry in `packages/shared/src/queues.ts`**
  Add `QueueDefinition` (`key`, `name`, `envVar`, `idPrefix`, `retentionSeconds`,
  `fallbackJobType`) and a `queueDefinitions` registry covering all four queues —
  import (`idPrefix: ''`, `DRY_RUN_RESULT_TTL_SECONDS`), image (`'image:'`),
  narration (`'script:'`), audio (`'audio:'`). **Replace** the twice-deferred
  extraction note with a record of what was actually done and why the producers
  stayed separate.
  - done when: `pnpm --filter @knowledge-explorer/shared test` and
    `pnpm --filter @knowledge-explorer/shared typecheck` both exit 0, and the
    registry's four `idPrefix` values are `''`, `image:`, `script:`, `audio:`.

- [x] **Task 2: Add `BaseJobQueue` and migrate the three existing producers**
  New `apps/api/src/jobs/base.queue.ts` owning `Queue` construction,
  `defaultJobOptions` (attempts, exponential backoff, retention from the
  definition) and `onModuleDestroy`, plus a protected `add(name, data)` returning
  the prefixed id. Re-point `ImportQueue`, `ImageQueue` and `NarrationQueue` at
  it. `IMAGE_JOB_ID_PREFIX` and `NARRATION_JOB_ID_PREFIX` keep their exported
  names and values; `enqueueDryRun`, `enqueueCommit` and `readKey` keep their
  signatures.
  - done when: `pnpm --filter @knowledge-explorer/api test import-queue` and
    `pnpm --filter @knowledge-explorer/api test job-stream` pass **with no edits
    to either test file**.

- [x] **Task 3: Drive `job-status.service.ts` from the registry**
  Replace the hardcoded prefix tuples and `fallbackJobTypes` map with iteration
  over `queueDefinitions`. Non-empty prefixes are matched first and the
  empty-prefix definition is the fallback — `'anything'.startsWith('')` is always
  true, so ordering is load-bearing.
  - done when: a new case in `apps/api/test/job-stream.e2e-spec.ts` asserts an
    **unprefixed** import id still resolves to `import_course_outline`, and that
    `image:` and `script:` ids resolve to their own queues; the whole api suite
    is green.

## Slice B — Schema

- [x] **Task 4: Add the three columns and the new migration**
  `Course.voiceProviderName` and `Course.voiceIdentifier` (both nullable, mapped
  `voice_provider_name` / `voice_identifier`), and
  `AudioSegment.sourceSegmentChecksum` (`String`, `NOT NULL`, mapped
  `source_segment_checksum`). Generate with
  `pnpm --filter @knowledge-explorer/database exec prisma migrate dev --create-only`,
  then **read the emitted SQL**: it must contain exactly three `ALTER TABLE …
  ADD COLUMN` statements and no `DROP` of any kind. If it contains anything else,
  discard the file and hand-write the three statements.
  - done when: `select count(*) from audio_segments` returned 0 before applying;
    `pnpm db:migrate` applies cleanly; `pnpm --filter @knowledge-explorer/database test`
    is green, `constraints.spec.ts` included; and
    `20260911180121_init/migration.sql` is byte-identical to its committed state
    (`git diff --exit-code` on that path).

## Slice C — The port and its two implementations

- [x] **Task 5: `TextToSpeechProvider` port**
  `packages/ai/src/text-to-speech.provider.ts`: the interface,
  `SynthesisRequest` (`text`, `voiceIdentifier`, `languageCode`),
  `SynthesisResult` (`bytes`, `contentType`, `voiceIdentifier`, `providerName`,
  `modelName`, `characterCount`), the `TEXT_TO_SPEECH_PROVIDER` Symbol token, and
  `maxInputCharacters` on the provider.
  - done when: `pnpm --filter @knowledge-explorer/ai typecheck` exits 0 and the
    barrel re-exports the module.

- [x] **Task 6: `FakeTextToSpeechProvider` emitting real MP3 tones**
  Duration and tone frequency derived deterministically from the text; bytes
  produced by spawning `ffmpeg -f lavfi -i sine=frequency=F:duration=D` encoded to
  MP3. Document in the file that this is what makes the timing assertions
  possible, and that `packages/ai` is server-only so `node:child_process` is
  available.
  - done when: `pnpm --filter @knowledge-explorer/ai test tts-provider` asserts
    ffprobe reports the predicted duration for three different texts, and that the
    same text twice yields the same duration and frequency.

- [x] **Task 7: `OpenAiTextToSpeechProvider` over `fetch`**
  `POST https://api.openai.com/v1/audio/speech` following
  `openai-image.provider.ts` — plain `fetch`, no SDK (`packages/ai` has no
  `openai` dependency and is not gaining one), an `endpoint?` override for
  fixture testing, model pinned as `gpt-4o-mini-tts` with `OPENAI_TTS_MODEL`
  overriding, `maxInputCharacters = 4096`, `characterCount` from input length
  because the endpoint returns bytes and no usage metadata. Record in the file
  that the identifier, voices, limit and pricing were re-verified against current
  documentation, with the date.
  - done when: a fixture server returning known MP3 bytes yields the right
    `bytes`, `contentType`, `modelName`, `providerName` and `characterCount`;
    input over 4096 characters throws **before** any fetch; a non-OK response
    throws carrying the provider's reason.

- [x] **Task 8: Factory, barrel and environment**
  `createTextToSpeechProvider(env)` in `provider-factory.ts` beside the other
  two: `TTS_PROVIDER=openai` selects the adapter, anything else — including
  unset — the fake; `openai` with no `OPENAI_API_KEY` throws at construction.
  Add `TTS_PROVIDER`, `OPENAI_TTS_MODEL` and `TTS_DEFAULT_VOICE` to
  `.env.example` with the same commentary style P3 and P4 used.
  - done when: the selection cases pass in `tts-provider.spec.ts`, and
    `.env.example` documents why anything-but-`openai` is the fake.

## Slice D — ffmpeg, proven before anything depends on it

- [x] **Task 9: `apps/worker/src/audio/ffmpeg.ts`**
  `assertFfmpegAvailable()`, `probeDurationMs(path)` and `mergeSegments(...)`.
  The merge **decodes every segment to a uniform PCM format, concatenates the
  PCM, and encodes once** — never `-c copy`. Boundaries come from exact decoded
  sample counts, not container durations. The module is the only place in
  `apps/worker` that spawns a process.
  - done when: `pnpm --filter @knowledge-explorer/worker test ffmpeg` merges
    eight known-duration tone files and every returned boundary matches its
    expected duration within ±5 ms, the first starts at 0, each end equals the
    next start exactly, and the last equals `probeDurationMs` of the merged file
    within ±20 ms.

- [x] **Task 10: The frequency probe and the drift control**
  A test helper that cuts `[start + 20 ms, end − 20 ms]` out of the merged file,
  decodes it to 16-bit PCM and recovers the dominant frequency by counting zero
  crossings — no new dependency. Then the control: the same fixture merged with
  `-c copy` instead of re-encoded.
  - done when: every window in the re-encoded merge carries its own tone and not
    a neighbour's, and the `-c copy` control **fails** — its last boundary no
    longer matches ffprobe's duration and its later windows carry the wrong tone.
    A passing control means the assertion is wrong, not the merge.

- [x] **Task 11: Boot probe in the worker**
  Call `assertFfmpegAvailable()` in `apps/worker/src/main.ts` after the Redis
  ping and before `enableShutdownHooks`, failing with a message naming the
  missing binary and a non-zero exit code, in the same shape as the Redis
  failure. While in the file, **correct the stale ready-line text** — it still
  says "the curriculum import and image generation queues" and has not mentioned
  narration since P4. Keep the `Worker ready.` prefix exactly: two test helpers
  match on it.
  - done when: the worker starts normally with ffmpeg present; with a `PATH`
    stubbed to hide `ffprobe` it exits non-zero with a message naming `ffprobe`
    and never prints `Worker ready.`.

- [x] **Task 12: ffmpeg in CI**
  Add an explicit `apt-get install -y ffmpeg` step to `.github/workflows/ci.yml`
  before `pnpm install`, and `TTS_PROVIDER: fake` to the job env beside
  `IMAGE_PROVIDER: fake`.
  - done when: the step is present and ordered before `pnpm install`, and the
    full local equivalent (`pnpm exec turbo run typecheck lint test`) passes.
    **Note the limitation in the commit body:** the repository has no git remote,
    so this job has never run and the step is verified by reading, not by a log.

## Slice E — Shared constants, errors, permissions, keys

- [x] **Task 13: Audio constants and error codes**
  In `queues.ts`: `AUDIO_QUEUE_NAME`, `audioJobNames`, `GenerateAudioJobData`
  (`generationJobId`, `lessonId`, `voiceIdentifier`, `voiceProviderName`,
  `createdByUserId` — the voice resolved at enqueue so a retry cannot mix
  voices), `AUDIO_SEGMENT_CONCURRENCY`, `AUDIO_RUN_MAX_SEGMENTS`. In `errors.ts`:
  the seven `AUDIO_*` codes. **`enums.ts` needs no change** —
  `audioStatusSchema` and `AudioStatus` already exist from P0.
  - done when: `pnpm --filter @knowledge-explorer/shared test` is green and
    `git diff --exit-code packages/shared/src/enums.ts` shows no change.

- [x] **Task 14: Object keys for audio**
  `audioMediaTypes`, `mintAudioSegmentKey({ lessonId, audioSegmentId })` →
  `lessons/{lessonId}/audio/segments/{audioSegmentId}.mp3`, and
  `mintMergedAudioKey({ lessonId, generationJobId })` →
  `lessons/{lessonId}/audio/merged/{generationJobId}.mp3`. Segment keys are
  stable across runs so reuse copies a URL; merged keys are per-run so a new
  merge never overwrites bytes a presigned URL is serving.
  - done when: `pnpm --filter @knowledge-explorer/storage test keys` covers both
    minters, including that two runs over one lesson mint different merged keys
    and that a reused segment id mints the same segment key.

- [x] **Task 15: The `generate_audio` permission row**
  `job-permissions.ts` gains `generate_audio: 'generateAudio'` and
  `generate_audio` joins `lessonTargetedJobTypes` so R-02 applies to watching it.
  The `generateAudio` action already exists in `roles.ts`; do not add one.
  - done when: `pnpm --filter @knowledge-explorer/api test job-permissions`
    fails on the stale assertion — which task 16 then removes. Do not fix it here.

- [x] **Task 16: Retire the stale deny-by-default example**
  Delete line 30 of `apps/api/test/job-permissions.spec.ts`
  (`expect(permissionForJobType('generate_audio')).toBeUndefined();`). Line 31's
  `publish_course` and the generic loop above keep the deny-by-default property
  under test. **This is the only test edit permitted in P5.**
  - done when: `pnpm --filter @knowledge-explorer/api test job-permissions` is
    green, `publish_course` is still asserted undeclared, and
    `mayWatch('generate_audio', 'learner')` is `false`.

## Slice F — API: refusals before any spend

- [x] **Task 17: The audio queue producer**
  `apps/api/src/jobs/audio.queue.ts` on `BaseJobQueue`, `AUDIO_JOB_ID_PREFIX =
  'audio:'`, `enqueueGenerate` returning the qualified id.
  - done when: an enqueued job returns an id matching `/^audio:\d+$/` and
    `JobStatusService.snapshot` resolves it to `generate_audio`.

- [x] **Task 18: Course voice configuration**
  `PATCH /admin/courses/:courseId/voice` with a zod `strictObject` body, declaring
  `@RequirePermission('createCategoriesAndCourses')` — owner-only, matching
  `PATCH :courseId/pricing-type`. A `resolveVoice(courseId)` helper falls back to
  `TTS_DEFAULT_VOICE` and the selected provider when the columns are null, and
  refuses a voice the provider does not recognise with
  `422 AUDIO_VOICE_NOT_CONFIGURED`.
  - done when: `audio.e2e-spec.ts` shows owner 200, admin 403, learner 403, an
    unrecognised voice 422, and a course with null columns resolving to the env
    default.

- [x] **Task 19: `audio.service.ts` — preconditions, lock, enqueue**
  Every refusal in the spec, in order, before any enqueue: no script 404; not
  approved 422; computed status `stale`/`failed`/`generating`/`pending` 422; in
  flight 409 carrying the running job id; over `AUDIO_RUN_MAX_SEGMENTS` 422; a
  segment over `maxInputCharacters` 422 naming the `blockId`. Then P4's
  transactional pattern: `createQueuedJob` and the `lesson_audios` upsert in one
  `$transaction` with `''` for the `NOT NULL` `merged_audio_file_url` and
  `source_script_checksum` and the resolved voice written for real; the enqueue
  **outside** it with a compensating catch that clears `generating`.
  - done when: `pnpm --filter @knowledge-explorer/api test audio` shows each
    refusal with its `errorCode`, the 409 carrying a job id, and a failed enqueue
    leaving `audio_status = 'failed'` rather than a wedged `generating`.

- [x] **Task 20: `audio.controller.ts`**
  `POST` and `GET /admin/lessons/:lessonId/audio`, both declaring
  `@RequirePermission('generateAudio')`. Guards split by method as
  `narration.controller.ts` does: controller-level `SessionGuard` + `RolesGuard`,
  with `PublishedLockGuard` and `AssignmentGuard` added to the write only, so an
  admin can still read the audio state of a lesson they may not write. The read
  model presigns the merged URL; the stored column is a key and is never returned
  as one.
  - done when: `audio.e2e-spec.ts` shows learner refused on both methods, a
    non-owner admin 403 on `POST` against a published course (R-01) and against a
    lesson assigned elsewhere (R-02) while `GET` still succeeds, and a presigned
    URL that fetches.

## Slice G — Worker: where the money would be spent

- [x] **Task 21: `audio.processor.ts`**
  Reuse pass first (match `source_segment_checksum` against the current
  `segmentChecksum` **and** the resolved voice), then bounded-concurrency
  synthesis of the rest, then `mergeSegments`, then one `$transaction`: upsert
  `lesson_audios`, `deleteMany` its segments, `createMany` the new set with
  reused rows carrying their copied URL and checksum. Mirror P4's `markFailed()`
  and `isFinalAttempt` so a transport failure on the last attempt still clears
  the lock. `total_character_count` covers the whole script, not just this run's
  calls.
  - done when: `pnpm --filter @knowledge-explorer/worker test audio-processor`
    shows zero provider calls on an unchanged re-run, exactly one after a single
    narration edit with every other `segment_audio_file_url` byte-identical, all
    segments re-synthesized after a voice change, and a throw on segment 6 of 8
    leaving the previous row, its segments and the previous merged URL untouched
    with `audio_status = 'failed'`.

- [x] **Task 22: Worker wiring**
  `audio.worker.ts` (BullMQ worker, `AUDIO_CONCURRENCY`, NFR-07 failure logging
  with `jobType`/`jobId`/`attemptCount`/`targetEntityId`),
  `audio-worker.service.ts` (lifecycle, `createTextToSpeechProvider()` once at
  startup so a misconfigured provider fails the boot), and registration in
  `worker.module.ts`. Progress reports `{ done, total }` with reused segments
  counted done immediately, and the merge as its own final step.
  - done when: `pnpm --filter @knowledge-explorer/worker test audio-merge` passes
    the spec's §2 timing assertions **at processor level** — every boundary, the
    contiguity chain, ffprobe agreement, and the per-window frequency check.

## Slice H — Staleness, the third link

- [x] **Task 23: The `audio` key on the staleness endpoint**
  `StalenessView` gains `audio`, `null` when there is no row. Computed `stale`
  when stored is `ready` **and** either `source_script_checksum` differs from the
  script's current `script_checksum` **or** the row's voice differs from the
  course's resolved voice; `failed` outranks `stale`; `stale` is never stored.
  Report `staleSegmentBlockIds` and `orphanedSegmentBlockIds`. Remove P4's note
  explaining the key's absence.
  - done when: `audio.e2e-spec.ts` walks `null` → `ready` → `stale` after a
    narration edit → `stale` after a voice change with the script untouched, and
    `narration.e2e-spec.ts` passes unedited.

## Slice I — The tab

- [x] **Task 24: `audio-types.ts` and `audio-tab.tsx`**
  Hand-mirrored view types and paths following `narration-types.ts`. A full-width
  tab: rows in block order showing the narration text read-only with figure or
  table number and a freshness badge, orphaned segments listed after and marked,
  a Generate button disabled with the server's reason, job progress over the
  existing SSE endpoints, a regeneration confirmation naming the re-synthesize
  and reuse counts, and a plain `<audio controls>` on the presigned merged URL.
  No highlight sync and no seek-to-block.
  - done when: the tab renders against a seeded lesson and shows correct badges,
    counts and a playable element.

- [x] **Task 25: Third tab in `lesson-editor.tsx`, and the browser suite**
  Widen the tab union to `'write' | 'narration' | 'audio'`, replace the
  two-branch label ternary with a label map, and thread the existing
  `requestGeneration` / `pendingGeneration` props into the audio tab — only one
  tab is mounted at a time, so no new state machine is needed, and flushing
  matters here because a dirty buffer means the script is about to go stale.
  - done when: `pnpm --filter @knowledge-explorer/admin-web test:e2e` passes
    including the new `audio.spec.ts`: Generate disabled with a visible reason on
    an unapproved script; after approval, progress advances and an `<audio>`
    element appears whose `src` returns `audio/mpeg` (asserted by intercepting
    the response, never by playing it); one narration edit flips exactly one
    badge; the confirmation shows the right counts.

## Slice J — Close out

- [x] **Task 26: The live provider test**
  `packages/ai/test/openai-tts.live.spec.ts`, skipped unless `OPENAI_API_KEY` is
  set: one short Vietnamese sentence, asserting MP3 bytes of non-zero duration and
  that the pinned voice is accepted. The only evidence that the pinned model and
  voice exist and speak `vi`.
  - done when: the file skips cleanly with no key set, and its skip is visible in
    the test output rather than silent.

- [x] **Task 27: Documentation and harness**
  `CLAUDE.md`: ffmpeg as a prerequisite alongside Node 22, and the money-costing
  tests now numbering three. `.claude/harness/architecture.md`:
  `TextToSpeechProvider` built, the queue registry extracted with the producers
  still separate, ffmpeg a runtime dependency of the worker.
  - done when: both files describe the delivered state, and the spec's full
    verification sequence runs clean from a fresh shell —
    `nvm use`, `ffmpeg -version && ffprobe -version`,
    `docker compose up -d --wait`, `pnpm install --frozen-lockfile`,
    `pnpm db:migrate`, `pnpm verify`,
    `pnpm --filter @knowledge-explorer/admin-web test:e2e` — both commands exiting
    `0` with no `OPENAI_API_KEY` set.

---

## Implementation notes

Append findings here as work proceeds, as `specs/p4-narration/tasks.md` does.
Decisions taken, rejected alternatives and gaps discovered belong in this section
and in the commit bodies, not only in the code.

### Slice A — the queue extraction

- **`BaseJobQueue` keeps `queueName` as an optional SECOND POSITIONAL argument.**
  Six suites construct producers as `new XQueue(url, name)` to isolate a queue
  per run (`job-stream`, `import`, `import-queue`, `images`, `narration`). Moving
  it into an options object would have been tidier and would have turned a
  production refactor into a test-wide one.

- **The logger context comes from `this.constructor.name`**, so `[ImportQueue]`
  still prefixes every enqueue line exactly as before. Verified in the
  `import-queue` output rather than assumed.

- **`prefixedQueueDefinitions` / `unprefixedQueueDefinition` exist so the empty
  prefix cannot be got wrong by reordering.** `'anything'.startsWith('')` is
  always true, so a resolver iterating the registry in declaration order would
  route every id to import. Splitting the two lists in `packages/shared` means a
  consumer has to go out of its way to reintroduce the bug. Four new cases in
  `job-stream.e2e-spec.ts` pin it, including that `image:999999` resolves to
  absent rather than falling through to an import lookup of that literal key.

- **`QueueInstances` is `Partial<Record<QueueKey, Queue>>` on purpose.** The
  registry declares four queues; `apps/api` has registered three until task 17
  adds the audio producer. A definition with no instance is skipped rather than
  throwing — correct for a queue this process does not produce to — and task 17's
  done-when is what proves audio actually got wired, since a silent skip and a
  working queue look the same from outside.

- **Tests were ADDED, not edited.** The preamble rule forbids changing an
  existing assertion to make it pass; new coverage is not that. No existing
  assertion in `job-stream.e2e-spec.ts` or `import-queue.spec.ts` was touched.

- **One pre-existing cross-suite flake observed, not caused here.** The first
  full `apps/api` run after the extraction failed one assertion in
  `narration.e2e-spec.ts` — `generate(ids.assignedLesson, tokens.adminA)`
  expecting 403 `FORBIDDEN_NOT_ASSIGNED`. Three subsequent full runs were green
  at 250/250, and `narration` alone is green at 26/26. The refusal it asserts
  comes from `AssignmentGuard`, which runs **before** any service or queue code,
  so nothing in this slice can reach it. Recorded rather than dismissed: the api
  suites share one database with `fileParallelism: false`, and this is the shape
  a shared-fixture race takes. Worth a look if it recurs.

### Slice C — the provider port

- **The spec's "no new dependency" conclusion held, its reason did not.**
  `packages/ai` never carried the `openai` SDK; P3's image adapter calls the
  endpoint over plain `fetch` with a recorded rationale. The TTS adapter follows
  that pattern, which suits it better anyway — the speech endpoint returns audio
  bytes, so there is not even a JSON body to decode.

- **The model, voices and character cap were verified against live
  documentation on 2026-09-12**, as §6.3's discipline demands rather than pinned
  from memory: `gpt-4o-mini-tts` is current; its voices are alloy, ash, ballad,
  coral, echo, fable, nova, onyx, sage, shimmer, verse, marin and cedar (the docs
  recommend marin or cedar); `input` is capped at 4096 characters, quoted as "The
  maximum length is 4096 characters"; mp3 is the default `response_format`; and
  the response body is the audio file, not JSON. **Pricing was NOT verified** and
  is deliberately not encoded in the adapter — it belongs to whoever sets
  `TTS_PROVIDER=openai` in a real deployment.

- **`execFile` has no `input` option.** That belongs to `execFileSync`. Passing
  one does nothing, silently, so ffprobe sat waiting on an stdin that never
  closed and the first run of the provider suite died on two 30-second timeouts
  pointing nowhere near the cause. Every probe now writes a temp file, which is
  also the only reliable way to read a container duration — ffprobe cannot seek a
  pipe. `-nostdin` was added to every ffmpeg spawn for the same class of reason.

### Slice D — ffmpeg, and a wrong turn worth recording

- **The fake writes a SEEKABLE FILE, never a pipe, and this is load-bearing.**
  ffmpeg can only write an MP3's Xing/LAME gapless header when its output is
  seekable, because the header is patched once the last frame is known. The first
  version of the fake piped to stdout; its files were headerless, read ~40 ms
  long, and — critically — made the `-c copy` control **pass**, because
  cumulative headerless container durations are self-consistent. That briefly
  looked like evidence that the re-encode was unnecessary. It was evidence that
  the fake was producing an artifact no real provider returns.

  Measured, file-written, on ffmpeg 8.0.1: a 300 ms sine reports `0.300000` and
  decodes to exactly 300.0 ms; the same tone piped reports `0.339500`.

- **With realistic input the spec's thesis holds, and now has numbers.** Eight
  segments totalling 5300 ms: the re-encode stores 5300 ms and the finished file
  probes **5.300 s**; `-c copy` stores 5300 ms and probes **5.704 s** — 404 ms
  adrift, about 50 ms per boundary, wrong audio under the stored window well
  before the last segment.

- **The control is the reason any of this is trustworthy.** `ffmpeg.spec.ts`
  merges the same fixture with `-c copy` and asserts it FAILS both the drift and
  the frequency checks. A control that passes would mean the eight assertions
  above prove nothing — which is exactly what happened while the fake was piping,
  and is why the control is a permanent part of the suite rather than a one-off
  diagnostic.

- **The decisive assertion reads the audio, not the arithmetic.** Each stored
  window is cut out of the finished file, decoded to 16-bit PCM, and its dominant
  frequency recovered by counting zero crossings with hysteresis — no FFT, no new
  dependency. `-ss`/`-t` go AFTER `-i` so the seek is accurate rather than
  snapping to a frame boundary.

### Slice E — constants, errors, keys, permissions

- **`enums.ts` needed no change, exactly as planned.** `audioStatusSchema` and
  `AudioStatus` have existed since P0, from §8.1's shared script/audio row.

- **The predicted test break happened, precisely.** Adding the `generate_audio`
  row failed `job-permissions.spec.ts` with `expected 'generateAudio' to be
  undefined` — the line was the assertion's example of an undeclared job type.
  Retired and replaced with `publish_course` (P6) and `send_expiry_reminder`
  (P8), so the deny-by-default property is still held under test by two live
  examples rather than one. This is the only existing assertion P5 changed.

- **Segment keys are stable and merged keys are not, deliberately.** Reuse copies
  a previous row's URL, so a segment key must always mint the same string for the
  same segment id. A merged key is qualified by the generation_jobs id instead, so
  a regeneration never overwrites bytes a presigned URL is currently serving; the
  superseded object is orphaned for P10, as P3 left unselected candidates.

- **The worker's ready line was stale before P5 touched it** — it still named only
  the import and image queues, having missed narration at P4. Corrected while
  adding the boot probe. The `Worker ready.` PREFIX is unchanged and now carries a
  comment saying why it may not change: two test helpers match on it.

- **The boot probe was verified by hiding `ffprobe` from `PATH`**, not by
  inspection: the worker exited 1, logged `ffprobe is required by apps/worker
  (§11) and could not be run: spawn ffprobe ENOENT`, and never printed
  `Worker ready.`. With ffmpeg present it boots normally.

### Slice F–J — API, worker, tab

- **A SECOND obsolete "not yet built" assertion surfaced that impact analysis
  missed.** `narration.e2e-spec.ts` held `has NO audio key until P5 adds one`,
  written by P4 with the comment *"asserted explicitly so P5's addition is a
  deliberate change rather than a field that quietly appears."* It is a tripwire,
  it fired on the first full run after the staleness key landed, and retiring it
  was the intended action — not a workaround. Inverted rather than deleted: the
  key is now always present and `null` means one specific thing, which is the
  property P4 was protecting. Two such tripwires existed; the plan predicted one.

- **The staleness `audio` key is composed IN THE CONTROLLER**, not inside
  `NarrationService`. That service owns the content→script link and knows nothing
  about `lesson_audios`; injecting one into the other to produce one JSON object
  would have tangled the two halves of §6.5 for a response shape.

- **`LESSON_NOT_FOUND` and `COURSE_NOT_FOUND` are bare strings, not
  `errorCodes` members.** That is the existing house pattern — P3 and P4 both do
  it — and P5 followed it rather than adding codes the spec never asked for.

- **The worker re-checks approval, not just the API.** A run can sit in the queue
  while an admin withdraws approval; the processor refuses with
  `UnrecoverableError` and spends nothing. Covered.

- **`languageCode` travels for real.** The first draft passed `''` to the
  provider because `GenerateAudioJobData` does not carry it. OpenAI's speech
  endpoint ignores the field, so nothing would have failed — which is exactly why
  it was worth fixing: the port declares it, and the next adapter would have been
  handed a lie. One join reads it from the course.

- **`next build` type-checks `e2e/` and `pnpm typecheck` does not.** The browser
  spec compiled clean under the workspace tsconfig and failed the Playwright
  webServer start with a nullable-column error. Worth knowing: a browser spec is
  not fully checked until the suite actually boots.

- **ffmpeg here is 8.0.1, not 7.** Three comments guessed "ffmpeg 7" before the
  version was actually read; corrected. The measurements themselves were real.

### Verification

- `pnpm verify` → **exit 0**; `pnpm --filter @knowledge-explorer/admin-web
  test:e2e` → **exit 0**, 16 browser tests passed, with no `OPENAI_API_KEY` set.
- 667 tests across nine workspaces, 7 skipped (the three live provider suites).
- **One intermittent failure was observed twice and could not be reproduced.**
  Once in `narration.e2e-spec.ts` (an R-02 403) and once in
  `lesson-content.e2e-spec.ts` (a 422 body assertion), both only under concurrent
  `turbo run test`, never in isolation, and never in a code path P5 touches. Six
  subsequent full runs were green at 274/274. `apps/api/vitest.config.mts`
  already documents this class of symptom: `fileParallelism: false` serializes
  files WITHIN the api workspace, but turbo runs workspaces concurrently, and the
  config's own comment records suites timing out under that contention. P5 adds
  CPU-heavy ffmpeg suites to the worker workspace, which plausibly increases it.
  Not diagnosed further, and not claimed to be fixed.