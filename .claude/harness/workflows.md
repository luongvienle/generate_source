# Workflows

No manifest, Makefile, task runner or CI configuration exists in this repository
[verified], so **no workflow command can be derived from project config**. The
spec describes development *phases*, not commands.

## Development Workflow

`Unknown`. There is nothing to install, run or serve — the repository contains
only a specification document [verified].

The declared first step is spec §12 phase **P0 — Foundation**: "Monorepo, Docker
Compose, Prisma, Auth.js, three-role RBAC, CI", estimated at 1 week `[declared]`.
Until P0 lands, the development workflow is authoring and revising
`knowledge-explorer-spec.md`.

## Build Workflow

`Unknown`. No build tool, build script or build output is defined [verified].

## Test Workflow

`Unknown`. No test framework is configured and no test file exists [verified].
See `tools.md` for the tests the spec mandates without naming a runner.

## Verification Workflow

`Unknown`. No CI configuration exists [verified]; CI is listed only as a phase
P0 deliverable `[declared]` (§12), with no provider, pipeline or check sequence
specified.

Spec-level verification gates that any future pipeline should encode
`[declared]`:

- The **publish checklist** (§5.7, FR-PUB-01) must pass before a course can be
  published: every non-deleted lesson has content, no lesson is `empty`, every
  figure has a selected image with caption and alt text, no script or audio is
  `stale` or `failed`, at least 3 chapters with at least 2 lessons each, a
  category and cover image are set, and a paid course has an active product.
- Narration output validation (§6.3): reject and retry when segment count,
  `blockId` set, or ordering differs from the input block list.

## Recommended Commands

| Task | Command | Tag |
|---|---|---|
| Install dependencies | `Unknown` — no manifest or lockfile | — |
| Run development server | `Unknown` — no application code | — |
| Build | `Unknown` — no build system | — |
| Lint | `Unknown` — no linter configured | — |
| Format | `Unknown` — no formatter configured | — |
| Typecheck | `Unknown` — no TypeScript config | — |
| Test | `Unknown` — no test framework configured | — |
| CI verification | `Unknown` — no CI configuration | — |

Nothing in this repository is executable, so no command could be promoted from
`[declared]` to `[verified]` by running it.

## Notes

