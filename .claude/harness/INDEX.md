---
generated_at: 2026-09-12
commit: unavailable
generator_version: 0.6.0
project_name: create_source
---

# Project Harness Index

This repository is a **specification-only project**: it contains one document,
`knowledge-explorer-spec.md` (1075 lines), and no source code, manifest,
lockfile, or CI configuration [verified]. The document specifies "Knowledge
Explorer", a course platform with admin-authored lessons, AI-generated
illustrations, LLM narration scripts and TTS audio, plus time-limited paid
access [verified]. Every stack, tooling and workflow fact below is either
`[declared]` by that spec as a *plan* or `Unknown` — nothing is installed or
runnable yet [verified]. Treat the spec as the source of truth for intent, and
this harness as a map of what exists versus what is merely intended.

## Contents

| File | What it contains |
|---|---|
| `overview.md` | Languages, frameworks, runtime, package manager, build system, repo shape |
| `architecture.md` | Identified pattern(s) with evidence, important directories, data flow |
| `tools.md` | Linters, formatters, test frameworks, static analysis, security scanners |
| `workflows.md` | Development, build, test, and verification workflows; recommended commands |
| `conventions.md` | Coding standards actually found in the project |

## How to consume this harness

1. Read this file first; load only the additional files you need.
2. Trust `[verified]`; re-check `[declared]` before relying on it; treat `[assumed]` as hypothesis.
3. `Unknown` means the generator could not determine it — do not guess a value.

## Risks & Assumptions

**Assumptions**

- **TypeScript is the implementation language** `[assumed]` — basis: spec §7.3
  contains TypeScript function signatures (`function isGrantActive(grant:
  AccessGrant, now: Date): boolean`) and §11 names Next.js, NestJS, Prisma and
  BullMQ, all TypeScript-first. No `tsconfig.json`, manifest or `.ts` file
  exists to confirm it [verified].
- **The `/apps` + `/packages` layout in spec §11 implies a workspace-based
  monorepo tool** (npm/pnpm/yarn workspaces, Nx or Turborepo) `[assumed]` —
  basis: ecosystem convention for that layout. The spec names no tool and no
  manifest exists [verified].
- **Node.js is the runtime** `[assumed]` — basis: Next.js, NestJS and BullMQ
  are Node-only. No `engines` field or version file exists [verified].

**Unknown — infrastructure and tooling**

- Runtime and its version — no manifest, no `.nvmrc`, no `engines` field.
- Package manager — no lockfile of any kind detected.
- Build system and build outputs — no manifest, no Makefile, no build config.
- Monorepo tool — no `pnpm-workspace.yaml`, `nx.json`, `turbo.json`, or
  workspaces field.
- Linters, formatters, static analysis, security scanners — no tool config
  files detected.
- Test frameworks — none configured, though spec §7.4 and §7.3 (E-01) mandate
  specific regression and unit tests `[declared]`.
- CI provider and pipeline — no `.github/`, `.gitlab-ci.yml`, or equivalent.
- Development, build, test and verification workflows, and every recommended
  command — nothing declared in project config; spec §12 phase P0 lists "CI"
  only as a deliverable `[declared]`.
- Application entry points — no source files exist.

**Unknown — repository and process**

- Commit conventions — this is not a git repository, so `commit: unavailable`
  and there is no history to derive style from [verified].
- The companion document `knowledge-explorer-design.md` (Vietnamese),
  referenced in the spec header, is **not present in this repository**
  [verified]. Its rationale content is therefore unavailable to consumers of
  this harness.
- Whether `.claude/harness/` should be version-controlled — undecidable here,
  as the project is not under git [verified].

**Unknown — product decisions the spec leaves open (§14)**

- Payment gateway — the spec states this is the only open item blocking phase
  P8 `[declared]`.
- Grace period length (`gracePeriodDays` defaults to 0) `[declared]`.
- Number of free-preview lessons per course `[declared]`.
- Whether the chosen TTS provider supports SSML marks with returned
  timepoints, which would remove the ffmpeg dependency `[declared]`.

## Notes

