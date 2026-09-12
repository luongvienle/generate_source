# Plan: P2 — Authoring

**Spec:** `specs/p2-authoring/spec.md`
**Status:** Approved
**Date:** 2026-09-12

## Objective

Give admins a markdown editor that writes lesson bodies, and give every later
phase the contract it consumes from them — a stable `blockId`, a figure and
table number assigned exactly once, and a checksum that changes only when the
content a learner would notice changes.

## Approach

### A walking skeleton first, then thicken it

The phase decomposes naturally into three layers — a pure package, two API
endpoints, and a browser editor — and the tempting order is to build them in
that sequence. That is a horizontal plan, and it would put the first
end-to-end signal at roughly day six of nine.

Instead, slice A builds a deliberately thin path all the way through: a parser
that understands only paragraphs and headings, the real `PUT`/`GET` endpoints
storing a real block list, and the real editor route with a plain `textarea`
and the real shared renderer. It is small enough to finish in a day and it
proves the pipe — workspace resolution, Next transpilation, CORS, the guard
stack, JSONB round-tripping — before any of the interesting logic is written.
Slices B through E then thicken each layer in place. Nothing built in slice A is
thrown away; the `textarea` is replaced by CodeMirror in slice E and everything
else is added to.

Slices in order: **A** walking skeleton · **B** the full markdown dialect ·
**C** identity, numbering and checksums · **D** API semantics · **E** the real
editor · **F** verification.

### Eight decisions that came out of reading the code

Impact analysis changed or added the following. The first two are corrections
to the spec's own "Affected files" list.

1. **`apps/api/src/auth/target-resolver.ts` needs no change.** The spec lists it
   as modified. It already resolves `request.params['lessonId']` to a lesson,
   its chapter and its course's `publicationStatus`, which is exactly what
   `/lessons/:lessonId/content` needs. R-01 and R-02 work on the new routes the
   moment the routes exist.

2. **The §3 matrix needs no change either.** `writeLessonDraftContent` is
   already in `packages/shared/src/roles.ts` — `admin_owner: true, admin: true`
   — and no endpoint has ever declared it. P2 is its first consumer.

3. **`PublishedLockGuard` and `AssignmentGuard` do not distinguish reads from
   writes, so the `GET` must not sit behind them.** Both guards resolve a target
   from route params and refuse regardless of HTTP method. Today that is latent:
   the only `GET` under them is `/my-assignments`, which carries no `:lessonId`,
   so `resolve()` returns `undefined` and they stand aside. Put
   `GET /lessons/:lessonId/content` behind them and an `admin` could not *read*
   a lesson in a published course — which would make the spec's read-only
   editor banner impossible to render.

   **Decision:** the controller declares `SessionGuard, RolesGuard` only, and
   the `PUT` method adds `@UseGuards(PublishedLockGuard, AssignmentGuard)` of
   its own. NestJS aggregates controller and method guards, so the write keeps
   the full chain and the read does not. The shared guards are not touched —
   changing them would alter enforcement on every P1 route and is not this
   phase's to do.

4. **`GET /content` must return `canEdit` and `readOnlyReason`.** The spec
   requires the editor to render read-only with an explanatory banner when the
   server would refuse the write, and lists neither field. The alternative is
   re-deriving R-01 and R-02 in the browser from role, `publicationStatus` and
   `assignedAdminId` — a second implementation of the rules, in the one place
   the project has been careful never to put them. The server computes it and
   the client displays it; the `PUT` still refuses independently, so the UI
   carries no enforcement.

5. **SHA-256 cannot come from `node:crypto`.** The isomorphism constraint bans
   Node builtins, and `crypto.subtle.digest` is async, which would infect
   `parseLessonMarkdown` and every caller with a promise. Use
   `@noble/hashes/sha256` — pure JavaScript, synchronous, no builtins, and
   already the standard answer for this shape of problem.

6. **`packages/content` gets an `exports` map and keeps `main`/`types`.**
   `packages/shared/tsconfig.base.json` sets `moduleResolution: "node"`
   (node10), which ignores `exports`. That is survivable because nothing that
   resolves under node10 imports the subpath: `apps/api` imports only the root
   barrel, `apps/admin-web` already sets `moduleResolution: "bundler"`, and
   Vitest resolves through Vite. Keeping `main`/`types` preserves the root
   import for node10. The base tsconfig is not modified.

