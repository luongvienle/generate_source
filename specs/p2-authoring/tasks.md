# Tasks: P2 — Authoring

**Plan:** `specs/p2-authoring/plan.md`
**Spec:** `specs/p2-authoring/spec.md`

Ordered. Tick boxes as tasks complete — this file is the durable progress state
and is the thing that survives a lost session, so update it as you go rather
than at the end.

Slices A–F follow the plan. Slice A is a walking skeleton: finish it and the
whole pipe works end to end on two block types, before any of the interesting
logic exists.

---

## Slice A — Walking skeleton

- [x] **Task 1: `packages/content` wiring — dependencies, exports, tsconfig**
  Add `unified`, `remark-parse`, `remark-gfm`, `remark-directive` and
  `@noble/hashes`; add `react` as a **peerDependency** (not a dependency); add
  an `exports` map with `"."` → `src/index.ts` and `"./render"` →
  `src/render.tsx`, keeping `main` and `types` so node10 consumers still resolve
  the root. Add `"jsx": "react-jsx"` and `"lib": ["ES2022", "DOM"]` to
  `packages/content/tsconfig.json`. Create `src/render.tsx` as a stub that
  renders nothing, so the subpath resolves.
  - done when: `pnpm install` succeeds and `pnpm typecheck && pnpm test` passes
    repo-wide — proving the `exports` map broke no existing importer.

- [x] **Task 2: `blockType` enum and the two error codes**
  Add `blockTypes` and `blockTypeSchema` (7 members) to
  `packages/shared/src/enums.ts`. Do **not** add anything to `enumColumns` —
  `blockType` is a JSONB field, not a §8 column. Add `LESSON_CONTENT_INVALID`
  and `LESSON_CONTENT_CONFLICT` to `packages/shared/src/errors.ts`.
  - done when: `pnpm --filter @knowledge-explorer/shared test` passes with the
    §8.1 catalogue test unchanged in size, and a new assertion pins the seven
    block types.

- [x] **Task 3: Minimal parser — paragraphs and headings only**
  `src/types.ts` with `Block`, `BlockList`, `ParseResult`. `src/blocks.ts` with
  `parseLessonMarkdown(markdown, previous)` handling only `paragraph` and
  `heading`: source-slice `markdown`, flattened `text`, `depth`, and ids minted
  from a shared counter with no matching yet. Anything else is a validation
  error.
  - done when: `packages/content/test/blocks.spec.ts` passes two fixtures — a
    heading-plus-paragraph document, and a document containing a table that is
    rejected with a line and column.

- [x] **Task 4: Minimal renderer**
  `src/render.tsx` exports `<LessonBody blocks={…} />`, rendering heading and
  paragraph blocks by re-parsing each block's `markdown` and mapping inline
  mdast nodes to React elements. No `dangerouslySetInnerHTML`.
  - done when: `render.spec.tsx` renders a two-block list and asserts the
    heading level and the inline `<strong>` come through.

- [x] **Task 5: `PUT` and `GET /lessons/:lessonId/content`**
  New `lesson-content.controller.ts` and `lesson-content.service.ts`, registered
  in `app.module.ts`. Controller-level guards are `SessionGuard, RolesGuard`
  only; the `PUT` adds `@UseGuards(PublishedLockGuard, AssignmentGuard)` at
  method level (plan decision 3). Both declare
  `@RequirePermission('writeLessonDraftContent')`. `PUT` reparses server-side,
  creates the `lesson_contents` row lazily, stores markdown, block list and a
  placeholder checksum. `GET` returns the row, or an empty shape when there is
  none.
  - done when: a new `apps/api/test/lesson-content.e2e-spec.ts` asserts a first
    `PUT` creates the row and the following `GET` returns the same markdown and
    block list, and that an `admin` can `GET` a lesson in a **published** course
    while the matching `PUT` is refused with `FORBIDDEN_COURSE_PUBLISHED`.

