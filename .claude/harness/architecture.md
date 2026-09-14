# Architecture

## Pattern

**A workspace monorepo with a shared kernel, plus a partially realised
ports-and-adapters boundary.** Stated precisely, because two of the three
elements are only partly built:

- **Monorepo with a shared kernel** — fully realised [verified]. Four
  deployable apps consume five packages. `packages/shared` is the kernel:
  it holds the §8.1 enum members, the §3 permission matrix and the error
  codes, and both `apps/api` and the test suites read it rather than
  restating those values. Dependency direction is strictly one-way: no
  package depends on any app [verified].

- **Layered, inside `apps/api`** — realised [verified]. NestJS convention
  gives controllers (`admins/`, `content/`, `health/`), a cross-cutting guard
  chain (`auth/`), and injectable services (`prisma/`, `auth/invitation.service.ts`).
  Guards run in a fixed order and each layer narrows the previous one.

- **Ports and adapters** — now genuinely built for four of the five `[verified]`.
  §11 names five provider interfaces. `EmailProvider`
  (`apps/api/src/email/`, logging implementation only) and, from P3,
  `ImageGenerationProvider` (`packages/ai`, with a real OpenAI adapter and a
  deterministic fake selected by `IMAGE_PROVIDER`) and `ObjectStorage`
  (`packages/storage`, MinIO/S3) — all bound through Symbol tokens [verified].
  P4 adds `LlmProvider` (`packages/ai`, an Anthropic Messages adapter over the
  official SDK plus a deterministic fake selected by `LLM_PROVIDER`; `anthropic`
  without a key throws rather than downgrading) [verified]. P5 adds
  `TextToSpeechProvider` (`packages/ai`, an OpenAI speech adapter over plain
  `fetch` — no SDK, following P3's image adapter — plus a fake selected by
  `TTS_PROVIDER` that emits REAL MP3 tones so the merge and its offsets are
  exercised without a paid call) [verified]. P8a adds `PaymentProvider`
  (`packages/commerce/src/payment-provider.ts`) with a deterministic fake and an
  `UnavailablePaymentProvider` — and **no real gateway**, because §14 decision 1 is
  still open [verified]. Unlike the other fakes it is opt-in: only
  `PAYMENT_PROVIDER=fake` binds it; unset closes checkout (see
  `specs/p8a-commerce/`).

**Not** microservices: the apps share one database and one Prisma schema
[verified]. **Not** feature-based: `apps/api/src` is organised by technical
role, not by feature.

## Important Directories

| Path | Purpose | Evidence |
|---|---|---|
| `knowledge-explorer-spec.md` | Locked product spec; source of truth for §-references throughout the code | [verified] |
| `specs/p0-foundation/` | spec.md, plan.md, tasks.md — tasks.md is durable progress state and carries three sets of implementation notes | [verified] |
| `packages/shared/src/` | `enums.ts` (§8.1), `roles.ts` (§3 matrix + `isAllowed`), `errors.ts` | [verified] |
| `packages/database/prisma/` | `schema.prisma` (18 §8 tables + 3 Auth.js tables), one migration | [verified] |
| `packages/database/prisma/migrations/20260911180121_init/` | **Contains hand-written SQL that must never be regenerated** — see Risks | [verified] |
| `apps/api/src/auth/` | The guard chain: session, roles, R-01, R-02, plus target resolution and invitations | [verified] |
| `apps/api/test/rbac.e2e-spec.ts` | The eleven-row verification matrix over real HTTP | [verified] |
| `apps/admin-web/auth.ts` | Auth.js configuration: Prisma adapter, database sessions, dev-mode link delivery | [verified] |
| `scripts/verify-magic-link.sh` | End-to-end magic-link check needing a live server; not part of `pnpm test` | [verified] |
| `packages/{ai,commerce,content}/` | Empty placeholders — nothing to read | [verified] |

No submodules; no vendored or generated code is committed (`dist/`, `.next/`,
`node_modules/` are all ignored) [verified].

## Module & Data Flow

**Request path through `apps/api`** [verified by reading the guards and by the
passing e2e matrix]:

```
HTTP request
  → SessionGuard        clears any caller-supplied identity, reads the session
                        cookie, loads sessions + users from the database,
                        rejects expired sessions and disabled accounts
  → RolesGuard          reads the endpoint's declared §3 action; no declaration
                        means refuse everyone; consults isAllowed(action, role)
  → PublishedLockGuard  R-01: non-owner writing to a published course → 403
  → AssignmentGuard     R-02: admin writing a row assigned to someone else → 403
  → controller
```

Identity is resolved from the database on **every** request, never from client
input — the guard explicitly discards anything already on the request object
before querying (FR-AUTH-02) [verified]. Endpoints declare a §3 *action* rather
than a role, so `packages/shared/src/roles.ts` remains the only place a role
decision is recorded [verified].

**Authentication** lives in `apps/admin-web`, not the API. Auth.js mints
`sessions` rows through the Prisma adapter; the API only reads them. Database
sessions rather than JWT because FR-AUTH-01 requires that disabling an admin
block the next call immediately [verified — asserted in the e2e suite].
Invitation links minted by `apps/api/src/auth/invitation.service.ts` hash as
`sha256(token + AUTH_SECRET)`, which matches Auth.js's scheme — confirmed by
comparing a real Auth.js-issued token, and re-asserted by
`scripts/verify-magic-link.sh` [verified].

**Entry points** [verified]: `apps/api/src/main.ts` (HTTP, global prefix `api`
with `health` excluded, port from `API_PORT`, default 3001);
`apps/worker/src/main.ts` (standalone context, Redis PING, exits);
`apps/admin-web/app/` and `apps/learner-web/app/` (Next App Router).

**Unbuilt flows.** Block extraction (§6.1), image generation (§6.2), narration
(§6.3), audio (§6.4) and the WHOLE §6.5 staleness chain are built. Narration
segments carry a per-segment checksum and `audio_segments.source_segment_checksum`
holds it back, which is what makes FR-AUDIO-01's per-segment re-synthesis
possible; neither `script_status` nor `audio_status` is ever stored as `stale` —
§6.5 says staleness is computed on read, so the API derives both [verified]. The
§4.3 draft/published split is built (P6/P7), and §7's commerce is written by P8a:
owner products, discount codes and manual grants under `apps/api/src/commerce/`;
checkout creating pending `payment_orders`; and the webhook, the only writer of
purchase grants, which stacks expiry with `stackExpiry` under a per-learner, per-scope
advisory lock. Entitlement is still read only through `isGrantActive` in
`packages/commerce` [verified]. The expiry-reminder job (§7.5) is P8b's.

**ffmpeg is a runtime dependency of `apps/worker` since P5** [verified].
`apps/worker/src/audio/ffmpeg.ts` is the only place the worker spawns a process;
`main.ts` probes for `ffmpeg` and `ffprobe` at boot and exits non-zero naming the
missing one. The merge decodes every segment to PCM, concatenates and encodes
once rather than stream-copying: measured at P5, eight `-c copy` segments drift
404 ms against 0 ms for the re-encode, because MP3 padding accumulates per file
[verified].

**Background jobs** run on BullMQ with four queues: `curriculum-import` (P1),
`image-generation` (P3), `narration-script` (P4) and `audio-synthesis` (P5), all
consumed by `apps/worker` through `withJobLifecycle`, which drives the
`generation_jobs` state machine [verified]. **P5 performed the extraction P3 and
P4 had twice deferred**: `queueDefinitions` in `packages/shared/src/queues.ts`
now holds each queue's name, env override, id prefix, retention and fallback
job_type as data, and `apps/api/src/jobs/base.queue.ts` owns construction, the
NFR-03 retry defaults and id qualification. The producers remain four subclasses,
deliberately — import alone has two job names and a Redis-cached dry-run result
[verified]. Image, narration and audio ids are qualified `image:<n>`,
`script:<n>` and `audio:<n>`; **import's prefix is the empty string** because P1
minted unprefixed ids and its screens still hold them, which is why
`prefixedQueueDefinitions` and `unprefixedQueueDefinition` are separate exports:
`'anything'.startsWith('')` is always true, so a resolver iterating the registry
in declaration order would route every id to import [verified].
`withJobLifecycle` treats a BullMQ `UnrecoverableError` as a final attempt, so a
job that must not be retried still reaches a terminal row [verified].

## Notes