7. **`packages/content/tsconfig.json` needs a local `jsx` and DOM lib.** The
   base config has `lib: ["ES2022"]` and no `jsx`, so a `.tsx` file will not
   compile. Override locally with `"jsx": "react-jsx"` and
   `"lib": ["ES2022", "DOM"]`. Local override, no base change.

8. **The portal shell clamps to `72rem` (1152 px), below NFR-09's 1280 px.**
   `app/(portal)/layout.tsx` wraps every screen in a `maxWidth: '72rem'`
   container. A split editor inside it is 1152 px wide on a 1280 px screen. The
   editor route needs to escape the clamp — the layout gains a full-width
   variant rather than the route fighting it with negative margins.

### Parsing and rendering mechanics

- **`unified` + `remark-parse` + `remark-gfm` + `remark-directive`**, not the
  `remark` meta-package. Nothing ever stringifies an AST back to markdown, so
  `remark-stringify` is dead weight and its normalization would be a hazard.
- **`Block.markdown` is a source slice, not a re-serialization:**
  `source.slice(node.position.start.offset, node.position.end.offset)`. Exact by
  construction, with no round-trip fidelity question to answer.
- **The renderer re-parses `block.markdown`** with the same pipeline and maps
  mdast inline nodes to React elements. One parser, no stored inline AST, and no
  `dangerouslySetInnerHTML` anywhere. Table cells render the same way.
- **`text` is a walk of the node collecting `text` and `inlineCode` values.**
- **Raw HTML is detected across the whole tree, not just at top level** — mdast
  emits `html` nodes both as blocks and inline.

## Affected files

Paths marked **new** do not exist today.

| File | Change |
|---|---|
| `packages/shared/src/enums.ts` | **+** `blockTypes` / `blockTypeSchema` (7 members). `enumColumns` is untouched — see Risks, the spec's "stays at 16 rows" is off by one |
| `packages/shared/src/errors.ts` | **+** `LESSON_CONTENT_INVALID`, `LESSON_CONTENT_CONFLICT` |
| `packages/content/package.json` | **+** `unified`, `remark-parse`, `remark-gfm`, `remark-directive`, `@noble/hashes`; `react` as a **peer** dependency; `exports` map (`.` → `src/index.ts`, `./render` → `src/render.tsx`); `main`/`types` retained |
| `packages/content/tsconfig.json` | **+** `"jsx": "react-jsx"`, `"lib": ["ES2022", "DOM"]` |
| `packages/content/src/blocks.ts` | **New.** `parseLessonMarkdown(markdown, previous)` — AST walk, directive handling, validation, block construction |
| `packages/content/src/block-identity.ts` | **New.** LCS exact pass, Dice-trigram similarity pass, shared-counter minting, figure/table numbering |
| `packages/content/src/checksum.ts` | **New.** Canonical JSON + `@noble/hashes` SHA-256 |
| `packages/content/src/types.ts` | **New.** `Block`, `BlockList`, `ParseResult`, shared by parser and renderer |
| `packages/content/src/render.tsx` | **New.** `<LessonBody blocks={…} />` — the component P7 imports |
| `packages/content/src/index.ts` | **+** re-export blocks, identity, checksum, types. Stays React-free |
| `packages/content/test/*` | **New.** `blocks`, `block-identity`, `checksum`, `render`, `isomorphic` specs plus the `fixtures/` corpus |
| `apps/api/src/content/lesson-content.controller.ts` | **New.** `PUT` and `GET /lessons/:lessonId/content`; guards split by method per decision 3 |
| `apps/api/src/content/lesson-content.service.ts` | **New.** Reparse, optimistic check, no-op rule, `content_status`, `has_unpublished_changes`, `canEdit` — one transaction |
| `apps/api/src/app.module.ts` | **+** the controller and service |
| `apps/api/test/lesson-content.e2e-spec.ts` | **New.** The API suite from the spec's verification §5 |
| `apps/api/test/rbac.e2e-spec.ts` | **+** matrix rows for the two new routes |
| `apps/admin-web/package.json` | **+** `tailwindcss` v4, `@tailwindcss/postcss`, `@tailwindcss/typography`, CodeMirror 6 packages, `turndown`, `@types/turndown` |
| `apps/admin-web/postcss.config.mjs` | **New.** Tailwind v4 plugin |
| `apps/admin-web/app/globals.css` | **New.** `@import "tailwindcss"`, typography plugin, prose tokens |
| `apps/admin-web/app/layout.tsx` | **+** import `globals.css` |
| `apps/admin-web/app/(portal)/layout.tsx` | Width clamp becomes opt-out so the editor can use the viewport (decision 8); inline styles migrate to Tailwind |
| `apps/admin-web/app/(portal)/courses/[courseId]/lessons/[lessonId]/page.tsx` | **New.** Server component: resolves the lesson, renders the editor |
| `apps/admin-web/components/editor/*` | **New.** `MarkdownEditor`, `Toolbar`, `PreviewPane`, `SaveStatus`, `StatusBar`, `ReadOnlyBanner` |
| `apps/admin-web/lib/useAutosave.ts` | **New.** Debounce, backoff, 409/422 terminal states |
| `apps/admin-web/lib/paste-as-markdown.ts` | **New.** Turndown configured to emit no raw HTML |
| `apps/admin-web/lib/content-types.ts` | **New.** Request and response shapes for the two endpoints |
| `apps/admin-web/components/curriculum-tree.tsx` | **+** each lesson title links to its editor route |
| `apps/admin-web/e2e/helpers.ts` | **New.** `signIn` extracted from `import.spec.ts` for reuse |
| `apps/admin-web/e2e/import.spec.ts` | Imports `signIn` from the helper instead of defining it |
| `apps/admin-web/e2e/authoring.spec.ts` | **New.** The eleven-step browser journey |

