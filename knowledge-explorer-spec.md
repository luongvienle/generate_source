# Knowledge Explorer — Product Specification v1

Status: decisions locked except §14.
Companion document: `knowledge-explorer-design.md` (Vietnamese, same decisions, more rationale).

---

## 1. Overview

### 1.1 Summary

A course platform with three parties:

- **Admin owner** writes the curriculum outline outside the app (using a separate AI account), imports it, manages admins, sets pricing, and publishes.
- **Admins** author lesson content by hand inside the app, then generate illustrations, narration script and audio.
- **Learners** browse a catalog, buy time-limited access, and read or listen to lessons while progress is tracked.

### 1.2 What is and is not AI-generated

This distinction drives the whole architecture.

| Artifact | Source |
|---|---|
| Roadmap / learning plan (tier-1 document) | Written by admin owner **outside the app**, imported as JSON |
| Chapter and lesson list (tier-2 document) | Same as above |
| Lesson body: text and tables | **Written by admins by hand. No LLM.** |
| Illustration images | AI image generation; admin selects and writes caption and alt text |
| Narration script | LLM transformation of the lesson body. **Adds no new knowledge.** |
| Audio | Text-to-speech from the admin-approved narration script |

The app never generates subject-matter content. Admins own correctness.

### 1.3 Goals

- Let admins publish high-quality lessons quickly; authoring throughput is the main constraint.
- Make listening a first-class experience, not a byproduct — narration must reference figures and tables naturally.
- Keep published content stable for learners while admins keep editing.
- Sell access flexibly: single course or whole-category bundle, time-limited.

### 1.4 Non-goals for v1

See §13.

---

## 2. Glossary

| Term | Meaning |
|---|---|
| **Category** | Top-level subject area. Example: "Japanese". |
| **Course** | One level inside a category. Example: "N5". The unit that is published, enrolled in, and progress-tracked. |
| **Chapter** | Ordered group of lessons inside a course. |
| **Lesson** | Smallest learning unit. Has body content, images, tables, narration script, audio. |
| **Block** | One parsed element of a lesson body: paragraph, figure, table, heading, list, code. Has a stable `blockId`. |
| **Figure** | An image block. Numbered `Figure 1`, `Figure 2`, … within a lesson. |
| **Narration script** | Spoken-language rewrite of the lesson body, one segment per block. |
| **Segment** | One narration unit, mapped 1:1 to a `blockId`. Also the unit of audio generation. |
| **Product** | A sellable item: one course, or one whole category. |
| **Access grant** | A learner's right to read a course, scoped to a course or a category, with an expiry. |
| **Entitlement** | The computed answer to "can this learner read this lesson right now?". |

---

## 3. Roles and permissions

Three roles: `admin_owner`, `admin`, `learner`.

| Action | admin_owner | admin | learner |
|---|---|---|---|
| Create, edit, disable admin accounts | Yes | No | No |
| Create categories and courses | Yes | No | No |
| Import curriculum outline | Yes | No | No |
| Create and edit chapters and lessons | Yes | Yes | No |
| Write lesson draft content | Yes | Yes | No |
| Generate and select images | Yes | Yes | No |
| Generate and edit narration script | Yes | Yes | No |
| Generate audio | Yes | Yes | No |
| Submit course for review | Yes | Yes | No |
| **Publish or unpublish a course** | Yes | **No** | No |
| **Edit a course that is published** | Yes | **No** | No |
| Create products, set prices | Yes | No | No |
| Grant or revoke access manually | Yes | No | No |
| Review topic requests | Yes | No | No |
| Submit and upvote topic requests | No | No | Yes |
| Buy access, read, listen, track progress | No | No | Yes |

**Rule R-01.** Every write endpoint under `/api/admin/*` returns `403` when the target course has `publicationStatus = published` and the caller is not `admin_owner`. This is enforced server-side, not by hiding buttons.

**Rule R-02.** An admin may only edit chapters and lessons in courses where they are assigned, or where no assignment exists. Admin owner has no such restriction.

---

## 4. Content model

### 4.1 Hierarchy

```
Category                  e.g. "Japanese"
└── Course (one level)    e.g. "N5"   ← published, sold, enrolled, progress-tracked
    └── Chapter           e.g. "Hiragana"
        └── Lesson        e.g. "The A-row"
            ├── Body content (markdown, admin-written)
            ├── Images (AI-generated, admin-selected)
            ├── Tables (inside markdown)
            ├── Narration script (LLM-generated, admin-approved)
            └── Audio (TTS, per segment, merged)
```

A course is named `Course` in code even though the product calls it a level. It is the unit that is published, sold, enrolled in and progress-tracked, so a fifth table would add nothing.

### 4.2 Lifecycle states

Two independent state machines.

**`Course.publicationStatus`** — editorial, driven by people:

```
draft → in_review → publishing → published → unpublished → archived
```

- `draft` — outline imported, content incomplete.
- `in_review` — admin submitted; owner is reviewing.
- `publishing` — publish job running.
- `published` — visible in catalog; only owner may edit.
- `unpublished` — removed from catalog; existing grants and progress are preserved.
- `archived` — terminal; hidden from admin lists.

**`Lesson.contentStatus`** — production, driven by admins:

```
empty → drafting → ready → published
```

**`NarrationScript.scriptStatus` and `LessonAudio.audioStatus`:**

```
pending → generating → ready → stale → failed
```

`stale` is computed from checksums (§6.5), never set by a background job.

### 4.3 Draft and published tracks

Learners must never see half-edited content, and their progress must never break.

- Admins read and write the **normalized tables**: `chapters`, `lessons`, `lesson_contents.draft_content_markdown`.
- Learners read only the **published track**: `published_course_structures` (table of contents, one row per course) and `lesson_contents.published_content_markdown`.
- Publishing copies draft to published for every lesson and rebuilds the structure snapshot.
- `lessonId` never changes, so `lesson_progress` survives every publish.
- Deleted lessons use `deleted_at` (soft delete) and stay in the last published snapshot until the next publish.

