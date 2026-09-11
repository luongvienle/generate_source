# Workflows

Every command below was executed successfully in this session unless marked
`[declared]`.

## Development Workflow

1. `nvm use` — the shell must be on Node 22; `.nvmrc` pins it [verified].
2. `cp .env.example .env` and set `AUTH_SECRET` (`openssl rand -base64 32`)
   [verified]. `.env` is gitignored; `.env.example` is tracked.
3. `docker compose up -d --wait` — Postgres 16 and Redis 7, both with
   healthchecks; the flag blocks until healthy [verified].
4. `pnpm install` [verified].
5. `pnpm db:migrate` [verified].
6. Per app: `pnpm --filter @knowledge-explorer/api dev` (tsx watch),
   `... admin-web dev` / `... learner-web dev` (next dev) `[declared]` — the
   underlying `tsx src/main.ts` and `next start` were both run directly and
   worked [verified].

**Redis is on host port 6380, not 6379** — a native `redis-server` occupies
6379 on the development machine. The container's internal port is unchanged and
CI maps 6379 [verified].

## Build Workflow

`pnpm build` → `turbo run build`: **5 tasks green** [verified] — `next build`
for both web apps, `tsc --outDir dist` for `api` and `worker`, plus the
`db:generate` dependency. The five packages have no build step by design; they
are consumed as TypeScript source, which is why both Next apps set
`transpilePackages` [verified].

## Test Workflow

`pnpm test` → `turbo run test`: **128 tests across 4 workspaces, all passing**
[verified]. Requires Docker running and the migration applied — the database
and API suites talk to a real Postgres.

Single workspace: `pnpm --filter @knowledge-explorer/<name> test` [verified].

## Verification Workflow

The sequence from `specs/p0-foundation/spec.md`, run end to end this session
[verified]:

```
docker compose up -d --wait
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm exec turbo run typecheck lint test
```

Result: 13 turbo tasks successful, 128 tests passing, and `--frozen-lockfile`
confirms the lockfile is in sync [verified]. `lint` contributes nothing — it
matches no package script [verified].

`pnpm verify` (`typecheck && lint && test`) runs the same checks without the
Docker and migrate steps [verified].

CI runs the identical sequence against Postgres 16 and Redis 7 service
containers [verified in `.github/workflows/ci.yml`]. **The workflow has never
executed**: the repository has no git remote.

## Recommended Commands

| Task | Command | Tag |
|---|---|---|
| Start infrastructure | `docker compose up -d --wait` | [verified] |
| Install | `pnpm install --frozen-lockfile` | [verified] |
| Apply migrations | `pnpm db:migrate` | [verified] |
| Regenerate Prisma client | `pnpm db:generate` | [verified] |
| Typecheck everything | `pnpm typecheck` | [verified] |
| Build everything | `pnpm build` | [verified] |
| Test everything | `pnpm test` | [verified] |
| Full local check | `pnpm verify` | [verified] |
| Magic-link end-to-end | `./scripts/verify-magic-link.sh` | [verified] |
| Run the API | `pnpm --filter @knowledge-explorer/api dev` | [declared] |
| Run a web app | `pnpm --filter @knowledge-explorer/admin-web dev` | [declared] |
| Run the worker | `pnpm --filter @knowledge-explorer/worker start` | [declared] |

**Do not run `prisma migrate dev` against an edited schema without reading
`conventions.md` first** — it regenerates the initial migration and silently
discards hand-written SQL.

A stale `next start` survives `pkill -f "next start"` as a `next-server` child;
kill it by port (`lsof -ti:3000 | xargs kill`) or it serves an old build
[verified].

## Notes

