# Conventions

## Coding Standards

No linter or formatter enforces style; these are observed in the code and
mandated by the specification [verified unless noted].

- **TypeScript strict everywhere.** `packages/shared/tsconfig.base.json` sets
  `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride` and
  `noFallthroughCasesInSwitch`; all nine workspaces extend it.
- **Database columns are `snake_case`; TypeScript and JSON are `camelCase`.**
  Prisma models map between them with `@map`/`@@map` — see `schema.prisma`.
- **Enum-like columns are `String`, never Prisma `enum`**, per §8's decision to
  keep migrations cheap. Members live once in `packages/shared/src/enums.ts` as
  zod schemas; no workspace restates a literal union.
- **Money is `Decimal(12,2)`, never a float. Timestamps are
  `Timestamptz(6)`.** Asserted by `schema-fidelity.spec.ts`.
- **Where §8 omits `ON DELETE`, `NoAction` is set explicitly**, so the emitted
  DDL matches the spec rather than Prisma's `Restrict`/`SetNull` defaults.
- **Errors carry a machine-readable `errorCode`** from
  `packages/shared/src/errors.ts` (FR-AUTH-02). Never invent a bare string.
- **Endpoints declare a §3 action, not a role** — `@RequirePermission(action)`
  with `isAllowed()` doing the decision, so the matrix stays single-source.
- **Nest dependency injection is always explicit `@Inject(Token)`**, never
  type-based. `emitDecoratorMetadata` is set to `false` deliberately: esbuild
  (tsx, vitest) does not emit it. Do not turn it on and drop the tokens.
- **Source comments cite specification sections** (`§8.1`, `FR-AUTH-01`,
  `R-01`) rather than restating rules in prose.

### Critical invariants

Three things the tests exist to protect. Breaking any of them is silent.

1. **Never regenerate
   `packages/database/prisma/migrations/20260911180121_init/migration.sql`.**
   Six partial unique indexes, one partial index and two CHECK constraints are
   hand-appended below the generated section — Prisma's schema language cannot
   express them. `prisma migrate dev` would rewrite the file and drop them, and
   `prisma migrate diff` reports "No difference detected" either way because it
   does not track them [verified]. `constraints.spec.ts` is the only guard; it
   asserts both catalog presence and enforced behavior.
2. **`UndeclaredPolicyFixtureController` must keep declaring no permission.**
   It exists to hold deny-by-default under permanent test and must always
   return 403 `FORBIDDEN_NO_POLICY`.
3. **Invitation token hashing must stay `sha256(token + AUTH_SECRET)`**, which
   is what Auth.js uses. If it drifts, API-minted invitation links stop being
   consumable — silently. `scripts/verify-magic-link.sh` asserts it.

## Naming & Layout Patterns

- Workspaces are scoped `@knowledge-explorer/*`, directory-named [verified].
- `apps/api/src` is organised by **technical role** — `auth/`, `admins/`,
  `content/`, `email/`, `health/`, `prisma/` — with NestJS suffixes:
  `*.controller.ts`, `*.service.ts`, `*.guard.ts`, `*.decorator.ts`,
  `*.module.ts` [verified].
- Packages expose a barrel `src/index.ts` re-exporting their modules [verified].
- Tests live in a per-workspace `test/` directory, never beside the source
  `[assumed]` — all nine test files follow it [verified], but nothing enforces
  it. Names are `*.spec.ts`, with `*.e2e-spec.ts` for suites that boot an app.
- Web apps use the Next App Router under `app/` [verified].
- Documentation is English; the product spec is English and notes a Vietnamese
  companion document that is not in this repository [verified].

## Commit Conventions

Eight commits, all by one author [verified]. The observed style:

- **Imperative, capitalised, no type prefix and no trailing period.** No
  Conventional Commits — no `feat:`/`fix:` anywhere.
- Subjects run 37–59 characters [verified].
- Non-trivial commits carry a body explaining **why**, including decisions
  taken, rejected alternatives and known gaps.
- Every commit ends with the trailer
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
  [verified].
- Commits are grouped logically — spec, plan, then implementation in coherent
  slices — rather than one commit per file [verified].

## Notes