Course structure is stored separately from lesson bodies so the snapshot stays small (a few KB) regardless of lesson count.

---

## 5. Functional requirements

Format: requirement, then acceptance criteria.

### 5.1 Accounts and roles

**FR-AUTH-01 — Admin owner manages admin accounts**
Owner can create, rename, disable and re-enable admin accounts.
- Creating an admin sends an invitation email with a single-use sign-in link.
- Disabling an admin immediately blocks all `/api/admin/*` calls for that user.
- An admin account cannot be hard-deleted while it is referenced as `last_edited_by_user_id`; it is disabled instead.

**FR-AUTH-02 — Role enforcement**
Every endpoint declares its required role.
- Requests without the required role return `403` with a machine-readable `errorCode`.
- Role is read from the session on every request, never from client input.

### 5.2 Curriculum import

**FR-IMP-01 — Import outline as JSON**
Owner imports a category, a course, its chapters and its lesson list in one JSON payload (§6.1 of the design doc; schema in §9.1 here).
- Payload is validated against a strict schema. On failure the response lists every error with its JSON path and nothing is written.
- Import creates the skeleton only: every lesson is created with `contentStatus = empty`.
- Import is idempotent on `(categorySlug, levelLabel)`: re-importing updates titles and ordering and does not duplicate rows.
- Re-import never deletes a lesson that already has draft content; it reports those lessons as conflicts instead.

**FR-IMP-02 — Dry run before writing**
- `POST /courses/import/dry-run` returns a preview: counts of chapters and lessons to create, update and conflict, with no database writes.
- The UI requires a dry run to succeed before enabling the commit action.

**FR-IMP-03 — Downloadable prompt template**
The app ships a prompt template the owner pastes into their external AI account so the produced JSON matches the import schema on the first try.
- Template is versioned alongside the schema and downloadable from the owner portal.

### 5.3 Lesson authoring

**FR-EDIT-01 — Markdown editor**
Admins write lesson bodies in markdown with live preview.
- Supported: headings, paragraphs, lists, tables, code blocks, image placeholders, bold, italic, links.
- Preview renders exactly what the learner will see, including figure and table numbering.

**FR-EDIT-02 — Block parsing and stable numbering**
Saving a draft parses the markdown into an ordered block list.
- Each block gets a `blockId` that is stable across edits as long as the block is not deleted.
- Figures are numbered sequentially from 1 within the lesson; tables are numbered separately from 1.
- Inserting a figure above an existing one renumbers both the rendered output and the stored block list in the same operation, so they can never disagree.
- The parsed block list and `draftContentChecksum` are stored with the draft.

**FR-EDIT-03 — Autosave**
Drafts save without an explicit action.
- The draft persists at most 3 seconds after the last keystroke.
- A failed save shows a visible warning and retries; it never fails silently.

**FR-EDIT-04 — Structure editing**
Admins add, delete and reorder chapters and lessons.
- Reordering is a single request carrying the full new order, not one request per item.
- Deleting sets `deleted_at`; it does not remove rows.

**FR-EDIT-05 — Learner preview**
Admins can view a lesson exactly as a learner would, including the audio player.

### 5.4 Images

**FR-IMG-01 — Generate illustration candidates**
Admins request an AI-generated image for a figure block.
- The request produces 2 to 4 candidates.
- Each candidate stores its prompt text, model name and provider name.
- Generation runs as a background job; the UI shows progress and does not block editing.

**FR-IMG-02 — Manual upload fallback**
Admins can upload an image file instead of generating one.
- Accepted: PNG, JPEG, WebP, SVG. Maximum 5 MB.
- Required because AI image generation is unreliable for technical diagrams, charts with exact numbers, and text rendered inside the image.

**FR-IMG-03 — Selection, caption and alt text**
Exactly one candidate per figure block is marked selected.
- `captionText` and `alternativeText` are both required before the lesson can leave `drafting`.
- Both fields feed the narration script generator, so they must describe what the image shows, not merely name it.

### 5.5 Narration script

**FR-SCRIPT-01 — Generate script from block list**
The generator receives the parsed block list, not raw markdown, and returns one segment per block.
- Output must contain exactly one segment per input block, in the same order, reusing the same `blockId` values. A response that violates this is rejected and retried.
- Output language equals the course `languageCode`.
- Generation runs as a background job.

**FR-SCRIPT-02 — Script must not add knowledge**
The script restates the lesson body in spoken language and introduces no facts absent from the body.
- The prompt states this constraint explicitly (§6.3).
- Admin approval is required before audio generation, which is the enforcement point.

**FR-SCRIPT-03 — Figure and table references**
- A figure segment opens by referring to the figure by its number, then describes it using the caption and alt text.
- A table segment names the table by number, states what it covers, and reads at most 5 representative rows.

**FR-SCRIPT-04 — Admin review**
Admins can edit any segment's text before approving.
- Editing a segment updates `scriptChecksum` and marks the corresponding audio segment stale.
- Approval records `reviewedByUserId` and `reviewedAt`.

### 5.6 Audio

**FR-AUDIO-01 — Generate audio per segment**
Audio is synthesized one segment at a time, then merged into a single file per lesson.
- Each segment stores its own audio file URL, `startMillisecond` and `endMillisecond` within the merged file.
- Regeneration synthesizes only stale segments and re-merges; it does not re-synthesize the whole lesson.

**FR-AUDIO-02 — Playback with highlight sync**
The learner player highlights the block currently being read.
- The player seeks to a block when the learner clicks it in the content.
- Playback position is persisted to `lesson_progress.last_audio_position_ms`.
- Playback speed is adjustable; the selected speed persists across lessons.

**FR-AUDIO-03 — Voice configuration**
A course has one configured voice in v1.
- The voice identifier and provider are stored with each audio row so a voice change is detectable.

