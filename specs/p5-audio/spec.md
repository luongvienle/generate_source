# Spec: P5 — Audio

**Status:** Approved
**Date:** 2026-09-12

Derived from `knowledge-explorer-spec.md` §12 phase P5 — *"`TextToSpeechProvider`,
per-segment synthesis, ffmpeg merge and offsets, selective regeneration."* That
document is the product source of truth and is locked except §14; this spec adds
only the implementation decisions P5 requires and the product spec does not make,
**and closes §14 decision #4**. It assumes `specs/p1-curriculum/`,
`specs/p2-authoring/`, `specs/p3-images/` and `specs/p4-narration/` are
delivered, which as of this writing they are.

## Problem statement

`lesson_audios` and `audio_segments` are empty tables that no code reads or
writes. §11's `TextToSpeechProvider` has no interface. The §6.5 staleness chain
is built two links deep — P2 computes `draft_content_checksum`, P4 consumes it
and computes `script_checksum` — and the third link, `source_script_checksum`,
points at nothing.

P5 closes that gap and is the phase where the product's listening feature becomes
real. Three things make it harder than the phase count suggests.

It is the first phase that produces a **measured** artifact. Every earlier
generator produced text or bytes whose correctness a human judges; P5 produces a
number — `start_millisecond` — that is either right or wrong, and that P7's
highlight sync consumes without being able to check it. §6.4 chose per-segment
synthesis with an ffmpeg merge precisely so a one-block edit costs one segment,
and that choice is exactly what makes the offsets non-trivial: the merged file's
segment boundaries have to be derived rather than observed.

It is the first phase that **adds a column since P0**. FR-AUDIO-03 says "a course
has one configured voice in v1" and §8 gives `courses` no voice column at all.
FR-AUDIO-01 says regeneration synthesizes only stale segments and §8 gives
`audio_segments` no checksum to compare. Both requirements are unimplementable
against the schema as written, and both are fixed here — in a new migration,
never by regenerating `20260911180121_init`.

And it is the first phase whose worker needs something that is not an npm
package. ffmpeg is named in §11 as infrastructure and is currently installed
nowhere the project controls: no Dockerfile exists and `ci.yml` has no step for
it. A phase that silently inherits a binary from a runner image has not actually
decided anything.

## Acceptance criteria

### The synthesis strategy (§14 #4, closed)

- **§6.4's chosen approach binds: one TTS call per segment, ffprobe measurement,
  ffmpeg merge, stored offsets.** §14 decision #4 — whether a marks-based
  provider would remove the ffmpeg dependency — is **closed by this spec in
  favour of §6.4**, and §14 should be read as settled for P5's purposes.
  - *Rationale, recorded so it is not reopened:* a marks-based provider forces
    whole-lesson resynthesis on any edit, which contradicts FR-AUDIO-01's second
    bullet and wastes the per-segment `segmentChecksum` P4 stored for no other
    reason. §6.4 already names admin editing frequency as the deciding factor.
  - *Rejected:* putting the merge behind an `AudioMerger` port so a marks-based
    provider could replace it later. That is optionality for a decision now made,
    and §13 does not ask for it.
- ffmpeg and ffprobe become **required runtime dependencies of `apps/worker`**.

### The provider interface

- `packages/ai` exports `TextToSpeechProvider`, its request and response types,
  and an injection token `TEXT_TO_SPEECH_PROVIDER` (a `Symbol`, following
  `EMAIL_PROVIDER`, `IMAGE_GENERATION_PROVIDER` and `LLM_PROVIDER`).
- `synthesize(request)` takes `{ text, voiceIdentifier, languageCode }` and
  resolves to `{ bytes, contentType, voiceIdentifier, providerName, modelName,
  characterCount }`. The provider never touches the database, the queue or object
  storage, and knows nothing about blocks, segments, offsets or checksums. It
  turns one string into one audio file and reports what it cost.
- `characterCount` is on the response for the reason P4 put token counts there:
  §8 gives `lesson_audios` a `total_character_count` column, NFR-05 requires TTS
  character counts per lesson, and nothing else can supply the number the
  provider actually billed. The run sums it across segments.
  - **The OpenAI speech endpoint returns raw audio bytes and no usage metadata**,
    so its adapter computes `characterCount` from the input length. That is a
    property of the response body, not an estimate, and the adapter says so.
- The provider declares `maxInputCharacters`. **OpenAI's speech endpoint refuses
  input over 4096 characters**, and a segment longer than the provider's limit
  fails the whole run at precondition time rather than on attempt 3 — see
  *Preconditions*.
- `contentType` is `audio/mpeg`. The run requests MP3 from every provider; see
  *The merge and the offsets* for why the container is decided here and not left
  to the adapter.
