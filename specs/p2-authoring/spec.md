# Spec: P2 — Authoring

**Status:** Approved
**Date:** 2026-09-12

Derived from `knowledge-explorer-spec.md` §12 phase P2 — *"Markdown editor with
preview, autosave, block parser with figure and table numbering, checksums."*
That document is the product source of truth and is locked except §14; this
spec adds only the implementation decisions P2 requires and the product spec
does not make. It assumes `specs/p1-curriculum/` is **fully** delivered — see
Constraints, because that is not true as of this writing.

## Problem statement

P1 fills the curriculum tree and stops at the lesson boundary. Every lesson it
creates has `contentStatus = 'empty'` and no `lesson_contents` row at all; the
column `draft_content_markdown` is read by the import conflict check and written
by nothing. An admin can be assigned a lesson and then has no way to put a word
in it.

This is the only thing standing between the project and its actual product.
Everything downstream consumes a parsed block list: P3 generates an image for a
figure block, P4 generates exactly one narration segment per block, P5
synthesizes audio per segment, P6 copies draft blocks to the published track,
and P7 renders them to a learner. None of those phases has an input until P2
produces one, and each of them consumes it through a contract — the blockId, the
figure number, the checksum — that P2 alone defines. A blockId that is not
stable means P4's approved narration is silently orphaned by a typo fix. A
figure number the renderer recomputes means the audio says "figure two" while
the page shows figure three.

P2 delivers the authoring surface and, more importantly, the contract. It is
also the first phase to render anything a learner will eventually see, so the
renderer it builds is the one P7 will import rather than reimplement, and the
first phase to need a styling system, which P1 deliberately declined to choose.

## Acceptance criteria

### The markdown dialect

- The supported constructs are §5.3's list plus block quotes: headings,
  paragraphs, lists, tables, fenced code blocks, figure placeholders, block
  quotes, and inline bold, italic, links and inline code.
- A figure placeholder is the remark-directive leaf node `::figure`, alone on
  its line. It takes no arguments in P2; the image, caption and alt text are
  P3's and live in `lesson_images`, keyed by the block's `blockId`.
- A table caption is the leaf directive `::caption[Pronunciation of the A-row]`
  on the line immediately above a table. The parser consumes it, attaches its
  text to that table block's `captionText`, and emits no block for it. A
  `::caption` not immediately followed by a table is a validation error.
- **Raw HTML is rejected.** An HTML tag anywhere in the body fails the save with
  an error naming its line and column, and nothing is stored. The learner
  renderer therefore never receives HTML it would have to sanitize, and NFR-10's
  portable markdown stays portable.
- **Any top-level node that maps to none of the seven block types is likewise a
  validation error** naming its line and column — a `---` horizontal rule, a
  footnote definition, a link reference definition. §5.3's supported list is
  closed. This keeps the block list a *total* function over the markdown:
  everything that renders is narratable, and the preview can never show
  something the block list omits.
- Validation reports **every** error with its line and column, not the first,
  matching the shape P1 established for import payloads.

### Block extraction

- `parseLessonMarkdown(markdown, previousState)` in `packages/content` is a pure
  function returning either a block list plus the new counter state, or the full
  list of validation errors. It touches no database and no clock.
- Exactly one block is emitted per top-level AST node, in document order. A
  whole list is one block, not one per item; a whole fenced code block is one
  block.
- The seven `blockType` values are `heading`, `paragraph`, `list`, `code`,
  `figure`, `table`, `blockquote`. They live once in
  `packages/shared/src/enums.ts` as a zod schema, per the project's
  single-source rule.