### 5.7 Publishing

**FR-PUB-01 — Publish checklist**
Publishing is blocked until every item passes.
- Every non-deleted lesson has non-empty draft content.
- No lesson is in `contentStatus = empty`.
- Every figure block has a selected image with caption and alt text.
- No narration script or audio is `stale` or `failed`.
- The course has at least 3 chapters and every chapter has at least 2 lessons.
- The course has a category and a cover image.
- If `pricingType = paid`, at least one active product references this course or its category.
- The checklist endpoint returns each item with pass or fail and a human-readable reason.

**FR-PUB-02 — Publish job**
- Copies `draft_content_markdown` and `draft_block_list` into the published columns for every lesson.
- Rebuilds `published_course_structures` and increments `publishedVersionNumber`.
- Sets `publicationStatus = published`, `publishedAt`, `hasUnpublishedChanges = false`.
- The job is idempotent: re-running it produces the same result.

**FR-PUB-03 — Unpublished changes indicator**
Editing any lesson in a published course sets `hasUnpublishedChanges = true` on the course and shows a "publish changes" action to the owner.

**FR-PUB-04 — Unpublish**
- Removes the course from the catalog.
- Existing grants and progress are preserved and become visible again on re-publish.

### 5.8 Catalog and learning

**FR-CAT-01 — Browse and search**
- Catalog lists only `published` courses, grouped by category and ordered by `levelOrder`.
- Search matches course title, category name and overview summary.
- Results are paginated.

**FR-CAT-02 — Category page**
Each category has a landing page listing its levels and, if a bundle product exists, the bundle offer.
- Unpublished levels are shown as "in development" with no link.

**FR-CAT-03 — Course page**
Shows overview, objectives, prerequisites, full table of contents, single-course price, and the bundle offer if one exists.

**FR-LRN-01 — Read a lesson**
- Renders published markdown with numbered figures and tables, a table of contents, and previous/next navigation.
- Requires entitlement (§7.3) unless the lesson is `isFreePreview`.

**FR-LRN-02 — Mark complete and resume**
- Learners toggle lesson completion.
- Scroll position and audio position are persisted per lesson.
- "My courses" shows a resume action that opens the last accessed lesson.

**FR-LRN-03 — Progress**
- Progress percentage is computed per chapter and per course from completed lessons over total non-deleted published lessons.

**FR-REQ-01 — Topic requests**
- Learners submit a requested topic with an optional description.
- Learners upvote requests; one vote per user per request.
- Owner reviews the queue and sets status to accepted, rejected or duplicated, optionally linking a created course.

### 5.9 Commerce

See §7 for the full model. Requirements:

**FR-COM-01 — Products**
Owner creates a product for a single course or for a whole category, sets price, currency, `accessDurationDays` and `gracePeriodDays`.
- At most one active product per course and one per category.
- Saving warns, without blocking, when a bundle price is greater than or equal to the sum of its courses' single prices.

**FR-COM-02 — Checkout**
- Checkout creates a `payment_orders` row in `pending` and returns the provider's redirect target.
- The same endpoint serves first purchase and renewal.
- If the learner already owns a course included in a bundle they are buying, checkout shows a warning and still allows the purchase. No refund of the overlap in v1.

**FR-COM-03 — Access granted only by verified webhook**
- Access is granted only when a webhook with a verified signature reports payment success.
- A browser redirect never grants access.
- Webhook handling is idempotent on `(providerName, providerOrderReference)`.

**FR-COM-04 — Manual grants**
Owner grants access directly, scoped to a course or a category, with an expiry date or no expiry at all.
- Owner can revoke a grant; revocation takes effect on the next request.

**FR-COM-05 — Expiry reminders**
A daily job emails learners before and after expiry (§7.5).

---

## 6. Content and AI pipeline contracts

### 6.1 Block extraction

Input: lesson body markdown. Output: ordered block list stored as JSONB.

```json
{
  "lessonTitle": "The A-row in Hiragana",
  "blocks": [
    { "blockId": "b1", "blockType": "paragraph", "text": "..." },
    { "blockId": "fig1", "blockType": "figure", "figureNumber": 1,
      "captionText": "Stroke order of あ",
      "alternativeText": "Five numbered strokes forming the character あ",
      "imageUrl": "https://..." },
    { "blockId": "tbl1", "blockType": "table", "tableNumber": 1,
      "captionText": "Pronunciation of the A-row",
      "headers": ["Character", "Romaji", "Sound"],
      "rows": [["あ", "a", "ah"], ["い", "i", "ee"]] }
  ]
}
```

Implementation notes:
- Use an AST-based markdown parser (`remark`), not regular expressions.
- `blockId` is derived from a stable counter persisted with the draft, not from content hashing, so editing a paragraph's text does not change its id.
- Figure and table numbering is assigned here and nowhere else. Renderer and narration generator both read these numbers; neither recomputes them.

### 6.2 Image generation

Request payload:

```json
{
  "lessonId": "…",
  "blockReferenceId": "fig1",
  "imagePromptText": "…",
  "candidateCount": 4
}
```

- Stored per candidate: `imageFileUrl`, `imagePromptText`, `imageModelName`, `imageProviderName`, `imageSource`.
- `imageSource` is `ai_generated` or `uploaded`.
- Exactly one candidate per block has `isSelected = true`.

### 6.3 Narration script generation

**Model:** a mid-tier model is sufficient; this is a text transformation task, not knowledge generation. Default `claude-sonnet-5`. Verify current model identifiers and pricing at https://docs.claude.com before committing to a budget.

**Input:** the block list from §6.1, plus `lessonTitle`, `learningObjective` and `languageCode`.

**Prompt constraints** (the implementation stores this as a versioned prompt; `generatorPromptVersion` is recorded on every run):