- Two implementations ship.
  - `OpenAiTextToSpeechProvider` calls the speech endpoint. `packages/ai` already
    depends on the OpenAI SDK for P3's images, so this adds no dependency. The
    model identifier defaults to `gpt-4o-mini-tts` and is overridable by
    `OPENAI_TTS_MODEL`; **the exact identifier, the voice identifiers, the input
    limit and the pricing are verified against current documentation at
    implementation time and recorded in the adapter**, the same discipline §6.3
    demands and P3's and P4's adapters follow.
  - `FakeTextToSpeechProvider` emits **real, ffprobe-measurable MP3 bytes** — not
    a stub buffer. It derives a duration and a tone frequency deterministically
    from the segment text and shells out to `ffmpeg -f lavfi -i sine=...` to
    produce them.
    - This is what makes the end-to-end timing assertion possible at all: the
      suite knows exactly how long every segment should be and which frequency
      should be audible inside its stored window, and the merge path runs on
      genuine encoder output rather than on bytes that decode to nothing.
    - It makes ffmpeg a dependency of the fake as well as of the worker, which is
      acceptable because ffmpeg is already a hard dependency of this phase and
      because **`packages/ai` is server-only** — `apps/admin-web` depends on
      `shared`, `content` and `database`, never on `ai`, so no isomorphism
      constraint applies and `node:child_process` is available.
    - *Rejected:* hand-assembling constant-bitrate MPEG frames to avoid the
      ffmpeg dependency. It yields silence, and silence cannot tell you whether
      `start_millisecond` points at the right segment or merely at the right
      arithmetic.
    - Determinism is stated precisely: the same text always yields the same
      duration and the same frequency, and byte-identical output **for a given
      ffmpeg build**. Assertions are on duration and frequency, never on bytes.
      This is why CI pins ffmpeg explicitly rather than inheriting it.
- Selection is by environment, in `packages/ai/src/provider-factory.ts` beside
  the other two factories: `createTextToSpeechProvider(env)` with
  `TTS_PROVIDER=openai` selecting the real adapter, anything else — including
  unset — the fake. `openai` with no `OPENAI_API_KEY` throws at construction
  rather than downgrading, for the reason P3 and P4 both record: a silent
  downgrade is a deployment quietly serving fake output that nobody notices until
  a learner does. Here it would be a lesson that plays a sine tone.

### Voice configuration (FR-AUDIO-03)

- **A new migration adds `voice_provider_name` and `voice_identifier` to
  `courses`, both nullable.** FR-AUDIO-03 states that a course has one configured
  voice and §8 provides no column for it; the requirement cannot be satisfied
  without one. `lesson_audios` keeps its own copies, which is what makes a voice
  change detectable.
- Null means "use the install default", supplied by `TTS_DEFAULT_VOICE` and the
  selected provider. A fresh course therefore narrates without anybody
  configuring anything, and an install with one voice never touches the column.
- `PATCH /admin/courses/:courseId/voice` sets it, declaring
  `@RequirePermission('createCategoriesAndCourses')` — owner-only, matching
  `PATCH :courseId/pricing-type`, which is the closest existing course-level
  setting. §3 has no "configure voice" action and this spec does not invent one;
  it reuses the action §3 already assigns to course configuration.
- The voice is resolved **at enqueue time** and travels in the job payload, so a
  retry cannot synthesize half a lesson in one voice and half in another.
- A resolved voice that the provider does not recognise is refused at enqueue
  with `422 AUDIO_VOICE_NOT_CONFIGURED`, not discovered on the first paid call.
- *Rejected:* environment-only configuration (true today, wrong the first time
  two courses want different voices) and deriving the voice from
  `courses.language_code` (a second Vietnamese course could never differ, and
  changing any voice would mean editing source).

### One audio row per lesson

- `lesson_audios` is `UNIQUE (lesson_id, voice_identifier)`, which permits one
  row per voice. **P5 keeps exactly one row per lesson and replaces the voice in
  place.** A successful run upserts by `lesson_id`, keeping the row id, and
  overwrites `voice_identifier` and `voice_provider_name` when the course's voice
  has changed. The unique constraint is satisfied trivially and never fires.
- Every reader — this phase's tab, P6's checklist, P7's player — finds at most one
  row and needs no tie-break rule. §13 puts multiple narration voices per course
  out of scope, so the accumulating interpretation buys nothing v1 wants and
  costs every future reader a rule it can silently get wrong.
- Objects belonging to a superseded voice are orphaned rather than deleted, the
  same rule P3 set for unselected image candidates; P10 reclaims them.

### Preconditions

A synthesis run is refused, before any money is spent, when:

- the lesson has no `narration_scripts` row — `404 AUDIO_SCRIPT_NOT_FOUND`;
- the script has no `reviewed_at` — `422 AUDIO_SCRIPT_NOT_APPROVED`. §5.5 makes
  admin approval "the enforcement point" for FR-SCRIPT-02, and this is where it
  is enforced;
- the script's **computed** status is `stale`, `failed`, `generating` or
  `pending` — `422 AUDIO_SCRIPT_STALE`. Synthesizing a stale script buys audio
  FR-PUB-01 will refuse to publish;
- a run is already in flight for this lesson — `409 AUDIO_GENERATION_IN_FLIGHT`,
  carrying the running `jobId` so the tab can attach to it, as P4's 409 does;