- Every block carries `blockId`, `blockType`, `markdown` (its exact source
  slice, for the renderer to render inline formatting from) and `text` (a
  plain-text flattening, for P4's narration generator). Per type it additionally
  carries: `heading` → `depth`; `list` → `ordered`; `code` → `lang`; `figure` →
  `figureNumber`; `table` → `tableNumber`, `captionText`, `headers`, `rows`.
- `text` is defined for every type so P4 never meets `undefined`: for a `table`
  it is the caption or `''`; for a `figure` it is `''` in P2, since the caption
  and alt text that will fill it belong to `lesson_images` and P3.
- **`lessonTitle` is not stored in the block list.** §6.1's example shows it, but
  §6.3 already passes it to the narration generator as a separate input, and
  storing it would make renaming a lesson change the checksum and mark every
  approved script stale for a change no learner hears. It is read from
  `lessons.title` at the point of consumption.
- Parsing uses `remark` with `remark-gfm` and `remark-directive` — an AST, never
  regular expressions (§6.1).
- The block list is stored as JSONB in `lesson_contents.draft_block_list`
  together with the counter state needed to mint the next id.

### Block identity

- Ids are minted from **one shared counter** persisted with the draft, prefixed
  by kind: `b7`, `fig8`, `tbl9`. The numeral is a mint sequence and **never** a
  figure or table number; `fig8` may perfectly well carry `figureNumber: 1`. A
  test asserts exactly this case so the invariant is documented in code.
- On every save the new blocks are matched against the stored block list in two
  passes:
  1. **Exact pass.** A Myers/LCS diff over `(blockType, normalized text)`, where
     normalization collapses runs of whitespace and trims. Every block in the
     common subsequence reuses its `blockId`.
  2. **Similarity pass.** The blocks left unmatched on each side are zipped in
     document order. A pair of the same `blockType` whose Sørensen–Dice
     coefficient over character trigrams of their normalized text is **> 0.6**
     is treated as an edit: the new block takes the old block's `blockId`. The
     threshold and the metric are named here so two implementations cannot
     disagree about what "similar" means.
  - Anything still unmatched mints a new id from the counter.
- Consequences that must hold, each with a test: retyping a paragraph's wording
  keeps its `blockId`; inserting a paragraph in the middle changes no existing
  `blockId`; deleting a block retires its id permanently — the counter never
  reissues it; reordering two paragraphs moves their ids with them.
- Figures are numbered sequentially from 1 within the lesson; tables are
  numbered separately from 1. Numbering is assigned here and nowhere else
  (§6.1); the renderer and, later, the narration generator read these numbers
  and neither recomputes them.
- Inserting a figure above an existing one renumbers the rendered output and the
  stored block list **in the same operation**, so they can never disagree
  (FR-EDIT-02).

### Checksums

- `draft_content_checksum` is the SHA-256 of the block list serialized as
  canonical JSON — sorted keys, `blockId` included, the counter state excluded.
- It follows that reformatting the markdown without changing the blocks — a
  trailing space, a reflowed paragraph, `*` swapped for `-` in a list — does not
  change the checksum, and therefore does not mark an approved narration script
  stale under §6.5. Changing a word does.
- The checksum is computed by `packages/content` and by nothing else, so the
  value the editor displays and the value the server stores come from one
  implementation.
- P2 writes the head of the §6.5 chain and reads no further link.

### Content endpoints

- `PUT /api/admin/lessons/:lessonId/content` (§9.3) accepts
  `{ markdown, expectedDraftUpdatedAt }`, reparses the markdown server-side,
  and on success stores `draft_content_markdown`, `draft_block_list`,
  `draft_content_checksum`, `last_edited_by_user_id` and `draft_updated_at` in
  one transaction. The client's parse is never trusted or transmitted.
- The `lesson_contents` row is created lazily on first save; import deliberately
  creates none (P1).
- A parse failure returns `422` with `errorCode: LESSON_CONTENT_INVALID` and
  every error's message, line and column. Nothing is written.
- **Optimistic concurrency:** `expectedDraftUpdatedAt` must equal the stored
  `draft_updated_at`, or the request returns `409` with
  `errorCode: LESSON_CONTENT_CONFLICT` and the current server-side markdown,
  checksum and `draftUpdatedAt` in the body. The first save of a lesson sends
  `null` and succeeds only when no row exists.
- A save whose markdown is **byte-identical** to the stored markdown is a no-op:
  it returns `200`, writes nothing and does not advance `draft_updated_at`, so
  idle autosaves cannot manufacture false conflicts for a second editor. The
  no-op test is on the markdown, not the checksum — a whitespace-only edit
  leaves the checksum unchanged but must still be persisted, or the admin loses
  their formatting on reload.
- `GET /api/admin/lessons/:lessonId/content` returns `{ markdown, blockList,
  draftContentChecksum, draftUpdatedAt, lastEditedBy, contentStatus }`. A lesson
  with no `lesson_contents` row returns the same shape with `markdown: ''`,
  an empty block list and `draftUpdatedAt: null`.

### Status and cross-phase flags

- The first save whose markdown is non-empty moves `lessons.content_status` from
  `empty` to `drafting`. P2 never sets `ready` — that transition is P6's, once
  P3 and P4 supply the gates FR-IMG-03 and §6.3 make it depend on.
- Clearing a lesson back to empty markdown does **not** return it to `empty`;
  `drafting` is where it stays.
- A save on a course whose `publication_status = 'published'` sets
  `courses.has_unpublished_changes = true` **when the recomputed checksum
  differs from the stored one**, matching what P1's re-import already does. A
  whitespace-only edit persists but does not raise the flag, because it changes
  nothing a learner would see.

### The editor

- An authenticated admin reaches `/courses/[courseId]/lessons/[lessonId]` from
  the P1 curriculum tree and sees a split view: CodeMirror 6 with markdown
  syntax highlighting on the left, live preview on the right, at 1280 px and
  wider (NFR-09).
- A formatting toolbar provides bold, italic, link, heading, inline code,
  bullet list, ordered list, block quote, **insert table** and **insert
  figure**. Insert-table emits a well-formed GFM skeleton with a `::caption`
  line above it; insert-figure emits `::figure`.
- Pasting rich text converts the clipboard's `text/html` payload to markdown and
  inserts that, rather than inserting tags that the parser will reject. A paste
  producing an unsupported construct is converted to the nearest supported one
  or dropped, never inserted as raw HTML.
- A status bar shows block count, word count and an estimated reading time.
- Validation errors appear inline against their lines in the editor gutter and
  as a list, each naming line and column.
- Navigating away or closing the tab with unsaved or failed changes prompts
  first.

### Autosave

- The draft persists at most **3 seconds** after the last keystroke (FR-EDIT-03),
  and immediately on editor blur.
- A save in flight shows a saving indicator; a completed save shows the time it
  landed.
- A failed save shows a **persistent visible warning** — never a silent failure
  — and retries with exponential backoff capped at 30 seconds, for as long as
  the tab is open. The banner states that changes are unsaved and when the last
  attempt was.
- A `409` is terminal: the retry loop stops and a conflict banner appears naming
  the other editor and offering to reload the server's version. The editor does
  not keep overwriting.
- A `422` is terminal: the retry loop stops, the validation errors render, and
  retries resume automatically once the markdown changes.

### Preview and the shared renderer

- `packages/content` exports a React renderer that takes a block list and
  returns elements. The editor's preview pane and, in P7, the learner's reader
  import the *same* component, so FR-EDIT-01's *"renders exactly what the
  learner will see"* holds by construction rather than by discipline.
- The renderer renders **from the block list**, never from raw markdown, so the
  figure and table numbers it shows are the ones stored (§6.1).
- The preview parses in the browser using the same `packages/content` parser,
  debounced ~150 ms, so it is instant and keeps working while a save is in
  flight or failing. The parser is therefore isomorphic — no Node-only imports
  anywhere in its dependency graph, asserted by a test that imports it under a
  browser-like condition.
- A `::figure` renders as a labelled empty slot reading "Figure *n*" — the shape
  P3 will fill with an image.
- A table renders with its number and caption above it.
- The renderer emits no `dangerouslySetInnerHTML` anywhere.

### Role enforcement

- Both content endpoints declare a §3 action through `@RequirePermission`; an
  endpoint without one denies all callers, as P0 established.
- R-01 holds: an `admin` writing content to a lesson in a `published` course
  gets `403 FORBIDDEN_COURSE_PUBLISHED`. The owner succeeds.
- R-02 holds and stays strictly row-level, unchanged from P1: an `admin` may
  write a lesson assigned to them or assigned to nobody, and gets
  `403 FORBIDDEN_NOT_ASSIGNED` otherwise. There is no inheritance from the
  chapter.
- The editor renders read-only, with an explanatory banner rather than a silent
  failure, when the server would refuse the write. The UI never carries the
  enforcement.
- Every `403` carries a machine-readable `errorCode`.

## Non-goals

These are out of scope for P2 and must not appear in its implementation.

- **Images.** No `ImageGenerationProvider`, no candidate generation, no upload,
  no selection, no caption or alt text editing. `lesson_images` is written by
  nothing. `::figure` produces a block and an empty slot; P3 fills it.
  `packages/ai` stays empty.
- **Narration and audio.** No `LlmProvider`, no `TextToSpeechProvider`, no
  script generation or review screen, no ffmpeg in the worker image. P2 produces
  the block list they consume and consumes nothing from them.
- **`GET /lessons/:lessonId/staleness`.** §9.3 lists it; P2 builds only the head
  of the §6.5 chain and returns `draftContentChecksum` on the content GET. The
  comparison logic and the endpoint arrive in P4, with the first artifact that
  can actually be stale.
- **The `ready` transition and `published` content status.** P2 moves `empty` →
  `drafting` and nothing else. No submit-for-review, no publish checklist.
- **The published track.** `published_content_markdown` and
  `published_block_list` are written by nothing. P2 sets
  `has_unpublished_changes` and does not consume it.
- **The full FR-EDIT-05 learner preview.** P2 ships the side-by-side preview
  pane only. A standalone learner-chrome preview route including the audio
  player is P5's, when there is a player to show.
- **Structure editing.** Chapter and lesson CRUD, reordering and assignment are
  P1's and are not touched. FR-EDIT-04 is already satisfied.
- **Edit history, versioning and rollback.** Explicitly out of scope for v1
  (§13). The editor has browser undo and nothing more.
- **Soft locking, presence, or collaborative editing.** Concurrency is handled
  by the optimistic check and a conflict banner. No lock table, no takeover UI,
  no operational transform, no websockets.
- **Draft recovery from `localStorage`.** The retry loop is the durability
  mechanism. A tab crash loses at most the unsaved tail.
- **Search across lessons, bulk find-and-replace, lesson duplication.**
- **Spellchecking beyond what the browser provides natively.**
- **Writing `lessons.estimated_minutes` from the reading-time estimate.** The
  status bar displays it; the column stays P1's.
- **A component library.** Tailwind and hand-rolled controls only — no shadcn,
  no Radix, no Mantine.
- **A linter.** The harness records linter choice as an open tooling question
  and it is not P2's to settle, exactly as P1 decided.
- **Mobile or tablet layouts.** NFR-09 binds the admin editor to 1280 px and
  wider.
- **Deployment, object storage, CDN.** Still local Docker Compose and the CI
  runner.

## Constraints

- **P1 must be complete before P2 begins.** As of this writing
  `specs/p1-curriculum/tasks.md` shows tasks 10, 14, 19–23 unchecked: the admin
  portal shell, the import screen's dry-run and gated commit, the curriculum
  tree, the RBAC matrix rows, the Playwright harness and the full verification
  run. P2's editor is reached *from* the curriculum tree and its verification
  *extends* the Playwright suite; neither exists yet. This is a hard
  precondition, not a preference.
- **The §8 schema is locked and P2 adds no migration.** Every column P2 writes
  — `draft_content_markdown`, `draft_block_list`, `draft_content_checksum`,
  `last_edited_by_user_id`, `draft_updated_at`, `lessons.content_status`,
  `courses.has_unpublished_changes` — already exists. `blockType` is a JSONB
  field, not a database column, so it gets a zod schema in `packages/shared` but
  does **not** join the §8.1 `enumColumns` catalogue, which stays at 16 rows.
- **One parser, two runtimes.** The same `packages/content` function runs in the
  browser for live preview and on the server for the authoritative save. It must
  be isomorphic and pure: no `node:` imports, no filesystem, no clock, no
  randomness. Given the same markdown and counter state it must return the same
  block list, and a test asserts determinism across repeated calls.
- **The server never trusts a client-supplied block list.** The browser parse is
  display-only. `PUT /content` accepts markdown and reparses.
- **Numbering is assigned in exactly one place.** The parser assigns
  `figureNumber` and `tableNumber`; the renderer reads them. Any code path that
  recomputes a number is a defect, and the end-to-end test exists to catch it.
- **Ids are never reissued.** The counter only advances, including across
  deletions, so a retired `blockId` can never be confused with a live one by an
  artifact P4 or P5 stored earlier.
- **NFR-10:** lesson bodies are stored as markdown, not HTML. The block list is
  a derived cache alongside it, not a replacement for it —
  `draft_content_markdown` remains the source. The invariant is a fixed point:
  reparsing the stored markdown **against the stored block list** reproduces
  that block list byte for byte, ids and counter included. A test asserts it
  over the whole golden corpus.
- **Autosave must not fail silently** (FR-EDIT-03). Every terminal failure state
  has a visible banner, and a test asserts the banner for the 409 and 422 paths.
- **Role is read from the session on every request, never from client input**
  (FR-AUTH-02). Unchanged from P0.
- **Deny by default.** An endpoint with no `@RequirePermission` rejects everyone.
- **Errors carry a machine-readable `errorCode`** from
  `packages/shared/src/errors.ts`. Never a bare string.
- **Nest dependency injection is always explicit `@Inject(Token)`**;
  `emitDecoratorMetadata` stays `false`.
- **TypeScript `strict: true`** across every workspace, extending
  `packages/shared/tsconfig.base.json`.
- **`packages/content` gains `react` as a peer dependency**, not a direct one,
  so the parser remains importable by `apps/api` and `apps/worker` without
  pulling React into a server bundle. Parser and renderer are separate entry
  points.
- **Tailwind v4 is adopted in `apps/admin-web` only.** `apps/learner-web` stays
  the P0 shell; P7 decides its own styling. Retrofitting P1's plain screens is
  permitted but not required.

## Affected files and interfaces

Paths marked **new** do not exist today; the rest are modified.

```
packages/shared/
  src/enums.ts                             + blockTypeSchema (7 members).
                                             enumColumns stays at 16 rows —
                                             blockType is not a §8 column
  src/errors.ts                            + LESSON_CONTENT_INVALID,
                                             LESSON_CONTENT_CONFLICT

packages/content/
  package.json                             + remark, remark-gfm,
                                             remark-directive, unified;
                                             react as a peerDependency;
                                             a second "./render" export
  src/blocks.ts                       new  parseLessonMarkdown — the pure
                                             markdown -> BlockList function
  src/block-identity.ts               new  sequence diff + similarity matching,
                                             shared-counter minting
  src/checksum.ts                     new  canonical JSON + SHA-256
  src/render.tsx                      new  BlockList -> React. The component
                                             P7 will import
  src/index.ts                             re-exports parser, identity, checksum
                                             (no React)
  test/blocks.spec.ts                 new  golden corpus: markdown -> block list
  test/block-identity.spec.ts         new  id stability cases
  test/checksum.spec.ts               new  reformat-invariance, word-change
  test/render.spec.tsx                new  numbering, no raw HTML
  test/isomorphic.spec.ts             new  parser imports nothing Node-only
  test/fixtures/*.md, *.json          new  the golden corpus itself

apps/api/
  src/content/lesson-content.controller.ts new PUT + GET
                                             /lessons/:lessonId/content
  src/content/lesson-content.service.ts new transaction, optimistic check,
                                             content_status and
                                             has_unpublished_changes
  src/auth/target-resolver.ts              + resolve the lesson target for the
                                             two new routes (R-01, R-02)
  src/app.module.ts                        + the new controller and provider
  test/lesson-content.e2e-spec.ts     new  save, reparse, conflict, RBAC
  test/rbac-matrix.spec.ts                 + rows for the two new routes

apps/admin-web/
  package.json                             + tailwindcss v4,
                                             @tailwindcss/postcss,
                                             @tailwindcss/typography,
                                             codemirror 6, turndown
  postcss.config.mjs                  new
  app/globals.css                     new  Tailwind entry + prose tokens
  app/courses/[courseId]/lessons/[lessonId]/page.tsx  new  the editor route
  components/editor/MarkdownEditor.tsx new CodeMirror 6 host
  components/editor/Toolbar.tsx       new
  components/editor/PreviewPane.tsx   new  renders packages/content/render
  components/editor/SaveStatus.tsx    new  saving / saved / retrying / conflict
  components/editor/StatusBar.tsx     new  blocks, words, reading time
  lib/useAutosave.ts                  new  3s debounce, backoff, 409/422 paths
  lib/usePasteAsMarkdown.ts           new  text/html -> markdown on paste
  e2e/authoring.spec.ts               new  the FR-EDIT-02 journey
```

**Key types** (exported from `packages/content`):

```ts
type BlockType =
  | 'heading' | 'paragraph' | 'list' | 'code'
  | 'figure'  | 'table'     | 'blockquote';

type Block = {
  blockId: string;        // 'b7' | 'fig8' | 'tbl9' — a mint sequence, NOT a number
  blockType: BlockType;
  markdown: string;       // exact source slice; the renderer renders this
  text: string;           // plain-text flattening; P4's narration input
  depth?: number;         // heading
  ordered?: boolean;      // list
  lang?: string | null;   // code
  figureNumber?: number;  // figure — 1-based, per lesson
  tableNumber?: number;   // table  — 1-based, per lesson, counted separately
  captionText?: string | null;         // table, from ::caption
  headers?: string[];                  // table
  rows?: string[][];                   // table
};

type BlockList = {
  blocks: Block[];
  nextBlockSeq: number;   // the shared counter, persisted with the draft
};

// The parser is pure: same inputs, same output, no clock and no randomness.
declare function parseLessonMarkdown(
  markdown: string,
  previous: BlockList | null,
): ParseResult;

type ParseResult =
  | { ok: true;  blockList: BlockList }
  | { ok: false; errors: Array<{ message: string; line: number; column: number }> };
```

`BlockList.blocks` is a superset of §6.1's shape: it adds `markdown` so the
renderer can render inline formatting without re-deriving it, and omits
`captionText`, `alternativeText` and `imageUrl` on figure blocks, which are
hydrated from `lesson_images` at read time by whichever consumer needs them.
`lessonTitle` is likewise absent, for the reason given above. The stored block
list stays a pure function of the markdown and the previous list, which is what
makes the checksum meaningful.

**Deviations from §6.1 and §9.3**

P2 adds two routes the locked API contract does not list, resolves two
ambiguities in §6.1, and declines to build one route §9.3 does list. None is an
oversight.

| Item | Status | Why |
|---|---|---|
| `GET /admin/lessons/:lessonId/content` | **added** | §9.3 lists the `PUT` but no way to load a draft into an editor |
| `PUT` body carries `expectedDraftUpdatedAt` | **added** | §9.3 names the route's purpose, not its body; without the field two admins silently overwrite each other |
| `blockId` minting | **resolved** | §6.1's prose says "a stable counter" (singular); its example implies three. One shared counter is used, so the numeral can never be mistaken for a figure number |
| Table `captionText` | **resolved** | §6.1 requires the field and §6.3's prompt depends on it; GFM has no caption syntax, so the `::caption[…]` leaf directive supplies one |
| `blockquote` as a block type | **added** | §5.3's supported list omits it, but it is standard markdown, trivially narratable, and its absence would be a validation error on ordinary prose |
| `Block.markdown` | **added** | §6.1's example shows only `text`; the renderer needs inline structure and re-deriving it from `text` is impossible |
| `lessonTitle` in the stored block list | **dropped** | §6.1's example includes it, but §6.3 passes it separately anyway, and storing it would make a rename invalidate every approved narration script |
| `GET /lessons/:lessonId/staleness` | **deferred** | §9.3 lists it; with no narration or audio row in existence it would report two constant nulls. P4 builds it |

## End-to-end verification

From a clean checkout, with Docker running:

```
docker compose up -d --wait
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm test
pnpm --filter @knowledge-explorer/admin-web exec playwright test
```

**Expected:** exit code `0` from both commands, with every suite green.

**1. The golden corpus** (`packages/content/test/blocks.spec.ts`) — no database,
no HTTP. Each fixture is a `.md` file and the `.json` block list it must
produce, so a parser change that alters output fails loudly rather than
silently:

- one fixture per block type, including a GFM table with a `::caption` and a
  fenced code block with a language;
- a document mixing all seven types, asserting document order is preserved and a
  whole list emits exactly one block;
- `::figure` emits a figure block; two figures number 1 and 2; a table and a
  figure number independently from 1;
- raw HTML, a `---` rule, a footnote definition and a `::caption` with no table
  below it each produce a validation error naming line and column, and **every**
  error is reported, not the first;
- the same input parsed twice returns byte-identical output;
- **the fixed point:** every fixture's stored markdown, reparsed against its own
  stored block list, reproduces that block list exactly — ids and counter
  included.

**2. Block identity** (`packages/content/test/block-identity.spec.ts`) — the
subtlest code in the phase, tested directly:

- retyping a paragraph's wording keeps its `blockId`;
- rewriting a paragraph beyond the similarity threshold mints a new one;
- inserting a paragraph between two others changes no existing `blockId` and
  mints exactly one;
- deleting a block and adding another does not reuse the retired id;
- swapping two paragraphs carries their ids with them;
- **inserting a figure above an existing one:** the pre-existing figure keeps its
  `blockId` and its `figureNumber` becomes 2, while the new figure takes
  `figureNumber` 1 and a higher-numbered id — the case that proves the id is a
  mint sequence and not a number.

**3. Checksums** (`packages/content/test/checksum.spec.ts`):

- reflowing a paragraph, adding a trailing space, and swapping `*` for `-` in a
  list each leave `draftContentChecksum` unchanged;
- changing a single word changes it;
- key order in the serialized block list does not affect the result.

**4. Isomorphism** (`packages/content/test/isomorphic.spec.ts`) — the parser's
transitive import graph contains no `node:` builtin, so the browser parse and
the server parse are provably the same code.

**5. Content API** (`apps/api/test/lesson-content.e2e-spec.ts`) — boots the API
against the migrated database:

- first save on a lesson with no `lesson_contents` row creates one, stores
  markdown, block list and checksum, and moves `content_status` `empty` →
  `drafting`;
- the stored block list equals what `packages/content` produces for that
  markdown — the server reparsed rather than trusting anything;
- a second save with a stale `expectedDraftUpdatedAt` returns `409`
  `LESSON_CONTENT_CONFLICT` and the current server content, and writes nothing;
- a save with byte-identical markdown returns `200` and does not advance
  `draft_updated_at`;
- a whitespace-only edit **is** persisted and advances `draft_updated_at`, while
  `draft_content_checksum` stays the same — the case that separates the two
  rules;
- a save containing raw HTML returns `422` `LESSON_CONTENT_INVALID` with every
  error's line and column, and writes nothing;
- on a `published` course, a save that changes the checksum sets
  `has_unpublished_changes`; a whitespace-only save and a no-op save do not;
- RBAC: an `admin` writing a lesson in a `published` course gets `403`
  `FORBIDDEN_COURSE_PUBLISHED`; an `admin` writing a lesson assigned to someone
  else gets `403` `FORBIDDEN_NOT_ASSIGNED`; the same admin writing an unassigned
  lesson succeeds; the owner succeeds in every case.

**6. Browser end-to-end** (`apps/admin-web/e2e/authoring.spec.ts`, Playwright,
extending P1's suite) — the journey that proves FR-EDIT-02's central claim, that
the preview and the stored block list can never disagree:

1. Sign in as the owner and open a lesson from the P1 curriculum tree.
2. Type a heading, two paragraphs, a `::figure`, and a `::caption` plus GFM
   table — using the toolbar's insert-table and insert-figure for the last two.
3. Wait for the save indicator to report saved, without clicking anything, and
   assert it landed within ~3 seconds of the last keystroke.
4. Assert the preview shows **Figure 1** and **Table 1** with its caption.
5. Reload the page and assert the markdown and the preview come back identical.
6. Place the cursor above the existing figure and insert a second `::figure`.
7. Assert the preview now shows the new figure as **Figure 1** and the original
   as **Figure 2**.
8. Read the persisted block list back through
   `GET /admin/lessons/:lessonId/content` and assert its `figureNumber` values
   match what the preview rendered, and that the original figure's `blockId` is
   unchanged from step 5.
9. Paste rich HTML into the editor and assert markdown is inserted and the save
   succeeds — the paste converter ran, and no raw HTML reached the parser.
10. Intercept `PUT /admin/lessons/*/content` with `page.route()` and abort it,
    type a character, and assert the unsaved-changes banner appears and a retry
    is attempted. Remove the interception and assert the save lands without any
    user action — proving the backoff loop recovers on its own. (Route
    interception rather than stopping the server, so the test does not fight
    Playwright's `webServer` lifecycle.)
11. Sign in as an `admin` in a second context, open a lesson belonging to a
    `published` course, and assert the editor is read-only with its explanatory
    banner and that no `PUT` is issued.

Steps 6–8 are the phase's load-bearing assertion. Steps 3 and 10 together
satisfy FR-EDIT-03.

**7. CI** — `.github/workflows/ci.yml` needs no new service; P1 already added
PostgreSQL, Redis and the Playwright step. The new suites run inside the
existing `pnpm test` and `playwright test` invocations.

## Open questions

None. Every decision this spec depends on was taken during the interview:
P1-first sequencing, CodeMirror 6, the `::figure` and `::caption` directives,
the preview-pane-only reading of FR-EDIT-05, sequence-diff block matching, the
pure-parse block list, the block-list checksum, optimistic concurrency, Tailwind
v4, `empty → drafting` only, deferring the staleness endpoint, the seven block
types, rejecting raw HTML and unsupported constructs, the shared React renderer,
browser-side preview parsing, the shared kind-prefixed counter, indefinite
save retry, and the four editor conveniences.

§14's four open decisions are untouched and none blocks P2.