- Produce exactly one segment per input block, same order, same `blockId` values.
- Write in the language given by `languageCode`.
- Restate only what the body says. Do not add facts, examples, definitions or opinions that are not in the input.
- For a figure block: open by referring to it by its number, then describe what it shows using the caption and alt text.
- For a table block: name the table by its number, say what it covers, then read at most 5 representative rows. Never read a long table in full.
- Convert symbols to words: `%` to "percent", `→` to "leads to", and so on. For inline code, say the name and skip the syntax.
- Spoken style: short sentences, no markdown, no bullet characters, no headings read aloud as "hash hash".

**Output schema:**

```json
{
  "segments": [
    { "blockId": "b1", "narrationText": "..." },
    { "blockId": "fig1", "narrationText": "..." }
  ],
  "totalEstimatedSeconds": 180
}
```

**Validation:** reject and retry (maximum 2 retries) when the segment count differs from the block count, when any `blockId` is unknown, or when order differs. After the final retry, set `scriptStatus = failed` with the reason.

### 6.4 Text to speech and timing

Chosen approach: synthesize one audio file per segment, measure each duration, merge with ffmpeg, store offsets.

- Rationale: admins edit single blocks frequently. Per-segment synthesis means a small edit costs one segment, not a whole lesson.
- Alternative: some providers support SSML `<mark>` with returned timepoints, which removes the ffmpeg dependency but forces whole-lesson resynthesis on any edit. **Check the chosen provider's documentation before deciding.**
- Store `totalCharacterCount` per lesson audio for cost tracking.

### 6.5 Checksum chain and staleness

```
lesson_contents.draft_content_checksum
        └─→ narration_scripts.source_content_checksum
                    └─→ lesson_audios.source_script_checksum
```

- A script is stale when `source_content_checksum` differs from the lesson's current `draft_content_checksum`.
- An audio is stale when `source_script_checksum` differs from the script's current `script_checksum`.
- Staleness is **computed on read**, never written by a background job.
- The publish checklist blocks on any stale artifact.
- Regeneration is scoped: stale script regenerates the script; stale audio regenerates only the affected segments.

---

## 7. Commerce and entitlement

### 7.1 Products

A product is the sellable item. Two types:

| `productType` | References | Buyer receives |
|---|---|---|
| `single_course` | one course | that course only |
| `category_bundle` | one category | every course in that category |

- `courses.pricingType` (`free` or `paid`) is the **access policy**. Price lives on the product. Price is never stored in two places.
- A course may be sold individually and also be included in a bundle at the same time.
- At most one active product per course and one per category, enforced by partial unique indexes.

### 7.2 Access grants

A grant is a learner's right, scoped to a course or a category.

- `scopeType` is `course` or `category`.
- `accessSource` is `purchase` or `granted_by_owner`.
- `expiresAt` is `NULL` only for owner-granted perpetual access.
- **Bundle inclusion policy is locked to `all_current_and_future`.** A category-scoped grant automatically covers courses published later. No job updates grants when a new course is published.
  - Business consequence, accepted: a new level, however expensive to produce, is included in existing bundle grants. Bundle pricing must account for future levels from the start.

### 7.3 Entitlement resolution

One function, used everywhere:

```ts
function isGrantActive(grant: AccessGrant, now: Date): boolean {
  if (grant.revokedAt) return false;
  if (grant.expiresAt === null) return true;            // perpetual, owner-granted only
  return addDays(grant.expiresAt, grant.gracePeriodDays) > now;
}

async function hasAccessToCourse(userId: string, courseId: string): Promise<boolean> {
  const course = await loadCourse(courseId);
  if (course.pricingType === 'free') return true;
  return hasActiveGrant(userId, [
    { scopeType: 'course',   scopeId: course.id },
    { scopeType: 'category', scopeId: course.categoryId },
  ]);
}

async function hasAccessToLesson(userId: string, lessonId: string): Promise<boolean> {
  const lesson = await loadLessonWithCourse(lessonId);
  if (lesson.isFreePreview) return true;
  return hasAccessToCourse(userId, lesson.courseId);
}
```

**Requirement E-01.** `hasAccessToLesson` must gate **both** `GET /lessons/:lessonId` and `GET /media/:mediaId/signed-url`. Missing either one leaks paid audio. A regression test covers both endpoints.

**Requirement E-02.** Expiry is never materialized into a status column. A background job that flips grants to "expired" is explicitly rejected: if the job stalls, expired learners keep access, and if it over-runs, paying learners lose it.

**Requirement E-03.** Signed media URLs expire within minutes. A long-lived URL survives the grant that produced it, so TTL is a correctness requirement, not an optimization.

### 7.4 Renewal

**Renewal type is locked to `manual`.** The app never charges automatically.

Consequences, all positive for v1: no stored payment mandate, no dunning, no cancellation flow, no proration, and a much wider choice of payment gateway since only one-off payments are required.

**Stacking rule — renewal adds to the remaining term, it never overwrites it:**

```ts
const baseDate = currentExpiresAt && currentExpiresAt > now ? currentExpiresAt : now;
const newExpiresAt = addDays(baseDate, product.accessDurationDays);
```

Renewing two months early yields fourteen months. Writing `now + accessDurationDays` silently destroys paid time. This requires a dedicated unit test for the early-renewal case.

**Other rules:**
- Renewal price is the product's current price. Historical pricing is not preserved in v1.
- `lesson_progress` is never deleted on expiry. Expiry blocks reading only. Preserved progress is the strongest reason a learner renews.
- An expired course stays visible in "My courses" with an expired badge, its progress percentage, and a repurchase action. It is not hidden.
- Free-preview lessons remain readable after expiry.

**Grant lifecycle:**

```
active ──(renew)──────────→ active (expiry extended)
active ──(≤30 days left)──→ expiring → reminders sent
expiring ──(past expiry + grace)──→ expired ──(repurchase)──→ active
active ──(owner revokes)──→ revoked
```