- the script has more than `AUDIO_RUN_MAX_SEGMENTS` segments —
  `422 AUDIO_TOO_MANY_SEGMENTS`;
- any segment's text exceeds the provider's `maxInputCharacters` —
  `422 AUDIO_SEGMENT_TOO_LONG`, naming the offending `blockId`.

**An approved-then-edited script synthesizes.** P4 ruled that a hand edit keeps
approval, because the editor holds the same role as the approver and the edit is
itself an act of review, and recorded the consequence as a known accepted gap.
P5 does not re-litigate a shipped decision, and the gap stays exactly where P4
recorded it: an admin can add a sentence of new knowledge after approval and it
will be voiced.

### The in-flight lock and the NOT NULL columns

- The lock is `audio_status = 'generating'` on the lesson's `lesson_audios` row,
  mirroring P4's `script_status` lock, so the 409 above is answered from the
  database rather than from queue state.
- A first run therefore has to create a row before it has anything to put in it,
  and §8 makes `merged_audio_file_url` and `source_script_checksum` `NOT NULL`.
  Both are written as `''` — the same empty-string-over-migration choice P3 made
  for `caption_text` and P4 made for `script_checksum`. `''` only ever coexists
  with `pending`, `generating` or `failed`, never with `ready`, and no reader may
  presign an empty key.
- `voice_provider_name` and `voice_identifier` are also `NOT NULL` and are
  written for real at enqueue, from the voice resolved there. They are the one
  pair of columns an in-flight row can honestly fill.
- A regeneration sets `generating` on the existing row and changes nothing else,
  which is what makes the all-or-nothing guarantee below possible: the previous
  merged URL keeps serving throughout the run.

### Character counting (§6.4, NFR-05)

- `total_character_count` is the character count of **the whole script the row
  represents**, not of the segments this particular run paid for. A run sums the
  provider's reported `characterCount` for segments it synthesized and the stored
  text length for segments it reused.
- Stated explicitly because the two readings differ after any regeneration, and
  because the column is singular and mutable: one column on a row that is
  upserted every run cannot track per-run billing, and pretending otherwise
  would make the number quietly wrong rather than merely coarse. Per-run cost
  attribution needs `generation_jobs`, and presenting it is P10's.

### Segment reuse across runs (FR-AUDIO-01)

- **The same migration adds `source_segment_checksum TEXT NOT NULL` to
  `audio_segments`.** FR-AUDIO-01 requires regeneration to re-synthesize only
  stale segments, and the table as specified holds nothing that links a stored
  audio file to the narration text it voices — only a `block_reference_id`, an
  order, two offsets and a URL. Without the column the requirement is
  unimplementable.
  - `NOT NULL` with no default is safe because the table has **never been written
    by any code in any environment**; there are no rows to backfill. Stated
    explicitly so the choice is not mistaken for an oversight.
  - The column holds P4's `segmentChecksum` — SHA-256 of the normalized
    narration text — which the comment on it in P4's
    `narration.ts` already calls "THIS IS THE FIELD P5 DIFFS".
- A run reuses a previous segment when its `source_segment_checksum` equals the
  current script segment's `segmentChecksum` **and** the row's voice matches the
  resolved voice. Reuse copies the previous row's `segment_audio_file_url` and
  checksum into the new row; **the object is neither re-uploaded nor
  re-downloaded for reuse purposes** — only read once at merge time, like any
  other segment.
- A changed, added or previously-absent segment is synthesized. A previous
  segment whose block is gone from the script is dropped.
- *Rejected:* content-addressing the object key by `segmentChecksum` so reuse is
  a storage `HEAD`. It works, but it makes object storage the index of record for
  a correctness decision, and leaves the `audio_segments` row unable to explain
  why it skipped a paid call.
- *Rejected:* re-synthesizing every segment on every run. It contradicts
  FR-AUDIO-01 directly and is the expensive answer to the thing admins do most.

### The merge and the offsets

This is the load-bearing part of the phase.

- Segments are requested from the provider as **MP3**, and the merge
  **decodes every segment to PCM, concatenates the PCM, and encodes the result
  once**. It is not a stream copy.
  - MP3 carries encoder delay and end padding in every file. A `concat` demuxer
    with `-c copy` preserves all of it, so each boundary gains tens of
    milliseconds and the error compounds: across forty segments the highlight
    lags the voice by seconds. Re-encoding is the fix, and it costs CPU per merge
    and nothing else.
  - *Rejected:* Opus in WebM, which is genuinely gapless and would make a stream
    copy exact — but adds a format to verify against the provider and carries the
    usual Safari caveat into P7's player. *Rejected:* AAC in M4A, which solves the
    same problem but makes the spec pin an assumption about the ffmpeg build's
    AAC encoder.
- **Offsets are computed from exact decoded sample counts, not from container
  durations.** Each segment is decoded to a uniform PCM format (one sample rate,
  one channel count, fixed for the whole run); its sample count is an exact
  integer; `start_millisecond` is the cumulative sample count before it and
  `end_millisecond` the cumulative count after, each converted at the run's
  sample rate. The final encode applies one constant encoder delay to the whole
  file rather than one per segment, which is what players already handle.
