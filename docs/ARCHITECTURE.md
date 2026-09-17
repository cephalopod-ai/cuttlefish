# Architecture

## Architecture Summary

Cuttlefish is a pnpm/Turborepo TypeScript monorepo with two primary packages:

- `packages/cuttlefish`: CLI, gateway daemon, engine adapters, connectors, session registry, orchestration runtime, and static web serving.
- `packages/web`: Vite/React dashboard served by the daemon after build.
- `packages/contracts`: shared TypeScript contracts used by the daemon and dashboard.

The intended architecture is "a bus, not a brain": Cuttlefish coordinates external AI
coding CLIs and adds routing, scheduling, connectors, persistence, and UI without
owning model reasoning.

## Component Map

- CLI entrypoint: `packages/cuttlefish/bin/cuttlefish.ts`
- Gateway lifecycle/server: `packages/cuttlefish/src/gateway/`
- API router: `packages/cuttlefish/src/gateway/api.ts`
- HTTP path parsing: shared `gateway/request-url.ts`, used by transport authorization
  and API dispatch. Routes adapt inputs and service results; focused services own
  persistence and validation, including `gateway/config-update-service.ts`,
  `cron/jobs.ts` and `gateway/department-rename.ts`.
- Engine adapters: `packages/cuttlefish/src/engines/`
- Sessions and persistence: `packages/cuttlefish/src/sessions/`
- Orchestration: `packages/cuttlefish/src/orchestration/`
- Connectors: `packages/cuttlefish/src/connectors/`
- Web dashboard: `packages/web/src/`
- Operator docs/governance: `docs/`, `AGENTS.md`, `governance/`, `schemas/`

## Data / Persistence Map

- Instance home: `~/.cuttlefish` by default or the active `CUTTLEFISH_HOME`; local
  Cuttlefish has one canonical instance name per active home. Lifecycle and
  instance inspection resolve the same active home, and detached restart requests
  coalesce behind a restart lock.
- Config/org/skills/templates: initialized and migrated from package templates.
- Config and cron mutations read complete on-disk state before replacement;
  degraded cron reads are not mutation inputs. Atomic file replacement completes
  all bytes and flushes the file by default; directory fsync is best-effort.
  Department rename has a durable intent for forward recovery and refuses a
  new rename while an unresolved intent remains.
- Sessions/messages/files/artifacts/queue/archive/approval state: SQLite-backed registry modules.
- Optional external knowledge export state: SQLite-backed `external_outbox`
  rows plus optional JSONL append output under `~/.cuttlefish/knowledge/`.
- Uploaded and attached artifacts: managed gateway storage with façade seam tests,
  SHA256 metadata, source/run annotations, validation helpers, and run-bundle
  manifest export.
- Run-scoped resource attachments: persisted in session `transportMeta`, exposed
  through session APIs, and normalized into exact file paths plus structured
  prompt context at dispatch time.
- Human checkpoints: persisted in the approval/checkpoint registry, surfaced via
  dedicated checkpoint APIs, and able to pause or resume session execution with
  a durable human-decision trail.
- Provider-neutral external knowledge seam: checkpoint decisions and completed
  session summaries can be exported as durable, versioned envelopes through
  `noop`, `jsonl`, or generic `webhook` sinks; a generic read provider is
  optional and never authoritative for core Cuttlefish behavior.
- Run bundles: generated on demand from session state, copied run-linked
  artifacts, filtered logs, and derived summaries into managed runtime export
  directories suitable for handoff and future replay/import work.
- Orchestration telemetry/recovery/worktrees: managed under Cuttlefish runtime paths and bounded retention policies.

## Workflows

### Local operator flow

1. Install `cuttlefish-cli`.
2. Sign in to at least one engine CLI.
3. Run `cuttlefish setup`.
4. Run `cuttlefish start`.
5. Use the dashboard at the configured gateway host/port.

### Web/API flow

1. Browser loads the Vite/React dashboard served by the gateway.
2. UI calls `/api/*` routes through `handleApiRequest()`.
3. The API router delegates to route-family modules.
4. Route handlers call sessions, engines, connectors, files, or orchestration services.
5. Events stream back to the UI through gateway WebSocket/session channels.

### Engine turn flow

1. A session selects an engine/model/effort.
2. Gateway builds prompt/context and attachments.
3. Gateway revalidates current task, allocation, queue and decision authority;
   a supported engine adapter invokes the external CLI.