### 7.5 Expiry reminders

A daily job scans grants by expiry date and sends email.

| Trigger | Content |
|---|---|
| 30 days before expiry | Gentle reminder including current progress percentage |
| 7 days before expiry | Reminder with renewal action |
| 1 day before expiry | Final reminder |
| On expiry | Expiry notice with repurchase action |

- Sent milestones are recorded in `access_grants.sent_reminder_milestones` so re-runs never duplicate email.
- This requires a transactional email provider. Without reminders, renewal rates are low and learners lose access without warning.

---

## 8. Data model

PostgreSQL. Enum-like values are stored as `TEXT` and validated in the application layer to keep migrations cheap.

```sql
CREATE TABLE users (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email_address               TEXT NOT NULL UNIQUE,
    display_name                TEXT,
    user_role                   TEXT NOT NULL DEFAULT 'learner',
    is_active                   BOOLEAN NOT NULL DEFAULT true,
    created_by_user_id          UUID REFERENCES users(id),
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE categories (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug                        TEXT NOT NULL UNIQUE,
    display_name                TEXT NOT NULL,
    description                 TEXT,
    cover_image_url             TEXT,
    display_order               INTEGER NOT NULL DEFAULT 0
);

-- One course = one level inside a category. Unit of publishing and enrollment.
CREATE TABLE courses (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category_id                 UUID NOT NULL REFERENCES categories(id),
    slug                        TEXT NOT NULL UNIQUE,
    level_label                 TEXT NOT NULL,
    level_order                 INTEGER NOT NULL,
    title                       TEXT NOT NULL,
    overview_summary            TEXT,
    prerequisites               JSONB NOT NULL DEFAULT '[]',
    learning_objectives         JSONB NOT NULL DEFAULT '[]',
    estimated_total_minutes     INTEGER,
    cover_image_url             TEXT,
    language_code               TEXT NOT NULL DEFAULT 'vi',
    pricing_type                TEXT NOT NULL DEFAULT 'free',
    publication_status          TEXT NOT NULL DEFAULT 'draft',
    has_unpublished_changes     BOOLEAN NOT NULL DEFAULT false,
    published_at                TIMESTAMPTZ,
    imported_by_user_id         UUID REFERENCES users(id),
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (category_id, level_order)
);
CREATE INDEX idx_courses_catalog
    ON courses(publication_status, category_id, level_order);

CREATE TABLE chapters (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    course_id                   UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    chapter_order               INTEGER NOT NULL,
    title                       TEXT NOT NULL,
    description                 TEXT,
    assigned_admin_id           UUID REFERENCES users(id),
    deleted_at                  TIMESTAMPTZ
);
CREATE UNIQUE INDEX idx_chapters_order
    ON chapters(course_id, chapter_order) WHERE deleted_at IS NULL;

CREATE TABLE lessons (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chapter_id                  UUID NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    lesson_order                INTEGER NOT NULL,
    title                       TEXT NOT NULL,
    learning_objective          TEXT,
    key_points                  JSONB NOT NULL DEFAULT '[]',
    estimated_minutes           INTEGER,
    is_free_preview             BOOLEAN NOT NULL DEFAULT false,
    content_status              TEXT NOT NULL DEFAULT 'empty',
    assigned_admin_id           UUID REFERENCES users(id),
    deleted_at                  TIMESTAMPTZ
);
CREATE UNIQUE INDEX idx_lessons_order
    ON lessons(chapter_id, lesson_order) WHERE deleted_at IS NULL;

-- Two tracks: draft is what admins edit, published is what learners read.
CREATE TABLE lesson_contents (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lesson_id                   UUID NOT NULL UNIQUE REFERENCES lessons(id) ON DELETE CASCADE,
    draft_content_markdown      TEXT,
    draft_block_list            JSONB,
    draft_content_checksum      TEXT,
    published_content_markdown  TEXT,
    published_block_list        JSONB,
    last_edited_by_user_id      UUID REFERENCES users(id),
    draft_updated_at            TIMESTAMPTZ,
    published_at                TIMESTAMPTZ
);

CREATE TABLE lesson_images (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lesson_id                   UUID NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    block_reference_id          TEXT NOT NULL,
    figure_number               INTEGER,
    image_file_url              TEXT NOT NULL,
    caption_text                TEXT NOT NULL,
    alternative_text            TEXT NOT NULL,
    image_source                TEXT NOT NULL DEFAULT 'ai_generated',
    image_prompt_text           TEXT,
    image_model_name            TEXT,
    image_provider_name         TEXT,
    is_selected                 BOOLEAN NOT NULL DEFAULT false,
    created_by_user_id          UUID REFERENCES users(id),
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_lesson_images_lesson ON lesson_images(lesson_id, block_reference_id);

CREATE TABLE narration_scripts (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lesson_id                   UUID NOT NULL UNIQUE REFERENCES lessons(id) ON DELETE CASCADE,
    script_segments             JSONB NOT NULL,
    script_checksum             TEXT NOT NULL,
    source_content_checksum     TEXT NOT NULL,
    script_status               TEXT NOT NULL DEFAULT 'pending',
    generator_model_name        TEXT,
    generator_prompt_version    TEXT,
    input_token_count           INTEGER,
    output_token_count          INTEGER,
    reviewed_by_user_id         UUID REFERENCES users(id),
    reviewed_at                 TIMESTAMPTZ,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE lesson_audios (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lesson_id                   UUID NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    voice_provider_name         TEXT NOT NULL,
    voice_identifier            TEXT NOT NULL,
    merged_audio_file_url       TEXT NOT NULL,
    total_duration_seconds      INTEGER,
    total_character_count       INTEGER,
    source_script_checksum      TEXT NOT NULL,
    audio_status                TEXT NOT NULL DEFAULT 'pending',
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (lesson_id, voice_identifier)
);

-- Per-block timing, used for playback highlight sync.
CREATE TABLE audio_segments (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lesson_audio_id             UUID NOT NULL REFERENCES lesson_audios(id) ON DELETE CASCADE,
    block_reference_id          TEXT NOT NULL,
    segment_order               INTEGER NOT NULL,
    start_millisecond           INTEGER NOT NULL,
    end_millisecond             INTEGER NOT NULL,
    segment_audio_file_url      TEXT,
    UNIQUE (lesson_audio_id, segment_order)
);

-- Table-of-contents snapshot taken at publish time. Excludes lesson bodies.
CREATE TABLE published_course_structures (
    course_id                   UUID PRIMARY KEY REFERENCES courses(id) ON DELETE CASCADE,
    structure_payload           JSONB NOT NULL,
    total_lesson_count          INTEGER NOT NULL,
    published_version_number    INTEGER NOT NULL DEFAULT 1,
    published_by_user_id        UUID NOT NULL REFERENCES users(id),
    published_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sellable item: one course, or a whole category.
CREATE TABLE products (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_type                TEXT NOT NULL,
    course_id                   UUID REFERENCES courses(id) ON DELETE CASCADE,
    category_id                 UUID REFERENCES categories(id) ON DELETE CASCADE,
    display_name                TEXT NOT NULL,
    price_amount                NUMERIC(12,2) NOT NULL,
    currency_code               TEXT NOT NULL DEFAULT 'VND',
    access_duration_days        INTEGER NOT NULL DEFAULT 365,
    grace_period_days           INTEGER NOT NULL DEFAULT 0,
    renewal_type                TEXT NOT NULL DEFAULT 'manual',
    bundle_inclusion_policy     TEXT NOT NULL DEFAULT 'all_current_and_future',
    is_active                   BOOLEAN NOT NULL DEFAULT true,
    created_by_user_id          UUID NOT NULL REFERENCES users(id),
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
        (product_type = 'single_course'   AND course_id   IS NOT NULL AND category_id IS NULL) OR
        (product_type = 'category_bundle' AND category_id IS NOT NULL AND course_id   IS NULL)
    )
);
CREATE UNIQUE INDEX idx_products_single_course
    ON products(course_id)   WHERE product_type = 'single_course'   AND is_active;
CREATE UNIQUE INDEX idx_products_category_bundle
    ON products(category_id) WHERE product_type = 'category_bundle' AND is_active;

-- Access right, scoped to one course or one whole category.
CREATE TABLE access_grants (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope_type                  TEXT NOT NULL,
    scope_course_id             UUID REFERENCES courses(id) ON DELETE CASCADE,
    scope_category_id           UUID REFERENCES categories(id) ON DELETE CASCADE,
    access_source               TEXT NOT NULL,
    source_product_id           UUID REFERENCES products(id),
    payment_order_id            UUID,
    granted_by_user_id          UUID REFERENCES users(id),
    expires_at                  TIMESTAMPTZ,                      -- NULL means perpetual, owner-granted only
    grace_period_days           INTEGER NOT NULL DEFAULT 0,
    renewal_count               INTEGER NOT NULL DEFAULT 0,
    sent_reminder_milestones    JSONB NOT NULL DEFAULT '[]',      -- e.g. ["day_30","day_7"]
    revoked_at                  TIMESTAMPTZ,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
        (scope_type = 'course'   AND scope_course_id   IS NOT NULL AND scope_category_id IS NULL) OR
        (scope_type = 'category' AND scope_category_id IS NOT NULL AND scope_course_id   IS NULL)
    )
);
CREATE UNIQUE INDEX idx_access_grants_course
    ON access_grants(user_id, scope_course_id)
    WHERE scope_type = 'course'   AND revoked_at IS NULL;
CREATE UNIQUE INDEX idx_access_grants_category
    ON access_grants(user_id, scope_category_id)
    WHERE scope_type = 'category' AND revoked_at IS NULL;
CREATE INDEX idx_access_grants_expiry
    ON access_grants(expires_at)
    WHERE revoked_at IS NULL AND expires_at IS NOT NULL;

CREATE TABLE payment_orders (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                     UUID NOT NULL REFERENCES users(id),
    product_id                  UUID NOT NULL REFERENCES products(id),
    provider_name               TEXT NOT NULL,
    provider_order_reference    TEXT NOT NULL,
    amount                      NUMERIC(12,2) NOT NULL,
    currency_code               TEXT NOT NULL,
    order_status                TEXT NOT NULL DEFAULT 'pending',
    raw_webhook_payload         JSONB,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at                TIMESTAMPTZ,
    UNIQUE (provider_name, provider_order_reference)
);

CREATE TABLE lesson_progress (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    lesson_id                   UUID NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    progress_status             TEXT NOT NULL DEFAULT 'not_started',
    last_scroll_percentage      SMALLINT NOT NULL DEFAULT 0,
    last_audio_position_ms      INTEGER NOT NULL DEFAULT 0,
    completed_at                TIMESTAMPTZ,
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, lesson_id)
);

CREATE TABLE topic_requests (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requested_by_user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    requested_topic_title       TEXT NOT NULL,
    request_description         TEXT,
    request_status              TEXT NOT NULL DEFAULT 'pending',
    upvote_count                INTEGER NOT NULL DEFAULT 0,
    reviewer_note               TEXT,
    reviewed_by_user_id         UUID REFERENCES users(id),
    linked_course_id            UUID REFERENCES courses(id),
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE topic_request_votes (
    topic_request_id            UUID NOT NULL REFERENCES topic_requests(id) ON DELETE CASCADE,
    user_id                     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (topic_request_id, user_id)
);

CREATE TABLE generation_jobs (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_type                    TEXT NOT NULL,
    target_entity_id            UUID NOT NULL,
    job_status                  TEXT NOT NULL DEFAULT 'queued',
    attempt_count               INTEGER NOT NULL DEFAULT 0,
    error_message               TEXT,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at                  TIMESTAMPTZ,
    finished_at                 TIMESTAMPTZ
);
CREATE INDEX idx_generation_jobs_target ON generation_jobs(target_entity_id, job_type);
```