- Segments are **contiguous by construction**: the first starts at 0, each
  segment's `end_millisecond` equals the next one's `start_millisecond`, and the
  last one's equals the merged file's duration. There are no gaps and no
  overlaps, and the verification asserts all three.
- `total_duration_seconds` is derived from the last `end_millisecond`, and
  ffprobe of the actual merged file must agree with it — that agreement is an
  assertion, not an assumption.
- `segment_order` is written from P4's stored `segmentOrder`, which P4 persisted
  rather than deriving from array position precisely so this phase would not
  depend on JSON array ordering surviving Prisma's `Json` type.
- ffmpeg work lives in `apps/worker/src/audio/ffmpeg.ts` — §11 names ffmpeg as
  worker infrastructure and the worker is its only consumer. It exports
  `assertFfmpegAvailable()`, `probeDurationMs(path)` and `mergeSegments(...)`,
  and is the only place in `apps/worker` that spawns a process.

### ffmpeg availability

- `.github/workflows/ci.yml` gains an **explicit ffmpeg install step**. Relying on
  whatever `ubuntu-latest` happens to ship means a runner image change breaks the
  audio suite with no local reproduction, and nothing records which ffmpeg the
  offsets were validated against.
- `apps/worker` **probes for both binaries at startup** via
  `assertFfmpegAvailable()` and refuses to start with a named error when either is
  missing. A missing binary then fails loudly at boot instead of as an opaque
  `ENOENT` inside attempt 3 of a job that has already been paid for.
  - The cost is accepted deliberately: a worker with no ffmpeg will not process
    image, import or narration jobs either. A deployment missing a dependency
    §11 names is broken, and saying so at boot is the honest report.

### Failure is all-or-nothing

- Synthesized bytes are held for the whole run; **nothing is written to
  `lesson_audios`, `audio_segments` or object storage until every segment has
  been synthesized or reused and the merge has succeeded.** The database write is
  one transaction.
- A failed run sets `audio_status = 'failed'` with a reason and leaves
  `merged_audio_file_url`, `source_script_checksum`, `total_duration_seconds`,
  `total_character_count`, `voice_identifier`, `voice_provider_name` and every
  `audio_segments` row **unchanged**. An admin's working audio is never replaced
  by a partial one, and a `failed` row still serves the last good file.
- **Consequence, stated so it is not discovered later:** after a failed
  regeneration the row holds good audio and a `failed` status. The status
  describes the last *run*; everything else describes the last *successful* run.
  This is exactly P4's rule and P4's wording, deliberately — one mental model for
  both generators. FR-PUB-01 blocks publishing on a `failed` audio, so the way out
  is a run that succeeds.
- The spend on the segments that did succeed is lost. That is the price of the
  guarantee, and it is the one place this phase is more expensive than the
  alternative.
  - *Rejected:* persisting each segment as it lands so a retry resumes. It saves
    real money, but it admits a `failed` row holding a partial, unmergeable set
    that no reader may serve, and every reader would have to know that.
  - *Rejected:* uploading objects eagerly under content-addressed keys while
    keeping the database write atomic. It gets both properties and costs a key
    scheme whose correctness argument lives in object storage — the same reason
    content-addressing was rejected for reuse.
- Bounded concurrency per NFR-03: `AUDIO_SEGMENT_CONCURRENCY` limits in-flight
  provider calls within a run, and BullMQ's shared attempt and backoff constants
  cap the run itself at 3 attempts.

### Staleness (§6.5) — the third link

- **`audio_status` is never stored as `stale`.** The stored value is `pending`,
  `generating`, `ready` or `failed`; `stale` is produced on read, per §6.5's
  "computed on read, never written by a background job". This mirrors P4's
  reading of §6.5 over §8.1 exactly.
- The reported status is `stale` when the stored value is `ready` **and** either
  `source_script_checksum` differs from the script's current `script_checksum`,
  **or** the row's `voice_identifier` differs from the course's resolved voice.
  Otherwise it is the stored value; `failed` outranks `stale`.
  - The voice clause is what FR-AUDIO-03's "stored with each audio row so a voice
    change is detectable" is *for*. Detection with no consequence would be a
    column nobody reads.
- `GET /admin/lessons/:lessonId/staleness` **gains its `audio` key**, which P4
  deliberately omitted rather than shipping as a permanent `null`. The key is
  `null` when the lesson has no `lesson_audios` row — absence and a pending row
  are different facts — and otherwise reports the computed status, both
  checksums, the stored and resolved voices, and two disjoint sets:
  - `staleSegmentBlockIds` — a script segment whose `segmentChecksum` differs
    from the audio row's `source_segment_checksum`, or that has no audio row at
    all. These are what a run would pay for.
  - `orphanedSegmentBlockIds` — an audio segment whose script segment is gone.
- P4's `script` key and its three block-level sets are unchanged. P6 reads both
  keys for FR-PUB-01; P5 blocks nothing on either.

### The queue, extracted