4. Stream deltas are normalized and persisted.
5. Final message, blocks, media, cost/context, and metadata update the session.

`sessions/context.ts` remains the compatibility facade for prompt assembly and
its public identity/onboarding/thread builders. `sessions/context-budget.ts`
owns tier-based section selection; `sessions/context-api.ts` owns full and
compact audience-scoped gateway guidance. Web and connector dispatchers keep
calling `buildContext` through the original path.

### Evidence and execution authority

`sessions/execution-boundary.ts` constructs gateway-owned versioned origin,
requirement and generation state in the registry. Child restrictions attenuate
the actual parent; inbound transport metadata cannot mint host grant, lease,
checkpoint or run state. `source: web` and a COO/manager persona do not authenticate
an operator. Existing HMAC session credentials and explicit operator delegation
remain the identity/grant mechanism, with unique issuance, bounded lifetime,
current role/model/config checks and own/direct-child decision scope.

`gateway/approval-binding.ts` binds material and target policy to the review
revision. Checkpoint and fallback services persist a decision plus stable queue
intent atomically in SQLite. `gateway/session-dispatch-authorization.ts` fences
the current generation, producer attempt, allocation and decision immediately
before invocation, including retries/fallbacks. Completion cannot clear a
replacement attempt's checkpoint. Claimed queue rows recover as uncertain,
never automatically re-armed. Outbox destinations and automatic web-turn
connector reply material are bound independently of evidence text.

Prompt distinctions and historical export metadata support attribution; live
permission comes from gateway state. Codex batch's supported read-only arguments
are used for protected dispatch; adapters without that capability refuse it.
Gateway authorization does not isolate an external CLI from same-user files,
credentials or native network/tools. The maintained
[implementation handoff](evidence-execution-authority.md) maps actual action
paths, compatibility, evidence and residual boundaries; upstream runtime
conformance and native containment remain unverified.

## Dependency Boundaries

- Web UI should call API/client libraries, not persistence internals.
- Gateway route modules should route/validate/translate, not own business logic.
- Session registry modules own persistence semantics.
- Engine adapters own CLI invocation and stream normalization.
- Orchestration runtime owns leases, continuations, holds, worktrees, and telemetry.
- Local generated artifacts stay outside the tracked source tree.
- Run attachment normalization lives in the gateway service layer; routes
  translate request shapes and session storage keeps the durable run-level
  resource roster.
- Human checkpoint semantics live in the gateway service layer so route modules
  only translate inputs/outputs while the shared approval store keeps the
  durable decision history.
- External knowledge sink/read-provider semantics also live in focused gateway
  and knowledge service modules so route files stay thin and downstream mapping
  remains outside Cuttlefish core.
- Run bundle export also lives in the gateway service layer so copy/filter rules
  stay centralized and session routes remain thin action adapters.
- Org mutation and cross-request state machines live in
  `org-mutation-service.ts` and `cross-request-service.ts`; the org route owns
  only transport parsing, high-level query sequencing, and response translation.
- Session creation, mutation, deletion, stop/reset/duplicate, and queue
  transitions live in `create-session.ts` and `session-lifecycle-service.ts`;
  `api/routes/session-write.ts` remains the HTTP adapter.

## Extension Points

- Add engines through `packages/cuttlefish/src/engines/` and model registry/config support.
- Add connectors under `packages/cuttlefish/src/connectors/`.
- Add dashboard routes in `packages/web/src/main.tsx` and route modules.
- Add orchestration controls through `orchestration-routes.ts`, web API helpers, and contract tests.
- Add artifact workflows through `api/routes/artifacts.ts` while keeping file
  persistence semantics in `sessions/registry/files.ts`.
- Add skills through the `cuttlefish skills` CLI and the active-home
  `skills.json` manifest. The CLI accepts the seeded object-shaped manifest and
  the legacy flat-array form.
- Keep downstream program vocabulary, policy examples, and release semantics out
  of tracked generic source, templates, and operator docs; program-specific
  specialization belongs in external policy packs or historical/local planning
  records.

## Known Architecture Risks

- Historical docs still contain old Next.js assumptions and are explicitly historical.
- Orchestration is broad and should keep façade/contract tests around routing seams.
- Public tooling directories need a policy decision before further public hardening.
- React test warnings indicate UI test hygiene work remains.

## Diagrams

See `docs/IMPLEMENTATION_DIAGRAMS.md`.

## Decision Records

See `docs/DECISION_LOG.md`.