### 8.1 Enumerated values

| Column | Allowed values |
|---|---|
| `user_role` | `admin_owner`, `admin`, `learner` |
| `publication_status` | `draft`, `in_review`, `publishing`, `published`, `unpublished`, `archived` |
| `content_status` | `empty`, `drafting`, `ready`, `published` |
| `script_status`, `audio_status` | `pending`, `generating`, `ready`, `stale`, `failed` |
| `image_source` | `ai_generated`, `uploaded` |
| `pricing_type` | `free`, `paid` |
| `product_type` | `single_course`, `category_bundle` |
| `bundle_inclusion_policy` | `all_current_and_future` (locked), `snapshot_at_purchase` (reserved) |
| `renewal_type` | `manual` (locked), `auto` (reserved) |
| `scope_type` | `course`, `category` |
| `access_source` | `purchase`, `granted_by_owner` |
| `order_status` | `pending`, `paid`, `failed`, `refunded` |
| `progress_status` | `not_started`, `in_progress`, `completed` |
| `request_status` | `pending`, `accepted`, `rejected`, `duplicated` |
| `job_type` | `generate_image`, `generate_narration_script`, `generate_audio`, `publish_course`, `import_course_outline`, `send_expiry_reminder` |

---

## 9. API contracts

### 9.1 Import schema