**Not changed, despite the spec listing them:** `apps/api/src/auth/target-resolver.ts`
(decision 1) and `packages/shared/src/roles.ts` (decision 2).

## Risks

- **The similarity pass is the likeliest source of subtle wrongness.** A
  threshold that is too low steals ids between unrelated blocks; too high and
  ordinary edits orphan narration. *Mitigation:* the metric and threshold are
  fixed by the spec (Dice over character trigrams, > 0.6), the pass runs only on
  blocks the exact pass left unmatched, and `block-identity.spec.ts` pins all
  six named consequences plus both boundaries. Build it as a pure function over
  two arrays with no parser involvement, so it is testable in isolation.

- **`packages/content` accidentally becoming non-isomorphic.** A transitive
  dependency that reaches for `node:buffer` breaks browser preview silently —
  the server keeps working and only the editor dies. *Mitigation:*
  `isomorphic.spec.ts` walks the parser's transitive import graph and fails on
  any `node:` specifier. It runs in `pnpm test`, so regression is caught in CI
  rather than in a browser.

- **Adding `exports` to a package four workspaces already import.** A
  resolution mistake surfaces as a build failure in `apps/api`,
  `apps/admin-web`, or Vitest. *Mitigation:* it is the first task in slice A,
  and `pnpm typecheck && pnpm test` immediately afterwards is the canary.
  Keeping `main`/`types` means the root import path is unchanged for node10
  consumers.

- **Tailwind v4 must survive `next build`, not just `next dev`.** Playwright's
  `webServer` runs a production build, so a PostCSS misconfiguration fails the
  entire browser suite with an error that looks unrelated to CSS. *Mitigation:*
  slice E's first task ends with `pnpm --filter @knowledge-explorer/admin-web build`
  passing, before any editor component depends on it.

- **CodeMirror 6 under SSR.** It touches `document` at import time and will
  throw during prerender. *Mitigation:* the editor host is a `'use client'`
  component loaded with `next/dynamic` and `ssr: false`; the route's server
  component does the data fetch and renders it as a child.

- **The "persists within 3 seconds" assertion is a stopwatch, and stopwatches
  flake in CI.** *Mitigation:* the browser test asserts the *behavior* — the
  saved indicator appears with no click — under Playwright's normal expect
  timeout, and the 3-second debounce interval is asserted separately as a unit
  test over `useAutosave` with fake timers.

- **The spec says `enumColumns` "stays at 16 rows"; it is 17 today** (P1 added
  `job_status` to a list that already had 16). The substantive instruction is
  unaffected — `blockType` is a JSONB field, not a §8 column, so it gets a zod
  schema and does **not** join the catalogue. Flagged rather than silently
  reinterpreted.

- **Turndown's default is to pass unknown HTML through**, which would feed the
  parser exactly what it rejects. *Mitigation:* configure it with an explicit
  rule set for the seven supported constructs and a catch-all that emits the
  element's text content. A test asserts that pasting a `<div>`, a `<script>`
  and an `<iframe>` yields markdown the parser accepts.

