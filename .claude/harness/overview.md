# Project Overview

## Languages & Runtime

- **No source code present** [verified] — `detect.sh` reports `source_files=0`;
  the repository contains exactly one content file, `knowledge-explorer-spec.md`,
  plus `.claude/settings.local.json`.
- **Markdown** is the only content format currently in the repository
  [verified] (`knowledge-explorer-spec.md`).
- **TypeScript** is the planned implementation language `[assumed]` — basis:
  spec §7.3 gives TypeScript function signatures and §11 names an all-TypeScript
  stack. No `tsconfig.json` or `.ts` file exists [verified].
- **SQL (PostgreSQL dialect)** — the full schema is written out as `CREATE TABLE`
  statements in spec §8 `[declared]`; no `.sql` file or migration directory
  exists in the repository [verified].
- Runtime and version: `Unknown` — no manifest, `engines` field, `.nvmrc` or
  equivalent [verified].

## Frameworks

No framework is installed [verified] — there is no manifest or lockfile. The
spec §11 declares the intended stack `[declared]`:

| Application | Declared stack | Role |
|---|---|---|
| `admin-web` | Next.js, client-heavy | Owner and admin portal |
| `learner-web` | Next.js with ISR | Catalog and learning |
| `api` | NestJS | Admin, public and payment modules |
| `worker` | NestJS with BullMQ | Image, script, audio, publish, reminder jobs |

Additional libraries named in the spec `[declared]`:

- **Prisma** — schema and client, in `/packages/database` (§11).
- **remark** — AST-based markdown parsing for block extraction; the spec
  explicitly forbids regular expressions for this (§6.1).
- **zod** — schemas in `/packages/shared` (§11).
- **Auth.js** — authentication, phase P0 deliverable (§12).
- **ffmpeg** — audio segment merging, required in the worker image (§6.4, §11).

Declared infrastructure dependencies: PostgreSQL, Redis, private object storage
with a CDN (§11) `[declared]`.

## Build System & Package Manager

`Unknown`. `detect.sh` found no manifests and no lockfiles [verified], so there
is no evidence identifying a package manager, build tool, or build output
location. The spec names no build tooling either.

## Repository Layout

**Current state** [verified]:

```
/
├── knowledge-explorer-spec.md    product specification v1, 1075 lines
└── .claude/
    ├── settings.local.json       enables the project-skills plugin
    └── harness/                  this harness
```

Single directory, no monorepo markers detected [verified]. Not a git repository
[verified]. No submodules or nested repositories [verified].

**Planned layout**, spec §11 `[declared]` — none of these paths exist yet
[verified]:

```
/apps
  /admin-web      Next.js owner and admin portal
  /learner-web    Next.js catalog and learning app
  /api            NestJS HTTP API
  /worker         NestJS + BullMQ background jobs
/packages
  /database       Prisma schema and client
  /content        markdown parser, block extraction, checksums
  /ai             LlmProvider, ImageGenerationProvider, TextToSpeechProvider
  /commerce       PaymentProvider, entitlement resolution
  /shared         types, enums, zod schemas
/docs
  import-schema.json
  owner-prompt-template.md
```

## Notes