```json
{
  "category": { "slug": "japanese", "displayName": "Japanese" },
  "course": {
    "levelLabel": "N5",
    "levelOrder": 1,
    "title": "Japanese N5",
    "overviewSummary": "At most 3 sentences",
    "prerequisites": ["..."],
    "learningObjectives": ["..."],
    "estimatedTotalMinutes": 1200,
    "languageCode": "vi"
  },
  "chapters": [
    {
      "chapterOrder": 1,
      "title": "Hiragana",
      "description": "...",
      "lessons": [
        {
          "lessonOrder": 1,
          "title": "The A-row",
          "learningObjective": "...",
          "keyPoints": ["..."],
          "estimatedMinutes": 15
        }
      ]
    }
  ]
}
```

### 9.2 Owner endpoints — `/api/admin/*`, role `admin_owner`

| Method | Path | Purpose |
|---|---|---|
| POST | `/admins` | Create an admin account |
| PATCH | `/admins/:userId` | Rename, enable or disable |
| POST | `/categories` | Create a category |
| POST | `/courses/import/dry-run` | Validate payload, return preview, write nothing |
| POST | `/courses/import` | Commit the outline |
| GET | `/courses/:courseId/publish-checklist` | Per-item pass or fail |
| POST | `/courses/:courseId/publish` | `202`, or `422` with checklist failures |
| POST | `/courses/:courseId/unpublish` | Remove from catalog |
| PATCH | `/courses/:courseId/pricing-type` | Switch `free` or `paid` |
| POST | `/products` | Create a single-course or bundle product |
| PATCH | `/products/:productId` | Change price, duration, grace period, active flag |
| GET | `/products/:productId/price-check` | Warn when bundle price is not below the sum of single prices |
| POST | `/grants` | Grant access manually, with or without expiry |
| DELETE | `/grants/:grantId` | Revoke |
| GET | `/topic-requests` | Review queue |
| PATCH | `/topic-requests/:requestId` | Accept, reject or mark duplicate |
| GET | `/courses/:courseId/usage` | Token, image and TTS cost for this course |

### 9.3 Admin endpoints — `/api/admin/*`, role `admin_owner` or `admin`

| Method | Path | Purpose |
|---|---|---|
| GET | `/my-assignments` | Lessons assigned to the caller |
| POST | `/chapters`, `/lessons` | Create |
| PATCH | `/chapters/:id`, `/lessons/:id` | Edit, reorder |
| DELETE | `/chapters/:id`, `/lessons/:id` | Soft delete |
| PUT | `/lessons/:lessonId/content` | Save draft, reparse blocks, update checksum |
| POST | `/lessons/:lessonId/images/generate` | Generate candidates, `202` |
| POST | `/lessons/:lessonId/images/upload` | Upload a file |
| PATCH | `/images/:imageId` | Select, set caption and alt text |
| POST | `/lessons/:lessonId/narration-script` | Generate script, `202` |
| PUT | `/lessons/:lessonId/narration-script` | Edit segments, approve |
| POST | `/lessons/:lessonId/audio` | Synthesize stale segments and re-merge, `202` |
| GET | `/lessons/:lessonId/staleness` | Content, script and audio freshness |
| POST | `/courses/:courseId/submit-review` | Move to `in_review` |
| GET | `/courses/:courseId/stream` | Server-sent events for job progress |

All write endpoints above return `403` under rule R-01.

### 9.4 Public endpoints — `/api/*`, read-only except checkout and progress

| Method | Path | Purpose |
|---|---|---|
| GET | `/categories` | Categories with level counts |
| GET | `/categories/:slug` | Category page: bundle offer and level list |
| GET | `/courses` | Catalog, published only, filterable and paginated |
| GET | `/courses/:slug` | Overview, table of contents from snapshot, single price and bundle offer |
| GET | `/lessons/:lessonId` | Published content, script segments and audio timings. Entitlement-gated unless `isFreePreview` |
| GET | `/media/:mediaId/signed-url` | Short-lived signed URL. Entitlement-gated |
| POST | `/checkout` | Create an order for a `productId`. Serves both purchase and renewal |
| POST | `/webhooks/payment` | Verify signature, mark order paid, create or extend the grant |
| GET | `/me/courses` | Owned courses with progress, `expiresAt` and `daysRemaining` |
| PUT | `/lessons/:lessonId/progress` | Update completion, scroll and audio position |
| POST | `/topic-requests` | Submit a request |
| POST | `/topic-requests/:requestId/vote` | Upvote |

