# Architecture

## Pattern

**No architecture is implemented.** No pattern can be identified from code
because the repository contains no source files [verified] (`source_files=0`).

The specification declares an intended architecture, spec §11 `[declared]`:
a **service-oriented monorepo** — four deployable applications (`admin-web`,
`learner-web`, `api`, `worker`) over five shared packages — combined with a
**ports-and-adapters (hexagonal) boundary for every external dependency**. The
spec lists five provider interfaces that all external services sit behind:
`LlmProvider`, `ImageGenerationProvider`, `TextToSpeechProvider`,
`PaymentProvider` and `EmailProvider` (§11). Domain logic (entitlement
resolution, block extraction, checksums) is declared to live in framework-free
packages — `/packages/commerce`, `/packages/content` — separate from the NestJS
and Next.js applications that consume them.

Treat all of the above as a plan to be verified against code once code exists,
not as an observed structure.

## Important Directories

| Path | Purpose | Evidence |
|---|---|---|
| `/` | Repository root; holds the sole content file `knowledge-explorer-spec.md` | [verified] directory listing |
| `/knowledge-explorer-spec.md` | Product Specification v1 — the entire project content: requirements, data model, API contracts, phases | [verified] file read in full |
| `/.claude/` | Claude Code project configuration | [verified] directory listing |
| `/.claude/settings.local.json` | Enables the `project-skills@project-skills` plugin | [verified] file contents |
| `/.claude/harness/` | This generated harness | [verified] created by this run |

No source root, test root, scripts directory, docs directory, or
generated/vendored code exists [verified]. No submodules or nested repositories
[verified].

## Module & Data Flow

Entry points: `Unknown` — no code exists [verified].

The spec declares the following content and access pipelines `[declared]`.
Section references point into `knowledge-explorer-spec.md`.

**Authoring pipeline (§1.2, §4, §6)**

1. Admin owner writes the curriculum outline **outside the app** and imports it
   as JSON (§5.2, §9.1). Import is idempotent on `(categorySlug, levelLabel)`
   and creates a skeleton only — every lesson starts at `contentStatus = empty`.
2. Admins hand-write lesson bodies in markdown; **no LLM writes subject-matter
   content** (§1.2). Saving parses markdown into an ordered block list via a
   remark AST, assigning stable `blockId`s and figure/table numbers in one place
   (§6.1, FR-EDIT-02).
3. Images: AI-generated candidates (2–4) or manual upload; exactly one candidate
   per figure block is selected, with mandatory caption and alt text (§6.2, §5.4).
4. Narration script: an LLM receives **the block list, not raw markdown**, and
   must return exactly one segment per block, same order, same `blockId`s;
   violations are rejected and retried up to twice (§6.3, FR-SCRIPT-01).
5. Audio: TTS synthesizes **one file per segment**, durations are measured,
   files are merged with ffmpeg, and per-block offsets are stored for playback
   highlight sync (§6.4, FR-AUDIO-01/02).

**Staleness chain (§6.5)** — computed on read, never written by a job:

```
lesson_contents.draft_content_checksum
        └─→ narration_scripts.source_content_checksum
                    └─→ lesson_audios.source_script_checksum
```

**Draft / published split (§4.3)** — admins read and write the normalized tables
(`chapters`, `lessons`, `lesson_contents.draft_content_markdown`); learners read
only the published track (`published_course_structures` plus
`lesson_contents.published_content_markdown`). Publishing copies draft to
published and rebuilds the table-of-contents snapshot. `lessonId` never changes,
so `lesson_progress` survives every publish. Deletes are soft (`deleted_at`).

**Request-layer boundaries (§3, §7.3, §9)**

- Rule R-01: every write under `/api/admin/*` returns `403` when the target
  course is `published` and the caller is not `admin_owner` — enforced
  server-side, not by hiding UI.
- Requirement E-01: `hasAccessToLesson` must gate **both** `GET /lessons/:lessonId`
  and `GET /media/:mediaId/signed-url`; missing either leaks paid audio.
- Requirement E-02: expiry is never materialized into a status column; it is
  always computed from `expiresAt` plus `gracePeriodDays`.
- The public API contains **no endpoint that calls an LLM, image generator or
  TTS provider** (§9.4), deliberately removing any path for anonymous traffic to
  spend money.
- Every AI and TTS call runs as a background job with bounded concurrency and at
  most 3 attempts; no HTTP request waits on an AI provider, and progress is
  reported over server-sent events (NFR-03, NFR-04, §9.3
  `GET /courses/:courseId/stream`).

## Notes

