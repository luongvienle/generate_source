# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Knowledge Explorer: a course platform where an owner imports a curriculum outline, admins
author lesson bodies by hand, AI fills in illustrations / narration / audio, and learners buy
time-limited access. pnpm + Turborepo monorepo, TypeScript, PostgreSQL, NestJS, Next.js.

**Two documents outrank anything inferred from code:**

- `knowledge-explorer-spec.md` — the locked product spec (all decisions final except §14).
  Source comments cite it by section (`§8.1`) and requirement id (`FR-EDIT-02`, `R-01`, `NFR-03`).
- `specs/p{N}-*/{spec,plan,tasks}.md` — one directory per implementation phase. `tasks.md` is
  **durable progress state**: tick boxes as work completes, not at the end.

Phases P0 (auth/schema), P1 (curriculum import), P2 (authoring/blocks), P3 (images),
P4 (narration) and P5 (audio) are done. P6 onward (publishing, learner app, commerce) is
unbuilt — those tables exist in the schema and no code reads them. `.claude/harness/` holds a
longer generated reference.

## Commands

**Node 22 is mandatory.** `nvm use` first. Under Node 20 vitest dies with a rolldown native
binding error that looks nothing like a version problem.

**ffmpeg is mandatory since P5**, and provides both `ffmpeg` and `ffprobe`. `apps/worker`
probes for them at boot and refuses to start without either, so the browser suite and any api
test that spawns the worker fail with "worker exited early" on a machine that lacks them. The
audio merge decodes and re-encodes every segment, and the fake TTS provider generates its tones
with them.

```bash
docker compose up -d --wait      # Postgres 5432, Redis 6380, MinIO 9010/9011
cp .env.example .env             # then set AUTH_SECRET (openssl rand -base64 32)
pnpm install
pnpm db:migrate                  # prisma migrate deploy
```

Host ports deliberately differ from CI (Redis 6380, MinIO 9010) because a native redis-server
and php-fpm hold 6379/9000 on the dev machine. Container-internal ports are unchanged.

```bash
pnpm verify                      # typecheck + lint + test — the pre-commit check
pnpm typecheck | pnpm build | pnpm test
```

`pnpm lint` matches no package script and does nothing; no linter or formatter is configured.
The TypeScript compiler in strict mode is the only static analysis.

### Tests

`pnpm test` needs Docker up and the migration applied — most suites cross real HTTP, Postgres
and MinIO, and some spawn `apps/worker` as a child process.

```bash
pnpm --filter @knowledge-explorer/api test                      # one workspace
pnpm --filter @knowledge-explorer/api test rbac                 # files matching a pattern
pnpm --filter @knowledge-explorer/shared test roles -t "denies" # single test by name
pnpm --filter @knowledge-explorer/admin-web test:e2e            # Playwright, NOT in turbo test
./scripts/verify-magic-link.sh                                  # needs a live admin-web
```

The browser suite is excluded from `turbo run test` on purpose (its script is `test:e2e`), so
the rest stays runnable without browsers. It owns the api and admin-web processes via
`webServer` and spawns the worker in `global-setup.ts`, waiting on the log prefix `Worker ready.`

Three tests cost money, all in `packages/ai/test/`: `openai-image.live.spec.ts` and
`openai-tts.live.spec.ts` skip unless `OPENAI_API_KEY` is set, and
`anthropic-narration.live.spec.ts` unless `ANTHROPIC_API_KEY` is. Run each by hand when its
pinned model changes. The narration one is the only evidence that a real model satisfies §6.3's
one-segment-per-block-in-order constraint, and the TTS one the only evidence that the pinned
speech model and voice exist and speak `vi`; the fakes cannot tell you either.

### Running apps

```bash
pnpm --filter @knowledge-explorer/api dev          # :3001, global prefix /api, /health unprefixed
pnpm --filter @knowledge-explorer/admin-web dev    # :3000, hosts Auth.js
pnpm --filter @knowledge-explorer/worker start     # no port; consumes the queues
```

A stale `next start` survives `pkill -f "next start"` as a `next-server` child — kill by port
(`lsof -ti:3000 | xargs kill`) or it serves an old build.

## Architecture

Four apps (`api`, `worker`, `admin-web`, `learner-web`) over six packages (`shared`, `database`,
`content`, `storage`, `ai`, `commerce`), all scoped `@knowledge-explorer/*`. Dependency direction
is one-way: no package imports an app, and api and worker never import each other. Packages ship
TypeScript source with no build step, which is why both Next apps set `transpilePackages`.

### Authorization: one matrix, one guard chain

`packages/shared/src/roles.ts` holds §3 as data and is the only place a role decision is recorded.
Endpoints declare an *action*, never a role: `@RequirePermission('writeLessonDraftContent')`.
Everything is deny-by-default — an endpoint with no declaration is refused outright.

```
SessionGuard        discards any caller-supplied identity, then resolves the user from the
                    sessions table on EVERY request (FR-AUTH-01: disabling an admin must block
                    the next call). Auth.js in admin-web mints sessions; the API only reads them.
RolesGuard          §3 matrix via isAllowed(action, role)
OwnerFieldGuard     @OwnerOnlyFields(...) — refuses the whole request so a mixed body writes
                    neither field (e.g. admin sending { title, assignedAdminId })
PublishedLockGuard  R-01: non-owner writing a published course → 403
AssignmentGuard     R-02: admin writing a row assigned to someone else → 403
```