`packages/shared/src/queues.ts` carries a note predicting a shared queue shape at
the third queue, which was then deferred at P3 and again at P4 with the words
*"P5's audio queue is the fourth and the closest sibling of image; that is the
moment to extract, not this one."* **P5 honours that.**

- A `QueueDefinition` record per queue holds the parts that must not drift: queue
  name, job names, id prefix, and the NFR-03 attempt and backoff defaults. All
  four queues are declared through it and a registry exposes them by name.
- `apps/api/src/jobs/job-status.service.ts` resolves an id **from the registry**
  instead of its current hardcoded tuple list. **P1's unprefixed import ids keep
  working byte for byte** — the import queue's prefix is the empty string and its
  resolution stays last, because screens P1 shipped still hold those ids. A test
  asserts an unprefixed id still resolves after the refactor.
- Producers keep their own files. Import carries two job names and a Redis-cached
  result, image composes a prompt at enqueue, narration holds a database-level
  lock, audio resolves a voice — they genuinely differ, and a factory over the
  differences would be longer than the four siblings it replaced. What is
  extracted is the part that was always the same.
- The note in `queues.ts` is **replaced** with what actually happened, not
  amended again. A file that forecasts a decision and then records making it is
  telling the truth about itself; one that forecasts the same decision three
  times is not.
- This is the one part of P5 that touches working P1 and P3 code. It is called
  out here so a planner sequences it as its own slice, with the existing job
  suites green before any audio work lands on top of it.

### Job progress and authorization

- `apps/api/src/jobs/job-permissions.ts` gains `generate_audio: 'generateAudio'`
  — the action already exists in `packages/shared/src/roles.ts` and §3 already
  assigns it to `admin_owner` and `admin` — and `generate_audio` joins
  `lessonTargetedJobTypes` so R-02 applies to watching it. That map is partial
  and deny-by-default; omitting the row makes the tab's own stream return 403
  rather than leaking anything.
- Job ids are qualified `audio:<n>`, resolved through the new registry.
- Progress reports `{ done, total }` over the existing BullMQ mechanism and P1's
  SSE endpoints. Reused segments count as done immediately, so a regeneration of
  two segments in a forty-segment lesson shows 38/40 at once rather than
  pretending to work. A terminal event carries the segment count and the merged
  duration. The merge is reported as its own final step.

### The audio tab

- The lesson editor grows a third tab beside content and narration. Like
  narration it is full-width: the rows are read top to bottom across the lesson.
- Each row shows the block's narration text read-only with its figure or table
  number, and a freshness badge from the two sets above (`fresh`, `stale`,
  `missing`). Orphaned audio segments are listed after the blocks, marked as
  belonging to removed narration.
- A plain `<audio controls>` element plays the merged file through a **presigned
  URL computed in `audio.service.ts`**, the way `images.service.ts` presigns —
  never the stored key, which is not a URL. NFR-02 caps signed media at 15
  minutes and `PRESIGN_EXPIRY_SECONDS` is already 10.
  - No highlight sync and no seek-to-block. Those are FR-AUDIO-02 and belong to
    P7's player; this element exists so the phase's output can be heard.
- Generate is disabled with the server's reason when the script is not approved
  or is stale, reusing the `canEdit` / `readOnlyReason` fields
  `lesson-content.service.ts` already computes from the facts R-01 and R-02 use.
  The writes refuse independently of anything rendered.
- Regenerating over existing audio shows a confirmation naming how many segments
  will be re-synthesized and how many are reused — the number is the admin's only
  view of what a run costs.

### Role enforcement

- Audio endpoints declare `@RequirePermission('generateAudio')`; the voice
  endpoint declares `@RequirePermission('createCategoriesAndCourses')`. No change
  to `packages/shared/src/roles.ts` is needed.
- Guards are split by method as `images.controller.ts`,
  `lesson-content.controller.ts` and `narration.controller.ts` do: the controller
  declares `SessionGuard` and `RolesGuard`, and each write adds
  `PublishedLockGuard` and `AssignmentGuard` itself — so an admin can still read
  the audio state of a lesson they may not write, and the tab explains itself
  instead of showing an error.

## Non-goals

- **Highlight sync and seek-to-block (FR-AUDIO-02).** P5 writes the offsets; P7's
  learner player consumes them. Also excluded: persisting
  `lesson_progress.last_audio_position_ms`, and the playback-speed preference
  that persists across lessons. Both are learner-side.
- **The publish checklist gate (FR-PUB-01).** P5 exposes audio staleness and
  blocks nothing on it. "No narration script or audio is stale or failed" is
  built in P6, reading this phase's endpoint.
- **Any learner-facing exposure.** No audio on any public endpoint, nothing added
  to `published_course_structures`, no `apps/learner-web` change, and **no
  entitlement-gated `GET /media/:mediaId/signed-url`** — that endpoint and
  E-01's regression test covering both it and `GET /lessons/:lessonId` are P8.
- **Per-segment regeneration as a UI action.** No "re-synthesize just this block"
  button. A run covers the lesson and reuses unchanged segments automatically, so
  the saving happens without a second code path — mirroring P4's rejection of the
  same feature for scripts.