The public API contains no endpoint that calls an LLM, an image generator or a TTS provider. This is deliberate: it removes any path for anonymous traffic to spend money.

---

## 10. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-01 | Published course and lesson pages are statically generated or incrementally revalidated; media is served through a CDN. |
| NFR-02 | Signed media URLs expire within 15 minutes. |
| NFR-03 | Every AI and TTS call runs in a background job with bounded concurrency, retry with exponential backoff, and a maximum of 3 attempts. |
| NFR-04 | All long-running operations report progress over server-sent events; no HTTP request waits on an AI provider. |
| NFR-05 | Token counts, image counts and TTS character counts are recorded per lesson and aggregated per course. |
| NFR-06 | Webhook handling is idempotent and safe to replay. |
| NFR-07 | Structured logging on every job with `jobType`, `targetEntityId` and `attemptCount`. Alert when the failure rate over one hour exceeds 10 percent. |
| NFR-08 | All prompts are versioned; `promptVersion` is stored with every generated artifact. |
| NFR-09 | The admin editor works on screens 1280 px and wider. The learner app is responsive from 360 px. |
| NFR-10 | Lesson body content is stored as markdown, not HTML, so it stays portable and diffable. |

---

## 11. Architecture

**Applications**

| Application | Stack | Role |
|---|---|---|
| `admin-web` | Next.js, client-heavy | Owner and admin portal |
| `learner-web` | Next.js with ISR | Catalog and learning |
| `api` | NestJS | Admin, public and payment modules |
| `worker` | NestJS with BullMQ | Image, script, audio, publish and reminder jobs |

**Infrastructure:** PostgreSQL, Redis, private object storage with CDN, ffmpeg in the worker image.

**External providers, each behind an interface:**

| Interface | Purpose |
|---|---|
| `LlmProvider` | Narration script generation |
| `ImageGenerationProvider` | Illustration candidates |
| `TextToSpeechProvider` | Segment audio |
| `PaymentProvider` | `createCheckout`, `verifyWebhook`, `getOrderStatus` |
| `EmailProvider` | Transactional email, including expiry reminders |

**Repository layout**

```
/apps
  /admin-web
  /learner-web
  /api
  /worker
/packages
  /database        Prisma schema and client
  /content         markdown parser, block extraction, checksums
  /ai              LlmProvider, ImageGenerationProvider, TextToSpeechProvider
  /commerce        PaymentProvider, entitlement resolution
  /shared          types, enums, zod schemas
/docs
  import-schema.json
  owner-prompt-template.md
```

---

## 12. Implementation phases

| Phase | Scope | Estimate |
|---|---|---|
| P0 — Foundation | Monorepo, Docker Compose, Prisma, Auth.js, three-role RBAC, CI | 1 week |
| P1 — Curriculum skeleton | Categories, courses, import dry-run and commit, prompt template, chapter and lesson CRUD, assignment | 1.5 weeks |
| P2 — Authoring | Markdown editor with preview, autosave, block parser with figure and table numbering, checksums | 1.5 weeks |
| P3 — Images | `ImageGenerationProvider`, candidate generation, selection, caption and alt text, manual upload | 1 week |
| P4 — Narration script | Prompt, schema validation, generation worker, per-block review screen, staleness detection | 1 week |
| P5 — Audio | `TextToSpeechProvider`, per-segment synthesis, ffmpeg merge and offsets, selective regeneration | 1.5 weeks |
| P6 — Publishing | Checklist, publish worker, structure snapshot, published-course edit lock, unpublish | 1 week |
| P7 — Learner app | Catalog, category and course pages, reader, player with highlight sync, progress, my courses | 2 weeks |
| P8 — Commerce | Products, checkout, webhook verification, entitlement with expiry, renewal stacking, `EmailProvider`, reminder job, signed URLs, manual grants | 2.5 weeks |
| P9 — Topic requests | Submission, voting, owner review queue | 0.5 week |
| P10 — Operations | Cost dashboard, logging, error tracking, job alerts, seed data | 0.5 week |

**Total: about 14 weeks for one full-time engineer.** This is a rough estimate derived from task count, not a commitment.

Reduced scope option: drop P3 (manual image upload only), drop P9, and ship single-course sales without bundles. About 12 weeks. Do not drop P4 or P5, since listening is a core feature, and do not drop the reminder job, since it determines second-year revenue.

---

## 13. Out of scope for v1

- Automatic recurring billing, payment mandates, dunning and cancellation flows.
- Edit history and rollback of lesson content.
- Two-stage editorial approval (separate reviewer and approver roles).
- Quizzes and assessments.
- Learner notes and highlights.
- Offline audio download.
- PDF or markdown export.
- Multiple narration voices per course.
- Price grandfathering at renewal.
- Refunds or partial credit when a bundle overlaps an already-owned course.
- Native mobile applications.

---

## 14. Open decisions

| # | Decision | Impact |
|---|---|---|
| 1 | **Payment gateway.** Depends on whether buyers are domestic or international and on the legal entity. This is the only open item blocking P8. | Blocks P8 |
| 2 | Grace period length. `gracePeriodDays` currently defaults to 0. | Configuration |
| 3 | Number of free-preview lessons per course. | Configuration, affects conversion |
| 4 | Whether the chosen TTS provider supports SSML marks with returned timepoints, which would remove the ffmpeg dependency at the cost of whole-lesson resynthesis. | Affects P5 implementation only |

Everything else is locked: content hierarchy, three roles, admin-authored text, AI images with mandatory manual fallback, LLM narration script with admin approval, per-segment TTS, draft and published tracks, owner-only publishing and editing of published courses, flexible selling unit, `all_current_and_future` bundles, 365-day access, and manual renewal.

Decisions 2, 3 and 4 do not block starting P0 through P7.
