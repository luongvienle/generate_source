---
generated_at: 2026-09-12
commit: cae5a036bfd7b43ac478d05c5d1929130e3c5f30
generator_version: 0.6.0
project_name: create_source
---

# Project Harness Index

Knowledge Explorer is a course platform — admin-authored lessons with AI
illustrations, LLM narration and TTS audio, sold as time-limited access. The
repository is a **pnpm + Turborepo monorepo of ten workspaces** (four apps,
six packages) on TypeScript and PostgreSQL [verified]. The sixth package,
`packages/storage`, is a deliberate addition beyond §11's five-package layout:
§11 names private object storage as infrastructure but assigns it to no package,
and the AWS SDK cannot live in `packages/shared`, which the browser reaches
through `packages/content`. Recorded in `specs/p3-images/spec.md` [verified]. Phase P0 of the
product spec is complete: the §8 database schema, Auth.js magic-link sign-in
with database sessions, and the §3 permission matrix enforced by a
deny-by-default guard chain in `apps/api` [verified]. P1 (curriculum import), P2 (the lesson
editor and block parser) and P3 (images) are complete [verified]. Everything
from P4 onward — narration, audio, publishing, the learner app and commerce —
is unbuilt; those tables exist and no code reads them. Two documents govern the work and outrank anything inferred
from code: `knowledge-explorer-spec.md` (the locked product spec) and the
per-phase `specs/` directories.

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

The three `[assumed]` items in the previous harness — implementation language,
runtime and workspace tool — are now `[verified]` facts. What remains:

**Assumptions**

- **The four apps are intended as separately deployed services** `[assumed]` —
  basis: each has its own manifest and build output, and §11 lists them as four
  applications. No deployment configuration exists anywhere in the repository
  to confirm it, and deployment is an explicit P0 non-goal.
- **`packages/ai`, `packages/commerce` and `packages/content` are placeholders
  for the responsibilities §11 assigns them** `[assumed]` — basis: their names
  match §11's descriptions exactly, and each contains a 0-byte `src/index.ts`
  [verified]. Nothing in code states their intended contents.
- **PostgreSQL 16, Redis 7 and MinIO are the production targets** `[assumed]` —
  basis: `docker-compose.yml` pins all three and `.github/workflows/ci.yml`
  provides the first two as services and MinIO as an explicit `docker run` step
  [verified]. No production environment configuration exists. MinIO comes from
  quay.io because Docker Hub denies `minio/minio` to unauthenticated clients
  [verified], and it cannot be a GitHub Actions service container because that
  syntax cannot supply the `server /data` command [verified].
- **Test files are placed in a per-workspace `test/` directory** `[assumed]` —
  basis: all nine test files follow it [verified], but no lint rule or config
  enforces it.

**Unknown — tooling**

- Linters. No configuration exists, and `turbo run lint` matched no package
  script and emitted "No tasks were executed" [verified]. The task is wired
  into CI so adopting a linter needs no workflow change.
- Formatters. No Prettier, Biome or `.editorconfig` [verified via detect.sh
  `tool_configs` being empty].
- Static analysis beyond the TypeScript compiler. `strict` is on, with
  `noUncheckedIndexedAccess`, `noImplicitOverride` and
  `noFallthroughCasesInSwitch` [verified] — nothing further is configured.
- Security scanners. No scanner config, no dependency-audit step in CI
  [verified].

**Unknown — process and environment**

- Whether CI passes. `.github/workflows/ci.yml` exists and the same four
  commands pass locally [verified], but the repository has no git remote, so
  the job has never run.
- Production deployment, hosting, object storage and CDN — P0 non-goals; no
  configuration exists.
- The transactional email provider. Delivery is dev-mode logging in both
  `apps/api` and `apps/admin-web` [verified]; §7.5's provider choice is open
  and owned by P8.

**Unknown — specification gaps that will block later phases**

- ~~`generation_jobs.job_status` has no allowed values.~~ **Resolved by P1**:
  `queued`, `running`, `succeeded`, `failed`, declared in
  `packages/shared/src/enums.ts` with a comment recording that §8.1 catalogues
  no row for it [verified].
- R-02's scope. §3 phrases it as "courses where they are assigned", but §8
  defines `assigned_admin_id` only on `chapters` and `lessons` and no
  course-level column exists [verified]. Enforcement is row-level by an
  explicit decision recorded in `assignment.guard.ts`; whether an unassigned
  lesson should inherit its chapter's assignment is undecided.
- The payment gateway — §14 names it as the only open decision blocking P8.

## Notes