- **Multiple voices per lesson or per course.** §13 puts it out of scope; the
  `UNIQUE (lesson_id, voice_identifier)` constraint is satisfied by there only
  ever being one row.
- **Editing narration text from the audio tab.** That is P4's tab, and a second
  writer against `script_checksum` would need its own conflict handling.
- **Reclaiming orphaned objects.** Superseded merged files and segments of a
  replaced voice are left in the bucket for P10, as P3 left unselected candidates.
- **A Dockerfile or any deployment configuration.** ffmpeg is pinned in CI and
  probed at worker boot; packaging the worker image §11 describes is still a
  non-goal, as it has been since P0.
- **Cost dashboards.** `total_character_count` is recorded per NFR-05; presenting
  it is P10.

## Constraints

- **Node 22.** Under Node 20 vitest dies with a rolldown native binding error
  that looks nothing like a version problem.
- **ffmpeg and ffprobe are required**, installed explicitly in CI and probed at
  worker startup. Nothing in the phase may assume a preinstalled binary. Because
  the fake provider generates real tones, this extends to `packages/ai`'s own
  suite: that workspace's tests stop being runnable on a machine without ffmpeg,
  which is a deliberate trade for assertions that mean something.
- **`packages/content` is isomorphic and P5 adds nothing to it.** The checksums
  this phase compares are P4's, already in `narration.ts`; no audio code belongs
  in a package the browser reaches.
- **`packages/ai` is server-only** — `apps/admin-web` depends on `shared`,
  `content` and `database`, never on `ai` — which is what permits the fake
  provider to spawn ffmpeg. If that dependency direction ever changes, the fake
  breaks the browser build, and `test/isomorphic.spec.ts` does not cover
  `packages/ai`.
- **A new migration, never a regenerated one.** `20260911180121_init/migration.sql`
  carries six partial unique indexes, one partial index and two CHECK constraints
  hand-appended below the generated section; `prisma migrate dev` would discard
  them and `prisma migrate diff` reports no difference either way. Generate the
  new migration with `--create-only`, confirm the emitted SQL contains only the
  three `ALTER TABLE ... ADD COLUMN` statements this spec names and touches
  nothing else, then apply. `packages/database/test/constraints.spec.ts` must
  stay green.
- **No Prisma `enum`s.** `audio_status` is a `String` validated by an
  `audioStatusSchema` in `packages/shared/src/enums.ts`, alongside the existing
  `scriptStatusSchema` — §8.1 gives both columns the same value set.
- **`emitDecoratorMetadata` stays `false`.** Every new Nest injection is an
  explicit `@Inject(Token)`.
- Request bodies are validated with zod `strictObject` in the controller; every
  error carries an `errorCode` from `packages/shared/src/errors.ts`.
- Tests live in a per-workspace `test/` directory. `*.e2e-spec.ts` for suites that
  boot an app — both globs are listed explicitly in the api vitest config, and a
  file that never runs looks exactly like a passing one.
- **NFR-03** supplies the retry policy through the shared constants; the queue
  sets them as defaults so no endpoint can enqueue work that retries forever.
- Provider concurrency is bounded and low. Every segment is a paid call, and a
  lesson is many of them.
- Audio fixtures are generated at test time, never committed. A binary blob in
  git that the suite asserts against is a fixture nobody can review.

## Affected files and interfaces

**New**

| Path | Contents |
|---|---|
| `packages/ai/src/text-to-speech.provider.ts` | `TextToSpeechProvider`, request/response types, `TEXT_TO_SPEECH_PROVIDER` token, `maxInputCharacters` |
| `packages/ai/src/openai-tts.provider.ts` | Speech endpoint adapter, model and voices pinned and verified at implementation time |
| `packages/ai/src/fake-tts.provider.ts` | Deterministic fake emitting real MP3 tones via `ffmpeg -f lavfi -i sine` |
| `packages/storage/src/keys.ts` *(additions)* | `audioMediaTypes`, `mintAudioSegmentKey`, `mintMergedAudioKey` |
| `apps/worker/src/audio/ffmpeg.ts` | `assertFfmpegAvailable`, `probeDurationMs`, `mergeSegments` — the only process spawn in the worker |
| `apps/worker/src/jobs/audio.processor.ts` | Reuse pass, bounded-concurrency synthesis, merge, offset computation, atomic write |
| `apps/worker/src/jobs/audio.worker.ts` | BullMQ wiring |
| `apps/worker/src/jobs/audio-worker.service.ts` | Lifecycle |
| `apps/api/src/jobs/audio.queue.ts` | Producer, `audio:` id prefix, voice resolution at enqueue |
| `apps/api/src/content/audio.controller.ts` | `POST /admin/lessons/:lessonId/audio`, `GET /admin/lessons/:lessonId/audio` |
| `apps/api/src/content/audio.service.ts` | Preconditions, read model, presigned merged URL, audio staleness |
| `apps/admin-web/components/editor/audio-tab.tsx` | The third editor tab |
| `apps/admin-web/lib/audio-types.ts` | Hand-mirrored view types, as `narration-types.ts` and `image-types.ts` are |
| `packages/database/prisma/migrations/<new>/migration.sql` | Three `ADD COLUMN`s; **not** a regeneration |
| `apps/admin-web/e2e/audio.spec.ts` | Browser suite for the tab |

