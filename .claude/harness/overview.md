# Project Overview

## Languages & Runtime

- **TypeScript 5.9.3** [verified] — pinned exactly in the root manifest and used
  by all nine workspaces; 52 source files [verified via detect.sh].
- **Node.js `>=22.0.0 <23.0.0`** [verified] — pinned in root `engines` and
  `.nvmrc` (`22`). Everything in this harness was executed on **v22.23.2**
  [verified].
- **SQL (PostgreSQL)** [verified] — one migration of 539 lines at
  `packages/database/prisma/migrations/20260911180121_init/migration.sql`.
- **TSX/JSX** [verified] — `apps/admin-web` and `apps/learner-web` App Router
  components.

Note: the developer's login shell resolves Node 20 unless nvm is activated;
`.nvmrc` pins 22 but `engine-strict` is not enabled, so an install on the wrong
major warns rather than fails.

## Frameworks

| Framework | Version | Where | Evidence |
|---|---|---|---|
| NestJS | `@nestjs/core ^12.0.1` | `apps/api`, `apps/worker` | [verified] manifest |
| Next.js | `^16.3.5` | `apps/admin-web`, `apps/learner-web` | [verified] manifest |
| React | `^19.3.0` | both web apps | [verified] manifest |
| Prisma | `7.10.0` exactly, CLI and client in lockstep | `packages/database` | [verified] manifest |
| Auth.js | `next-auth 5.0.0-beta.32` + `@auth/prisma-adapter 2.11.3`, both exact | `apps/admin-web` | [verified] manifest |
| zod | `^4.6.2` | `packages/shared`, `apps/api` | [verified] manifest |
| ioredis | `^6.0.0` | `apps/worker` | [verified] manifest |
| Vitest | `^5.0.0` | shared, database, api, admin-web | [verified] manifest |

Two versions are deliberately exact rather than ranged, and upgrading either
needs review: **Prisma**, because the `latest` dist-tag points at
`8.0.0-rc.13`, and **next-auth**, because v5 is still a beta whose API changes
between releases [verified].

Not yet present, though §11 declares them: BullMQ, ffmpeg, and the
`LlmProvider`, `ImageGenerationProvider`, `TextToSpeechProvider` and
`PaymentProvider` interfaces. Only `EmailProvider` exists [verified].

## Build System & Package Manager

- **pnpm 10.33.4** [verified] — pinned via the root `packageManager` field, with
  `pnpm-lock.yaml` committed. `pnpm install --frozen-lockfile` succeeds
  [verified].
- **Turborepo `^2.10.12`** [verified] — `turbo.json` defines `build`,
  `typecheck`, `lint`, `test` and `db:generate`. `db:generate` is `cache: false`
  and is declared a dependency of `build`, `typecheck` and `test`, so the Prisma
  client always exists before anything compiles [verified].
- Build outputs: `dist/**` for the Nest apps, `.next/**` (excluding
  `.next/cache`) for the web apps [verified in `turbo.json`]. Both are
  gitignored.
- Caching works: a repeat `turbo run typecheck` reported every task cached
  [verified].

## Repository Layout

A **pnpm workspace monorepo** [verified — `pnpm-workspace.yaml` and `turbo.json`
detected]. Nine workspaces under the `@knowledge-explorer/*` scope:

| Workspace | Purpose | State |
|---|---|---|
| `apps/api` | NestJS HTTP API: admin endpoints and the authorization chain | 17 source files, 3 test files [verified] |
| `apps/admin-web` | Next.js owner/admin portal; hosts Auth.js | Sign-in only; 1 test file [verified] |
| `apps/learner-web` | Next.js catalog and learning app | Shell: layout + one page, no tests [verified] |
| `apps/worker` | NestJS standalone context, Redis connected | No queues registered [verified] |
| `packages/shared` | §8.1 enums, the §3 permission matrix, error codes | 4 source, 3 test files [verified] |
| `packages/database` | Prisma schema, migration, client factory | 4 source, 3 test files [verified] |
| `packages/content` | Markdown parsing and block extraction (§11) | Empty: 0-byte `src/index.ts` [verified] |
| `packages/ai` | LLM, image and TTS providers (§11) | Empty: 0-byte `src/index.ts` [verified] |
| `packages/commerce` | Payment and entitlement (§11) | Empty: 0-byte `src/index.ts` [verified] |

Root files: `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`,
`turbo.json`, `docker-compose.yml`, `.env.example`, `.nvmrc`, `.gitignore`,
`.github/workflows/ci.yml`, `scripts/verify-magic-link.sh`,
`knowledge-explorer-spec.md`, and `specs/p0-foundation/` [verified].

No submodules and no nested repositories [verified].

## Notes