- **P1 is complete as of this planning session** — all 23 tasks ticked, the
  portal shell, import screen, curriculum tree and Playwright harness all
  present on disk. The spec's hard precondition is satisfied. Noting it because
  the spec was written when it was not.

## Test strategy

**Unit, in `packages/content`** — no database, no HTTP, no browser:

- `blocks.spec.ts` drives a golden corpus of `fixtures/*.md` against
  `fixtures/*.json`. A parser change that alters output fails loudly instead of
  silently. Covers one fixture per block type, a mixed document, the two
  directives, the numbering rules, and every rejection case with its line and
  column — asserting that *all* errors are reported, not the first.
- `block-identity.spec.ts` tests the matching function directly on block arrays:
  retype, insert, delete, reorder, the similarity boundaries, and the case where
  a figure keeps `blockId: fig8` while its `figureNumber` becomes 2.
- `checksum.spec.ts` asserts reformat-invariance (three ways), word-change
  sensitivity, and key-order independence.
- `render.spec.tsx` asserts the rendered numbering matches the block list's and
  that no `dangerouslySetInnerHTML` appears in the output.
- `isomorphic.spec.ts` asserts the parser's import graph is free of `node:`
  specifiers.
- The **fixed-point** assertion runs over the whole corpus: reparsing each
  fixture's markdown against its own stored block list reproduces it byte for
  byte.

**Integration, in `apps/api`** — real database, real HTTP via supertest:

- `lesson-content.e2e-spec.ts` covers the spec's verification §5 in full: lazy
  row creation, `empty → drafting`, server-side reparse equality, the `409`
  conflict path, the byte-identical no-op, the whitespace-only edit that
  persists without changing the checksum, `422` with every error located,
  `has_unpublished_changes` on checksum change only, and the four RBAC outcomes.
- `rbac.e2e-spec.ts` gains rows for both new routes, extending P1's matrix.

**Browser, in `apps/admin-web`** — Playwright, outside `pnpm test`:

- `authoring.spec.ts` runs the spec's eleven-step journey. Steps 6–8 are the
  load-bearing assertion: insert a figure above an existing one, then confirm
  the preview's numbering and the numbering read back from
  `GET /content` agree, and that the original figure's `blockId` did not change.
  Step 10 uses `page.route()` to abort the `PUT`, asserts the unsaved banner and
  a retry, then unroutes and asserts recovery with no user action. Step 11 signs
  in a second context as an `admin` against a published course and asserts a
  read-only editor that issues no `PUT`.

**The full run**, from a clean checkout with Docker up:

```
docker compose up -d --wait
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm verify
pnpm --filter @knowledge-explorer/admin-web exec playwright test
```

`pnpm verify` is `typecheck && lint && test`; `lint` still matches no package
script and is a no-op, unchanged from P0 and P1. CI needs no new service —
PostgreSQL, Redis and the Playwright step all arrived with P1.

## Out of scope

The spec's non-goals stand in full and are not restated in detail here: images,
narration and audio; `GET /lessons/:lessonId/staleness`; the `ready` transition;
the published track; the full FR-EDIT-05 learner preview; structure editing;
edit history and rollback; soft locking, presence and collaborative editing;
`localStorage` draft recovery; cross-lesson search, bulk find-and-replace and
lesson duplication; writing `lessons.estimated_minutes`; a component library; a
linter; mobile layouts; deployment, object storage and CDN.

Added during planning:

- **No change to `PublishedLockGuard`, `AssignmentGuard` or
  `WriteTargetResolver`.** Making the shared guards method-aware is arguably
  more correct — both are named and documented for writes — but it changes
  enforcement on every P1 route. P2 routes around it at the method level and
  leaves the question for whoever needs it.
- **No change to `packages/shared/tsconfig.base.json`.** Moving the monorepo to
  `moduleResolution: "bundler"` or `"nodenext"` would be the tidier fix for
  decision 6 and is a repository-wide change with no spec behind it.
- **No `remark-stringify` and no markdown formatter.** Nothing serializes an AST
  back to markdown; the editor's text is the source of truth.
- **`apps/learner-web` is untouched.** It stays the P0 shell. The renderer is
  built so P7 can import it, and P7 imports it.