**Modified**

| Path | Change |
|---|---|
| `packages/ai/src/provider-factory.ts` | `createTextToSpeechProvider(env)` beside the other two |
| `packages/ai/src/index.ts` | Re-export the new modules |
| `packages/database/prisma/schema.prisma` | `Course.voiceProviderName`, `Course.voiceIdentifier`, `AudioSegment.sourceSegmentChecksum` |
| `packages/shared/src/enums.ts` | `audioStatusSchema` |
| `packages/shared/src/queues.ts` | **The extraction**: `QueueDefinition`, the four-queue registry, `AUDIO_QUEUE_NAME`, `GenerateAudioJobData`, `AUDIO_SEGMENT_CONCURRENCY`, `AUDIO_RUN_MAX_SEGMENTS`; the deferral note replaced with what happened |
| `packages/shared/src/errors.ts` | `AUDIO_SCRIPT_NOT_FOUND`, `AUDIO_SCRIPT_NOT_APPROVED`, `AUDIO_SCRIPT_STALE`, `AUDIO_GENERATION_IN_FLIGHT`, `AUDIO_TOO_MANY_SEGMENTS`, `AUDIO_SEGMENT_TOO_LONG`, `AUDIO_VOICE_NOT_CONFIGURED` |
| `apps/api/src/jobs/job-status.service.ts` | Resolve prefixes from the registry; unprefixed import ids unchanged |
| `apps/api/src/jobs/job-permissions.ts` | `generate_audio` row plus its lesson-targeted entry |
| `apps/api/src/jobs/import.queue.ts`, `image.queue.ts`, `narration.queue.ts` | Construct from `QueueDefinition`; behaviour unchanged |
| `apps/api/src/content/narration.service.ts` | `StalenessView` gains the `audio` key; the P4 note explaining its absence is removed |
| `apps/api/src/content/courses.controller.ts` | `PATCH :courseId/voice`, owner-only |
| `apps/api/src/app.module.ts` | Register controller, service, queue, `TEXT_TO_SPEECH_PROVIDER` binding |
| `apps/worker/src/worker.module.ts` | Register the audio worker and the provider binding |
| `apps/worker/src/main.ts` | `assertFfmpegAvailable()` before the workers start |
| `apps/admin-web/components/editor/lesson-editor.tsx` | Third tab |
| `.env.example` | `TTS_PROVIDER`, `OPENAI_TTS_MODEL`, `TTS_DEFAULT_VOICE` |
| `.github/workflows/ci.yml` | Explicit ffmpeg install; `TTS_PROVIDER: fake` |
| `CLAUDE.md` | ffmpeg as a prerequisite; the money-costing tests now number three |
| `.claude/harness/architecture.md` | `TextToSpeechProvider` built; the queue abstraction extracted; ffmpeg a runtime dependency |

## End-to-end verification

From a clean checkout, with Docker running and ffmpeg installed:

```
nvm use
ffmpeg -version && ffprobe -version
docker compose up -d --wait
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm verify
pnpm --filter @knowledge-explorer/admin-web test:e2e
```

**Expected:** exit code `0` from both commands, every suite green, and no
`OPENAI_API_KEY` required — the fake provider is the default and the only one CI
exercises.

**1. Provider contract** (`packages/ai/test/tts-provider.spec.ts`) — no network,
no database:

- the fake returns MP3 bytes that `ffprobe` reports as MP3, with the duration the
  fake's own deterministic function predicts for that text;
- the same text twice yields the same duration and the same tone frequency;
- each response carries a non-empty `voiceIdentifier`, `providerName` and
  `modelName`, and a `characterCount` equal to the input length;
- the OpenAI adapter, given a recorded response body, produces bytes, content
  type, model, provider and character count — the parsing is tested even though
  the call is not made;
- the adapter refuses input over `maxInputCharacters` before calling;
- selection: `TTS_PROVIDER` unset yields the fake; `openai` with no key throws at
  construction rather than falling back.

**2. Timing — the assertion this phase exists for**
(`apps/worker/test/audio-merge.spec.ts`). A fixture script of at least eight
segments whose texts map to **distinct, known durations and distinct tone
frequencies**. The processor runs against the fake and real ffmpeg:

- every stored `end_millisecond − start_millisecond` equals the fake's predicted
  duration for that segment, within ±5 ms;
- boundaries are contiguous: the first `start_millisecond` is 0, each
  `end_millisecond` equals the next `start_millisecond` exactly, and no window
  overlaps;
- the last `end_millisecond` equals `ffprobe`'s duration of the actual merged
  file, within ±20 ms, and matches `total_duration_seconds`;
