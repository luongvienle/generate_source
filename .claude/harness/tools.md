# Development Tools

## Linters

`Unknown`. No linter is configured in any workspace: `detect.sh` reports an
empty `tool_configs` set, no workspace declares a `lint` script, and
`turbo run lint` matched nothing and emitted "No tasks were executed"
[verified].

The `lint` task exists in `turbo.json` and is already invoked by CI
[verified], so adopting a linter requires adding the dependency and a package
script — no workflow change.

## Formatters

`Unknown`. No Prettier, Biome or `.editorconfig` [verified].

## Test Frameworks

**Vitest `^5.0.0`** in four workspaces [verified]. Executed this session:

| Workspace | Test files | Tests | What they cover |
|---|---|---|---|
| `packages/shared` | 3 | 79 | §8.1 enum members, §3 matrix shape, and all 48 matrix cells |
| `packages/database` | 2 | 29 | Partial indexes and CHECK constraints in the Postgres catalogs, plus enforced behavior; §8 column fidelity |
| `apps/api` | 3 | 18 | Health round trip, EmailProvider, the eleven-row RBAC matrix over HTTP |
| `apps/admin-web` | 1 | 2 | Verification tokens are single-use and identifier-scoped |

**128 tests, all passing** [verified]. `apps/learner-web` declares no `test`
script and has no tests [verified].

Supporting libraries: `@nestjs/testing` and `supertest` in `apps/api`; `pg` in
`packages/database` for catalog queries [verified].

Two configuration details that matter:

- `apps/api/vitest.config.mts` and `apps/admin-web/vitest.config.mts` widen the
  include glob to `test/**/*-spec.ts` as well as `*.spec.ts`. Vitest's default
  matches only the latter, so `rbac.e2e-spec.ts` silently did not run until
  this was added — and a file that never runs is indistinguishable from a
  passing one in the summary [verified].
- Both configs set `fileParallelism: false`; these suites share one database
  and mutate rows [verified].

**Outside `pnpm test`:** `scripts/verify-magic-link.sh` drives the magic-link
flow over real HTTP against a live Next server — link logged, only the hash
stored, hashing still matching `InvitationService`, session created, reuse
rejected. It passed this session [verified]. Re-run it after any next-auth
upgrade.

## Static Analysis

**The TypeScript compiler, in strict mode** — the only static analysis
configured [verified]. `packages/shared/tsconfig.base.json` sets `strict`,
`noUncheckedIndexedAccess`, `noImplicitOverride` and
`noFallthroughCasesInSwitch`; every workspace extends it. `turbo run typecheck`
runs 10 tasks green [verified].

Nothing further — no ts-prune, no dependency-cruiser, no complexity analysis
[verified].

## Security Scanners

`Unknown`. No scanner configuration and no audit step in CI [verified].

Security-relevant behavior that *is* under test, for whoever adds scanning:
role resolved from the database on every request and client-supplied roles
ignored; deny-by-default authorization; sign-in tokens stored only as a
sha256 hash; single-use verification tokens [verified].

## Notes