- [x] **Task 6: Editor route and the link into it**
  `app/(portal)/courses/[courseId]/lessons/[lessonId]/page.tsx` as a server
  component fetching the lesson, plus a `'use client'` child with a plain
  `textarea` on the left and `<LessonBody>` on the right, saving on a button
  press for now. Link each lesson title in `components/curriculum-tree.tsx` to
  the route. Add `lib/content-types.ts` for the request and response shapes.
  - done when: in a browser, an owner clicks a lesson in the curriculum tree,
    types a heading and a paragraph, presses save, reloads, and sees both the
    text and the rendered preview come back. **The pipe works; slice A is
    finished.**

---

## Slice B — The full markdown dialect

- [x] **Task 7: The remaining five block types**
  Extend `blocks.ts` to `list`, `code`, `table`, `blockquote` and `figure`
  (directive handling lands in task 8). Per-type fields: `ordered`, `lang`,
  `headers`, `rows`. `text` is defined for every type — the caption or `''` for
  a table, `''` for a figure. A whole list is one block; a whole fence is one
  block.
  - done when: `blocks.spec.ts` has a fixture per type plus a mixed document
    asserting document order and that a three-item list emits exactly one block.

- [x] **Task 8: The `::figure` and `::caption` directives**
  Wire `remark-directive`. `::figure` alone on a line becomes a figure block.
  `::caption[…]` on the line immediately above a table attaches to that table's
  `captionText` and emits no block of its own.
  - done when: fixtures cover a figure, a captioned table, and a `::caption`
    with no table below it rejected with its line and column.

- [x] **Task 9: Validation — raw HTML, unmapped nodes, every error at once**
  Walk the **whole** tree for `html` nodes, block and inline. Reject any
  top-level node mapping to none of the seven types — `---`, footnote
  definitions, link reference definitions. Collect every error with line and
  column rather than throwing on the first.
  - done when: a fixture containing an inline `<b>`, a `---` and a footnote
    definition returns exactly three errors, each with the right line, and
    writes nothing.

- [x] **Task 10: The renderer covers all seven types**
  Tables render with number and caption above; `::figure` renders as a labelled
  empty slot reading "Figure *n*"; table cells re-parse their markdown inline.
  - done when: `render.spec.tsx` asserts a two-figure, one-table document
    renders "Figure 1", "Figure 2" and "Table 1" with its caption, and that the
    rendered numbers equal the block list's.

---

## Slice C — Identity, numbering, checksums

- [x] **Task 11: Shared counter and the exact matching pass**
  `src/block-identity.ts` as a pure function over `(previousBlocks, newBlocks)`
  — no parser involvement. Myers/LCS diff over `(blockType, normalized text)`,
  normalization collapsing whitespace runs and trimming. Matched blocks reuse
  their `blockId`; unmatched mint `b<n>`/`fig<n>`/`tbl<n>` from one shared
  counter that only ever advances.
  - done when: `block-identity.spec.ts` asserts inserting a paragraph in the
    middle changes no existing id and mints exactly one, reordering two
    paragraphs carries their ids, and a deleted block's id is never reissued.

- [x] **Task 12: The similarity pass**
  Blocks left unmatched on each side zip in document order; a same-type pair
  whose Sørensen–Dice coefficient over character trigrams of normalized text
  exceeds **0.6** is an edit and inherits the id.
  - done when: retyping a paragraph's wording keeps its `blockId`; rewriting it
    wholesale mints a new one; and both sides of the 0.6 boundary are pinned by
    a test.

- [x] **Task 13: Figure and table numbering**
  Assign `figureNumber` from 1 and `tableNumber` separately from 1, in document
  order, inside the parser and nowhere else.
  - done when: the test the spec names explicitly passes — inserting a figure
    above an existing one leaves the original's `blockId` untouched while its
    `figureNumber` becomes 2, and the new figure takes `figureNumber` 1 with a
    higher-numbered id. The id is a mint sequence, not a number.