- **the decisive check:** for each segment, the window
  `[start + 20 ms, end − 20 ms]` is cut out of the merged file, decoded to 16-bit
  PCM, and its dominant frequency recovered by counting zero crossings. It must
  match that segment's expected tone and not its neighbours'. This is what proves
  an offset points at the right audio rather than merely at arithmetic the
  processor agreed with itself about;
- a deliberately drifting control — the same fixture merged with `-c copy`
  instead of re-encoded — **fails**, so the assertions are shown to have teeth.
  The fixture uses many short segments precisely so that per-boundary MP3 padding
  accumulates past tolerance: the control's last `end_millisecond` no longer
  matches ffprobe's duration of its merged file, and its later windows no longer
  carry their expected tone.

**3. Reuse and regeneration** (`apps/worker/test/audio.processor.spec.ts`), with a
counting fake:

- a second run over an unchanged script makes **zero** provider calls and still
  produces a merged file whose offsets satisfy every check above;
- editing one segment's narration causes exactly one provider call, and the
  untouched segments keep their `segment_audio_file_url` byte for byte;
- changing the course's voice causes **every** segment to be re-synthesized, and
  the row's `voice_identifier` is the new one;
- a provider that throws on segment 6 of 8 leaves the previous row, its segments
  and the previous merged URL completely unchanged, with `audio_status` `failed`
  and a reason;
- `total_character_count` after a regeneration that re-synthesized one segment
  equals the whole script's character count, not that one segment's — the
  distinction the character-counting decision above exists to fix.

**4. API and preconditions** (`apps/api/test/audio.e2e-spec.ts`), over real HTTP:

- `POST` against a lesson with no script is 404 `AUDIO_SCRIPT_NOT_FOUND`; with an
  unapproved script 422 `AUDIO_SCRIPT_NOT_APPROVED`; with an approved script whose
  content has since changed 422 `AUDIO_SCRIPT_STALE`;
- a second `POST` while a run is in flight is 409 `AUDIO_GENERATION_IN_FLIGHT`
  carrying the running `jobId`;
- a segment over the provider's limit is 422 `AUDIO_SEGMENT_TOO_LONG` naming the
  `blockId`, and no job is enqueued;
- a `learner` session is refused on every audio endpoint; a non-owner admin
  writing a published course is 403 (R-01) and one writing a lesson assigned
  elsewhere is 403 (R-02); reads still succeed for the latter;
- `PATCH /admin/courses/:courseId/voice` succeeds as owner and is 403 as admin;
- `GET /admin/lessons/:lessonId/staleness` reports `"audio": null` before any run,
  a `ready` audio after one, `stale` after a narration edit, and `stale` after a
  voice change with the script untouched;
- the merged URL in the audio read model is presigned and fetchable; the stored
  `merged_audio_file_url` is a key and is never returned as a URL.

**5. Queue extraction** (`apps/api/test/job-status.spec.ts`, extended):

- an **unprefixed** import job id minted the way P1 minted them still resolves;
- `image:`, `script:` and `audio:` ids each resolve to their own queue and to the
  right `job_type`;
- `generate_audio` with no row in `job-permissions.ts` would be refused — asserted
  by the existing deny-by-default fixture, not by removing the row.

**6. The tab** (`apps/admin-web/e2e/audio.spec.ts`), Playwright, with the worker
spawned by `global-setup.ts`:

- Generate is disabled with a visible reason on a lesson whose script is not
  approved;
- after approving the script, Generate enqueues, progress advances to the segment
  count, and an `<audio>` element appears whose `src` resolves to a fetchable URL
  returning `audio/mpeg` — asserted by intercepting the response, not by playing
  it;
- editing one narration segment in the narration tab flips exactly that row's
  audio badge to stale and leaves the others fresh;
- the regeneration confirmation names the correct re-synthesize and reuse counts.

**7. Live provider** (`packages/ai/test/openai-tts.live.spec.ts`) — **costs
money**, skipped unless `OPENAI_API_KEY` is set. The third such test in the
repository, run by hand when the pinned model or voice changes. It synthesizes one
short Vietnamese sentence and asserts the bytes are MP3 of non-zero duration and
that the pinned voice identifier is accepted. It is the only evidence that the
pinned model and voice exist and speak `vi` at all; the fake cannot tell you.

## Open questions

None blocking. Three items are recorded so a planner does not mistake them for
oversights.

- **§14 decision #4 is closed by this spec** in favour of §6.4's per-segment
  approach. §14 itself is part of the locked product document and is not edited
  here; the closure lives in this file.
- **An approved-then-edited script still synthesizes**, so FR-SCRIPT-02's "adds no
  facts" guarantee is only as strong as the state at approval time. This is P4's
  recorded accepted gap, inherited deliberately rather than re-decided. Named
  again because P5 is where it costs money.
- **A `generating` lock orphaned by a worker killed mid-run** leaves the lesson
  unable to start a new audio run, exactly as P4's narration lock does, and P5
  ships no recovery either. A stale-lock sweep belongs with P10's job alerting and
  should cover both locks at once; the interim answer is a manual `UPDATE`.

Of §14's remaining decisions, the payment gateway blocks P8 and the grace period
and free-preview count are configuration. None touch this phase.