### Background jobs

Queue names, attempt/backoff limits and job payload types live once in
`packages/shared/src/queues.ts`. Producers are `apps/api/src/jobs/*.queue.ts`; consumers are
`apps/worker/src/jobs/`. `withJobLifecycle` wraps every handler in the `generation_jobs` state
machine (`queued → running → succeeded|failed`); a job with no `generationJobId` in its payload
writes no row (import dry runs, FR-IMP-02). BullMQ ids are a per-queue counter, so image job ids
are qualified `image:<n>`. Progress reaches the browser over SSE: `jobs.controller.ts` for one
job, `course-stream.controller.ts` for every durable job on a course.

Adding a producer means adding its `job_type` row to `apps/api/src/jobs/job-permissions.ts` —
that map is partial and deny-by-default, so forgetting fails closed rather than leaking.

### Content pipeline

`packages/content` parses lesson markdown into §6.1 blocks. Three things compose:

1. **Stable ids** (`block-identity.ts`) — an LCS diff on (type, normalized text), then a
   Sørensen–Dice trigram pass above `SIMILARITY_THRESHOLD`, so an edited paragraph keeps its
   `blockId` and its approved narration segment. Ids come from one shared counter and the numeral
   is a mint sequence, never a figure number (`fig8` can be Figure 1).
2. **Checksum** (`checksum.ts`) — canonical JSON over a *semantic projection* only: raw
   `markdown` and `nextBlockSeq` are excluded, text is whitespace-normalized. This is the head of
   the §6.5 staleness chain, so what it hashes decides what costs an admin a regeneration.
3. **Isomorphism** — the same parser runs in the browser preview and on the server save. A Node
   builtin or non-allowlisted dependency breaks only the preview, silently; `test/isomorphic.spec.ts`
   walks the import graph and fails the build instead.

The editor drawer resolves figures by **figure number**, not by the preview's locally-parsed
blockIds, which are display-only. Known defect, asserted in the browser suite: deleting a figure
above an illustrated one orphans the illustration (the image is never destroyed, just unreachable).

### Ports and adapters

§11's provider interfaces, bound through Symbol tokens: `EmailProvider` (logs to stdout),
`ImageGenerationProvider` (`packages/ai`, OpenAI adapter + deterministic fake chosen by
`IMAGE_PROVIDER`; `openai` without a key throws rather than downgrading), `ObjectStorage`
(`packages/storage`, S3/MinIO, bucket created lazily). `LlmProvider` (P4), `TextToSpeechProvider`
(P5) and `PaymentProvider` (P8) do not exist yet.

## Invariants that fail silently

1. **Never regenerate `packages/database/prisma/migrations/20260911180121_init/migration.sql`.**
   Six partial unique indexes, one partial index and two CHECK constraints are hand-appended below
   the generated section — Prisma cannot express them, `prisma migrate dev` would drop them, and
   `prisma migrate diff` reports "No difference detected" either way. Add a new migration instead.
   `packages/database/test/constraints.spec.ts` is the only guard.
2. **`UndeclaredPolicyFixtureController` must keep declaring no permission** — it holds
   deny-by-default under permanent test and must always return 403 `FORBIDDEN_NO_POLICY`.
3. **Invitation tokens hash as `sha256(token + AUTH_SECRET)`**, matching Auth.js. Drift makes
   API-minted links silently unconsumable; `scripts/verify-magic-link.sh` asserts it. Re-run it
   after any next-auth upgrade (it is a pinned beta).
4. **`emitDecoratorMetadata` is `false` on purpose** — esbuild (tsx, vitest) does not emit it.
   Nest injection is always explicit `@Inject(Token)`. Do not turn it on and drop the tokens.
5. **`S3_ENDPOINT` and `S3_PUBLIC_ENDPOINT` are two variables.** A presigned URL's signature
   covers the host; signing against an internal hostname fails in a browser with an opaque
   `SignatureDoesNotMatch`. They coincide locally only because nothing runs inside Compose.
6. **Prisma and next-auth versions are pinned exactly** (7.10.0 / 5.0.0-beta.32); upgrading
   either needs review.

## Conventions

- Database columns `snake_case`, TypeScript and JSON `camelCase`, bridged by `@map`/`@@map`.
- Enum-like columns are `String`, never a Prisma `enum`; members live once in
  `packages/shared/src/enums.ts` as zod schemas. Money is `Decimal(12,2)`; timestamps
  `Timestamptz(6)`; `ON DELETE NoAction` is written explicitly where §8 omits it.
- Every error carries a machine-readable `errorCode` from `packages/shared/src/errors.ts`.
- Request bodies are validated with zod `strictObject` in the controller.
- Comments cite spec sections and requirement ids rather than restating rules in prose, and
  record *why* — including rejected alternatives and known gaps.
- Tests live in a per-workspace `test/` directory, never beside the source. `*.spec.ts`, with
  `*.e2e-spec.ts` for suites that boot an app (both globs are listed explicitly in the api and
  admin-web vitest configs — the default glob silently skips the second, and a file that never
  runs looks exactly like a passing one). Those two configs also set `fileParallelism: false`
  because their suites share one database.
- Commits: imperative capitalised subject, no `feat:`/`fix:` prefix, no trailing period; a body
  explaining why for anything non-trivial; grouped into coherent slices, not one commit per file;
  ending with the `Co-Authored-By:` trailer.