- [x] **Task 14: Checksums**
  `src/checksum.ts`: canonical JSON over the block list — sorted keys, `blockId`
  in, `nextBlockSeq` out — hashed with `@noble/hashes/sha256`. Not
  `node:crypto`, not `crypto.subtle`.
  - done when: `checksum.spec.ts` asserts a reflowed paragraph, a trailing space
    and `*`→`-` in a list all leave the checksum unchanged, that changing one
    word changes it, and that key order does not affect it.

- [x] **Task 15: The fixed point and the isomorphism guard**
  Assert over the whole corpus that reparsing a fixture's markdown **against its
  own stored block list** reproduces that block list byte for byte, ids and
  counter included. Add `isomorphic.spec.ts` walking the parser's transitive
  import graph for `node:` specifiers.
  - done when: both suites pass, and temporarily importing `node:crypto` in
    `blocks.ts` makes `isomorphic.spec.ts` fail (check, then revert).

---

## Slice D — API semantics

- [x] **Task 16: Optimistic concurrency**
  `PUT` accepts `expectedDraftUpdatedAt`. A mismatch returns `409`
  `LESSON_CONTENT_CONFLICT` carrying the current markdown, checksum and
  `draftUpdatedAt`, and writes nothing. First save sends `null` and succeeds
  only when no row exists. Parse failure returns `422` `LESSON_CONTENT_INVALID`
  with every error's message, line and column.
  - done when: the e2e suite asserts the `409` body, that the stale write landed
    nothing, and that a `422` writes nothing.

- [x] **Task 17: The no-op rule, `content_status` and `has_unpublished_changes`**
  A byte-identical markdown save returns `200`, writes nothing and does not
  advance `draft_updated_at`. A whitespace-only edit **does** persist and
  advances `draft_updated_at` while the checksum is unchanged. First non-empty
  save moves `content_status` `empty` → `drafting`, and clearing the body never
  moves it back. On a `published` course, a save whose checksum changed sets
  `courses.has_unpublished_changes`; a whitespace-only or no-op save does not.
  All in one transaction.
  - done when: the e2e suite has a case for each of those six behaviors,
    including the whitespace-only edit that separates the two rules.

- [x] **Task 18: `canEdit` on `GET`, and the RBAC matrix rows**
  `GET` returns `canEdit` and `readOnlyReason`
  (`FORBIDDEN_COURSE_PUBLISHED` | `FORBIDDEN_NOT_ASSIGNED` | `null`), computed
  server-side from the same facts R-01 and R-02 use. Add rows for both new
  routes to `apps/api/test/rbac.e2e-spec.ts`.
  - done when: an `admin` reading an unassigned lesson gets `canEdit: true`; the
    same admin reading one assigned to someone else gets `canEdit: false` with
    `FORBIDDEN_NOT_ASSIGNED` **and** a `403` on the matching `PUT`; the owner
    gets `canEdit: true` in every case; and the RBAC matrix passes.

---

## Slice E — The real editor

- [x] **Task 19: Tailwind v4**
  Add `tailwindcss`, `@tailwindcss/postcss`, `@tailwindcss/typography`; create
  `postcss.config.mjs` and `app/globals.css`; import it from `app/layout.tsx`.
  Migrate `app/(portal)/layout.tsx` off inline styles and give it a full-width
  variant so the editor route escapes the `72rem` clamp (NFR-09 wants 1280 px).
  - done when: `pnpm --filter @knowledge-explorer/admin-web build` succeeds —
    the production build, not just `next dev`, because Playwright uses it — and
    the existing import and tree screens still render.

- [x] **Task 20: CodeMirror 6 and the split layout**
  Replace the `textarea` with a `'use client'` CodeMirror 6 host loaded via
  `next/dynamic` with `ssr: false` — markdown language, no SSR access to
  `document`. Two panes side by side; the preview pane parses in the browser
  with `packages/content`, debounced ~150 ms, and renders `<LessonBody>`.
  - done when: typing shows highlighted markdown on the left and live rendered
    output on the right with no page reload, and the production build still
    succeeds.

- [x] **Task 21: Autosave**
  `lib/useAutosave.ts`: 3-second debounce after the last keystroke, immediate
  save on blur, exponential backoff capped at 30 s retrying for as long as the
  tab is open, `409` and `422` both terminal. `SaveStatus` renders saving /
  saved-at / retrying-with-warning / conflict.
  - done when: a unit test with fake timers asserts the 3-second debounce, that
    backoff caps at 30 s, and that a `409` stops the loop. In the browser,
    typing and waiting persists with no click.

- [x] **Task 22: Toolbar, status bar, navigation guard**
  Toolbar: bold, italic, link, heading, inline code, bullet list, ordered list,
  block quote, insert-table (emits a GFM skeleton with a `::caption` line above
  it) and insert-figure (emits `::figure`). Status bar: block count, word count,
  estimated reading time. Prompt before unload when changes are unsaved or
  failed.
  - done when: insert-table then insert-figure produces markdown the parser
    accepts and the preview renders as Table 1 and Figure 1, and closing the tab
    mid-edit prompts.

- [x] **Task 23: Paste as markdown**
  `lib/paste-as-markdown.ts` using Turndown with an explicit rule set for the
  seven supported constructs and a catch-all emitting text content — never raw
  HTML, which the parser rejects.
  - done when: a unit test asserts that pasting HTML containing a `<div>`, a
    `<script>` and an `<iframe>` yields markdown `parseLessonMarkdown` accepts.

- [x] **Task 24: Read-only mode**
  When `canEdit` is false the editor renders read-only with a banner naming the
  reason in plain words. No `PUT` is attempted. The API refuses regardless — the
  UI carries no enforcement.
  - done when: an `admin` opening a lesson in a published course sees the banner
    and a read-only editor, and the network tab shows no `PUT`.

---

## Slice F — Verification

- [x] **Task 25: Extract the e2e sign-in helper**
  Move `signIn` out of `e2e/import.spec.ts` into `e2e/helpers.ts` and import it
  back. Pure refactor, no behavior change.
  - done when: `playwright test` passes the existing import suite unchanged.

- [x] **Task 26: The browser journey, steps 1–9**
  `e2e/authoring.spec.ts`: sign in as owner, open a lesson from the tree, use
  the toolbar to write a heading, two paragraphs, a `::figure` and a captioned
  table, wait for autosave with no click, assert Figure 1 and Table 1, reload
  and assert it all returns, insert a second figure **above** the first, assert
  the preview renumbers, then read `GET /content` back and assert its
  `figureNumber` values match the preview and the original figure's `blockId` is
  unchanged. Then paste rich HTML and assert the save succeeds.
  - done when: the spec passes. Steps 6–8 are the phase's load-bearing
    assertion — that the preview and the stored block list can never disagree.

- [x] **Task 27: The browser journey, steps 10–11**
  Abort `PUT /admin/lessons/*/content` with `page.route()`, type a character,
  assert the unsaved banner and a retry attempt; unroute and assert the save
  lands with no user action. Then sign in a second context as an `admin`,
  open a lesson in a published course, and assert a read-only editor issuing no
  `PUT`.
  - done when: both pass without stopping the API process — route interception
    only, so the test does not fight Playwright's `webServer` lifecycle.

- [x] **Task 28: Full verification run**
  From a clean checkout with Docker up: `docker compose up -d --wait`,
  `pnpm install --frozen-lockfile`, `pnpm db:migrate`, `pnpm verify`, then
  `pnpm --filter @knowledge-explorer/admin-web exec playwright test`. Confirm CI
  needs no new service.
  - done when: both commands exit `0` with every suite green, and
    `.github/workflows/ci.yml` is unchanged.
