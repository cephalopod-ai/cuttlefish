# Cuttlefish System Evaluation

**Date:** 2026-07-04
**Scope:** Full-repo evaluation of `e3742526/cuttlefish` as an integrated product — dataflow, database behavior, GUI wiring, and agent orchestration/assignment/monitoring workflows.
**Method:** Static code audit (every claim cited to files), plus live runtime verification: fresh `pnpm install` → `build` → `typecheck` → `lint` → `test`, then `cuttlefish setup` → `start --daemon` on a clean home, exercising the HTTP API (status, org read, employee create, work/command-center dashboards) and inspecting the created state on disk.
**Severity scale:** S0 blocks running · S1 corrupts/loses data · S2 breaks core workflow · S3 major UX/architecture issue · S4 minor defect · S5 future improvement.
**Evidence classes:** confirmed (read or executed) · inferred · missing · broken · unclear.

---

## 1. Executive Summary

**System maturity: advanced beta.** Cuttlefish is a real, coherent product, not scaffolding. It installs, builds, typechecks, lints, passes 1917 tests, boots a daemon, serves a wired React dashboard, and completes its headline loop live (create employee → file ticket → dispatch to an engine CLI → persist the run). The engineering floor is high in specific places — WAL SQLite with corruption quarantine, atomic file writes, a hash-chained audit log, a transactional run-ledger state machine, git-worktree isolation, and a self-modification-guarded org-change approval pipeline are all genuinely implemented. The ceiling is limited by two things: a structural split between the always-on "org/board" layer and the off-by-default "matrix orchestration" layer, and a set of security and integrity gaps that matter the moment the gateway is exposed beyond a single trusted localhost.

- **Does dataflow work?** Yes for the three core flows (agent creation, ticket assignment/dispatch/execution, run persistence) — traced hop-by-hop and confirmed live. It breaks down at provenance: assignment history isn't kept and terminal tickets lose their run link.
- **Does the database work?** Yes within each of the four SQLite stores (transactional, WAL, corruption-hardened). The weakness is *across* stores — 4 SQLite DBs plus JSON/YAML files stitched by unconstrained string IDs, with non-atomic cross-DB writes and almost no foreign keys.
- **Is the GUI wired?** Yes — nearly every screen reads real endpoints with honest loading/error/empty states and no fake-live data. The problems are discoverability (the operator dashboard and the entire orchestration console are effectively unreachable from the nav) and a few split-persistence / dead-control defects.
- **Is agent orchestration first-class?** Partially. Execution, delegation, run tracking, and supervision primitives are real, but the durable scheduler is opt-in and off by default, there is **no concurrency cap at all in the shipped default path**, employee availability is dead code, and fleet/project abstractions don't exist.

### Top 5 risks

1. **[S1] Scoped agent tokens can drive the human-oversight control plane** — approve their own security checkpoints, approve org changes, stop other agents' leases (`scoped-token.ts` deny-list gaps; no handler reads the attached principal).
2. **[S1] No per-employee or global concurrency cap in the default (orchestration-disabled) path** — one employee can spawn unbounded parallel runs (`ticket-dispatch.ts:200-248`).
3. **[S1] Employee availability lifecycle is dead code** — `disabled`/`draft`/`retired` employees remain dispatchable (`isActiveEmployee` has zero production callers).
4. **[S2] No assignment/dispatch history or run-level provenance in the GUI** — reassignment overwrites in place, the board is un-audited by design, and the run-ledger REST surface has zero web consumers.
5. **[S2] The integrity seam between the two orchestration layers** — non-atomic cross-DB writes, no cross-process board lock, torn-write risk on the dual-lane selection manifest, and no run-state transition matrix (`completed→running` verified allowed).

### Top 5 fixes

1. Extend the scoped-token deny list and make handlers enforce `principal.sessionId` on session/approval/checkpoint writes; derive manager identity from the principal, not the request body.
2. Add a per-employee (and global) concurrent-run cap to the default dispatch path, independent of the orchestration flag.
3. Enforce `isActiveEmployee` at dispatch; add a minimal run-state transition guard to tickets and the run-ledger.
4. Surface the run-ledger in the GUI (runs/dead-letter/lineage screens) and persist an append-only assignment/dispatch history.
5. Put both dashboards in the nav; fix the `/ws` device-cookie auth gate; re-run `validateGatewayExposure` inside `reloadConfig`.

---

## 2. Repository / Architecture Map

### 2.1 Repo map (confirmed)

| Aspect | Finding |
|---|---|
| Primary language | TypeScript (ESM), Node pinned `>=24 <25` (`package.json`, `.nvmrc` 24.13.0) |
| Monorepo | pnpm 10 + Turborepo; `packages/cuttlefish` (backend daemon + CLI, published as `cuttlefish-cli` 0.23.3) and `packages/web` (dashboard) |
| Frontend stack | React 19 + Vite 7 + react-router 7 SPA, TanStack Query 5, Tailwind 4, Radix, xterm.js, @xyflow/react + dagre; built to static files served by the daemon |
| Backend stack | Plain Node `http.createServer` (no web framework) + `ws` + `node-pty` + `commander` CLI + zod/js-yaml/node-cron; Slack (`@slack/bolt`), WhatsApp (baileys), email (imapflow) connectors |
| Database | **4 local better-sqlite3 databases** (raw SQL, no ORM): `sessions/registry.db`, `orchestration.db`, `run-ledger.db`, `artifact-lineage.db` — plus YAML/JSON/JSONL flat files (org employees, kanban `board.json`, `config.yaml`, `cron/jobs.json`, hash-chained `audit.jsonl`) |
| Vector DB | Qdrant client wrapper exists (`packages/cuttlefish/src/shared/qdrant.ts`) with docker-compose + docs, but **zero call sites** — dead scaffolding |
| Entry points | `packages/cuttlefish/bin/cuttlefish.ts` (CLI), `src/gateway/daemon-entry.ts` → `src/gateway/server.ts` (composition root) |
| CLI surface | `setup`, `start [--daemon]`, `stop`, `restart`, `status`, `pair`/`unpair`, `limits`, `migrate`, `skills …`, `ledger status|reset`, `inspect runs|run|lineage|dead-letter|policy`, `nuke` |
| Migration systems | Two: (a) in-code idempotent SQLite schema evolution at every DB open; (b) `template/migrations/<semver>/MIGRATION.md` prose migrations applied **by an AI engine CLI** via `cuttlefish migrate` |
| Config | `~/.cuttlefish/config.yaml` (validated by `src/shared/config-schema.ts`); repo governance configs under `governance/`, `schemas/`, `repo_standard.v1.yaml` |
| Env vars | `CUTTLEFISH_HOME/INSTANCE/NO_OPEN`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `QDRANT_*`, `CODEX_HOME`, etc. |
| API boundary | Same-origin JSON HTTP (`src/gateway/api.ts` → `api/routes/*`) + two WebSockets: `/ws` (event stream) and `/ws/pty/:sessionId` (live terminal) |
| Deployment | Local single-user daemon at `localhost:8888`; npm/Homebrew distribution (`Formula/cuttlefish.rb` — pins `node@22`, contradicting engines `>=24`); docker-compose covers Qdrant only |

### 2.2 Intended architecture (maintainers' words)

README: *"Run your AI agents as a company"* — Cuttlefish is the orchestration layer that runs any agent CLI (Claude Code, Codex, Grok, Antigravity, …) as interchangeable **Engines**, coordinates them as **Employees** (YAML personas in `~/.cuttlefish/org/`) with hierarchy and **Delegation** (sessions spawn child sessions), plus cron, skills, and connectors. Design stance: "bus, not brain" — zero own AI logic; billing rides the flat-rate Claude subscription by driving the official CLI in a real PTY.

### 2.3 Architecture Hypothesis

- **Frontend:** React SPA served statically by the daemon; JSON API + WS invalidation; localStorage caches for kanban and UI prefs.
- **Backend:** single Node daemon; hand-rolled HTTP router; org scan + session manager + orchestration runtime + connectors composed in `server.ts`.
- **Database:** 4 SQLite stores (WAL) + atomic-write JSON/YAML files; no cross-store transactional boundary.
- **Agent runtime:** `src/engines/*` adapters spawning real vendor CLIs in PTYs (claude, codex, antigravity, grok, hermes, pi, kiro, ollama, kilo, aider, mock).
- **Agent orchestration layer:** two coexisting layers — the *org/board layer* (employees YAML, kanban `board.json`, `board-worker` poller, `ticket-dispatch`, mid-pair implementer→reviewer loop) and the *durable orchestration layer* (`src/orchestration`: leases, allocations, queue, continuations, dual-lane runs, git worktrees), linked by string IDs.
- **Event/logging layer:** run-ledger (canonical run state machine) + artifact-lineage (provenance graph) + `audit.jsonl` (hash-chained) + telemetry events + gateway log.
- **User-facing workflow:** `setup` → `start` → chat with an executive employee that delegates; kanban tickets dispatched to employees; monitoring via Chat/Kanban/Org/Command-Center/Orchestration screens.
- **Unknowns:** Qdrant/knowledge vector memory (scaffolded, unwired); `classic-level` root dependency (zero imports); `control/` directory referenced by governance docs but absent; `/redesign` route (in-flight UI overhaul).

### 2.4 Gap between observed and intended

The intended architecture is substantially real: engines, employees, delegation, cron, connectors, approvals, and the durable orchestration substrate all exist and are wired. The gaps are: no **project** or **fleet** entity anywhere (only departments-as-directories and UI vocabulary); the two orchestration layers (board/org vs leases/queue) are stitched by unconstrained string IDs; and the run-ledger observability layer has **no GUI consumer** — canonical run history is CLI-only.

---

## 3. Dataflow Audit

### Flow A — User creates/configures an agent ("employee") — **WORKS END-TO-END** (confirmed live)

GUI `EmployeeCreateForm` (`packages/web/src/components/org/employee-create-form.tsx:180-222`; mounted at `routes/org/page.tsx:295-303`) → `api.createEmployee` (`lib/api-org.ts:131`) → `POST /api/org/employees` (`src/gateway/api/routes/org.ts:198-224`) → hand-rolled validation `validateEmployeeCreate` (`src/gateway/org.ts:702-822`: name regex, duplicate guard, path-traversal guard on department, engine/model/rank checks) → YAML write `createEmployeeYaml` (`org.ts:1022-1041`, atomic safe-write, ORG_DIR containment) → `reloadOrg()` re-scans registry + recycles idle engines (`server.ts:335-353`) → GUI refresh via `onCreated → loadData()` plus WS `org:changed` → react-query invalidation (`hooks/use-query-invalidation.ts:84-89`). Errors surface in the form banner (`employee-create-form.tsx:465-472`).

**Verified live:** `POST /api/org/employees` returned 201, `org/general/eval-test-agent.yaml` appeared on disk, and the agent showed in `GET /api/org` and `/api/command-center` counts.

Breakpoints:
- **[S4, broken-dead]** `emit("org:updated", …)` at `api/routes/org.ts:219` has no frontend subscriber; only `org:changed` (from `reloadOrg`) drives refresh.
- **[S3, missing]** `OrgPage` holds local state via imperative `loadData()` instead of the `useOrg()` react-query hook, so the WS invalidation never live-refreshes the org map for a *different* client — cross-client updates require manual reload (`routes/org/page.tsx:70-105`).
- **[S3, unclear-by-design]** The Add-agent form bypasses the HR change-request/approval pipeline entirely (`POST /api/org/change-requests` path exists at `org.ts:336-373` + `hr-steward.ts` but the form writes directly). Two creation paths with different governance.

### Flow B — User assigns work to an agent — **WORKS, with structural gaps**

Ticket creation: `CreateTicketModal` (`routes/kanban/page.tsx:665-672`) → whole-board `PUT /api/org/departments/:name/board` (`api/routes/org.ts:635-675`) with per-ticket validation (`board-service.ts:177-217`) and optimistic concurrency (`baseUpdatedAt` → 409 `BoardConflictError`, `board-service.ts:305-369`). Assignment = `ticket.assignee` string + picker (`ticket-detail-panel.tsx:408-416`). Dispatch: manual `POST …/tickets/:id/dispatch` (`api/routes/org.ts:589-632`) or the `board-worker.ts:169-218` 5-minute poller (ranks by complexity/priority/age, dispatches one ticket per tick, routes to manager). Capacity gate = orchestration lease headroom (`ticket-dispatch.ts:200-248`). Execution marks ticket `in_progress` + `sessionId` (`ticket-dispatch.ts:366-370`); `board-sync.ts:126-190` maps session lifecycle back to ticket status; watchdogs (`orphaned-ticket-reconciler.ts`, `stuck-ticket-watchdog.ts`, `status-reconciler.ts`) reconcile stuck states; WS `board:updated` refreshes the UI.

Breakpoints:
- **[S2, confirmed]** When `orchestration.enabled !== true` (the default), dispatch **bypasses all concurrency gating** (`ticket-dispatch.ts:208` returns `undefined`) — unbounded parallel agent runs in the out-of-box configuration.
- **[S3, missing]** No durable assignment history: only current `assignee` persists; `ticket:dispatched` events are WS-broadcast-only (`ticket-dispatch.ts:392-399`). Reassignment overwrites in place; provenance of "who was assigned when, by whom" is lost.
- **[S3, confirmed]** The `review` ticket status exists in the UI but no automated path ever sets it — `board-sync.ts:126-150` jumps `in_progress → done/blocked`, so mid-pair reviewer outcomes never surface as `review`.
- **[S3, missing]** No capacity queue: a dispatch with no headroom returns 409 and the ticket is skipped, not queued.

### Flow C — Agent runs and produces output — **WORKS; observability gap in GUI**

Execution: engines registered in `server.ts:253-264`; driver `run-web-session.ts` (streams WS `session:delta`); `employee-execution.ts` supplies tiering/reviewer policy; mid-pair loop in `mid-pair-orchestrator.ts`. Logs/events: SQLite `messages` (timestamped, FTS-indexed, `sessions/registry/schema.ts:34-42`), run-ledger `run_events` with `created_at`, JSONL transcripts backfilled (`transcript-backfill.ts`). Outputs: final text persisted (`run-web-session.ts:822-836`); run bundles (run.json/summary.md/errors.json/artifacts + SHA-256 manifest, `run-bundles.ts:251-353`); artifact-lineage DB. Failure taxonomy is explicit and distinct from cancellation at both layers: sessions `error` vs `interrupted` (`shared/types/sessions.ts:70`); ledger `created/running/blocked/failed/interrupted/dead_lettered/completed` (`run-ledger/types.ts:3-11`).

Breakpoints:
- **[S3, confirmed]** The run-ledger has a full REST inspect surface (`GET /api/inspect/runs`, `/runs/:id`, `/dead-letter`, `/lineage/:artifactId` — `api/routes/inspect.ts:24-83`) with **zero web consumers**. Historical/failed run inspection is CLI-only (`cuttlefish inspect`, `cuttlefish ledger`). A user cannot inspect what happened without a terminal.
- **[S3, confirmed]** Run bundles — the "final output package" — are written under the **tmp dir** (`shared/paths.ts:99`), not a durable location.
- **[S4]** Activity screen is a raw log tail with manual refresh (`routes/logs/page.tsx:22`), not a structured event timeline.

### Flow D — Project / fleet management — **MISSING as abstractions; dashboard is real**

- **Project: missing.** Fully specced (`packages/web/docs/superpowers/specs/2026-03-16-command-center-design.md` — `interface Project`, `projects.json`, `/api/projects`) but never implemented; nearest reality is `workspaces.roots` config and departments-as-directories.
- **Fleet: missing.** The word appears only in UI copy (`routes/command/page.tsx:190,239`). Orchestration workers/leases are the nearest machine analog, never modeled as a group.
- **Dashboard metrics: real, confirmed live.** `GET /api/command-center` (`gateway/api/routes/status.ts:88-181`) computes agents from `scanOrg()`, running counts from the live session registry, ticket counts by re-reading each `board.json`, usage buckets from per-session cost/turns. Verified live: created agent immediately appeared in `summary.agents`. No mock or random values anywhere in the dashboard paths; the error state honestly refuses to render zeroed cards (`routes/command/page.tsx:213-227`).
- **[S4]** `GET /api/activity` + client wrapper `api.getActivity` have no frontend caller — dead wiring.

---

## 4. Database Audit

### 4.1 Persistence inventory (confirmed)

Four better-sqlite3 databases, all WAL + `synchronous=NORMAL`, rooted at `~/.cuttlefish` (`src/shared/paths.ts`):

| DB | Opened in | Tables |
|---|---|---|
| `sessions/registry.db` | `src/sessions/registry/core.ts:80-114` | `sessions`, `messages` (+FTS5 w/ triggers), `files`, `archives`, `approvals`, `queue_items` (prompt queue), `queue_pauses`, `external_outbox`, `email_*`, `meta` |
| `orchestration.db` | `src/orchestration/store-schema.ts:209-230` | `leases`, `allocations`, `allocation_leases`, `queue_items` (blocked-resource), `telemetry_events`, `live_run_continuations`, `task_pauses`, `orchestration_holds`, `artifact_records`, `patch_apply_attempts`, `meta` |
| `run-ledger.db` | `src/run-ledger/store.ts:288-299` | `runs`, `run_events`, `run_errors`, `run_artifact_refs`, `policy_snapshot_refs`, `retry_replay_links`, `parent_child_run_links`, `meta` |
| `artifact-lineage.db` | `src/artifact-lineage/store.ts:104-116` | `artifacts`, `artifact_versions`, `source_references`, `lineage_edges`, `quarantine_records`, `run_artifact_xref`, `meta` |

Plus atomic-write JSON/YAML (tmp+fsync+rename, `src/shared/safe-write.ts:79-121`): org employee YAMLs, per-department `board.json` (tickets), `cron/jobs.json`, `config.yaml`, legacy `approvals.json` (one-time import); and JSONL ledgers: hash-chained `audit.jsonl` (`src/shared/audit-log.ts`), cron run logs (pruned to 1000 lines), knowledge outbox. **Qdrant** is present-but-disconnected: client wrapper + docker-compose + docs, zero call sites (S4). **classic-level** (root dependency): zero imports anywhere (S5).

### 4.2 Schema assessment

**Solid (confirmed):** WAL everywhere; `PRAGMA foreign_keys=ON` on 3 of 4 stores; broad, sensible indexes (composite state/time, partial-unique for pending approvals, unique idempotency on outbox); real `db.transaction()` use on multi-write paths (run create+event+links `run-ledger/store.ts:395-431`; snapshot delta `store-snapshot.ts:72-197`; CAS continuation claim `store-continuations.ts:120-161`; lineage cycle-check under `BEGIN IMMEDIATE` `artifact-lineage/store.ts:178-189`). The orchestration store's write-behind snapshot-delta design with rehydrate-on-persist-failure (`persistent-scheduler.ts:98-113`) is sound.

**Weak:**
- **FKs are the exception (S4).** Only three FK relationships exist across all four DBs (`allocation_leases`, `approvals.session_id`, `artifact_versions`/`source_references`). `messages.session_id`, `run_events.run_id`, `leases.task_id`, `lineage_edges.*` are unconstrained TEXT — orphans possible everywhere; `loadAllocations` even throws on dangling lease refs at read time (`store-snapshot.ts:365`) rather than the DB preventing them.
- **Cross-database writes are non-atomic (S3).** `beginSessionRun` opens a sessions-DB transaction and calls run-ledger writes *inside* it — a different SQLite file/connection (`sessions/registry/sessions.ts:258-300`). A crash between the two leaves a ledger run with no session update or vice versa. Runs/artifacts/lineage/sessions span 4 DBs with no cross-store consistency guarantee.
- Same-named `queue_items` tables with different schemas in two DBs (S5, confusion hazard).

### 4.3 State modeling

Statuses are TEXT columns with **no CHECK constraints anywhere**; enforcement is at the app boundary, unevenly:
- **Run-ledger — strongest:** zod enums + `.strict()` records parsed on read and write (`run-ledger/types.ts:3-100`).
- Sessions: TS union `idle|running|error|waiting|interrupted`, DB blindly casts (`registry/core.ts:49`).
- Tickets: hand-rolled Set membership checks, plus an index signature `[k: string]: unknown` that persists arbitrary extra fields unvalidated (`board-service.ts:33`).
- **No state-transition matrix in the run ledger (S3, verified empirically):** `transitionRun` validates enum membership only; `completed → running` was executed against a live store and **allowed** (`run-ledger/store.ts:439`), which can corrupt timestamps. Partial guards exist elsewhere (approvals resolve only from `pending`; continuation claim only from `queued` with retry-cap dead-lettering; dual-lane apply checks).

### 4.4 Migration assessment

Two unrelated systems:
1. **SQLite schema: in-code, not versioned.** `CREATE TABLE IF NOT EXISTS` + idempotent `PRAGMA table_info` probes + `ALTER TABLE ADD COLUMN` at every open. Deterministic; fresh-DB creation **verified empirically** against a scratch home. But `SCHEMA_VERSION` is stamped and **never checked** — an older binary silently "downgrades" the stamp (S4); and the base CREATE strings vs ensure-column probes must be kept in sync by hand (drift risk, S4).
2. **Instance migrations (`template/migrations/0.x.0/MIGRATION.md`) are prose applied by an AI agent**: `cuttlefish migrate` launches the default engine CLI with `--dangerously-skip-permissions` to "read its MIGRATION.md and apply the changes" (`src/cli/migrate.ts:95-128, 206-236`), no verification step, no rollback, version stamped by the AI per the prompt. `--auto` is a partial deterministic fallback. **Nondeterministic migrations with a permissions bypass — S3.**

### 4.5 Persistence correctness

**Confirmed robust:** corruption quarantine (DB+wal+shm moved aside, recovery manifest written, start empty, telemetry event emitted — `store-schema.ts:160-198`); operator-driven requeue from a quarantined DB re-imports continuations **paused** and preserves `retryCount` to prevent recover-fail loops (`recovery-requeue.ts:43-159`); stale-running-session reconciler with a two-strike rule (`status-reconciler.ts:17-77`); board writes read-back verified (`board-service.ts:469-487`).

**Defects:**
- **F10 (S3):** dual-lane state manifest — which gates whether patches may be applied — is written with raw `fs.writeFileSync` (`dual-lane-state.ts:62`), contradicting the repo's own safe-write doctrine; a torn write silently loses a winner selection.
- **F11 (S3):** board JSON read-modify-write has no cross-process lock; two concurrent writers can lose one side's non-conflicting changes — `baseUpdatedAt` only protects tickets the client explicitly asserts a base for (`board-service.ts:398-421, 318-326`).
- **F12 (S4):** run-ledger has no retention/pruning — `runs`/`run_events` grow unboundedly (contrast: telemetry pruned at 24h/1-2k rows, cron logs at 1000 lines, recycle bin at 7 days).
- Memory-only GUI-visible state: `SessionQueue` running/pending sets (`sessions/queue.ts:11-21`) degrade after restart until reconcilers correct them; dual-lane `applyLocks` is an in-process Set.

### 4.6 Query reliability

Dashboard metrics are **real queries, not fakes** (confirmed live). But hot endpoints full-scan: `listSessions()` has no LIMIT and `/api/work`, `/api/status`, `/api/command-center` materialize *every session ever created* per request, then aggregate in JS (`gateway/api/routes/status.ts:88-181, 307-368`; `sessions/registry/sessions.ts:347-357`) — combined with no ledger/session retention this degrades linearly (S4). `readDepartmentTicketCounts` re-implements board parsing instead of reusing `readBoardState` (S5).

### 4.7 Domain concept mapping

| Concept | Implementation | Classification |
|---|---|---|
| Agent | Employee YAML under `org/` + orchestration `Worker` (config), linked by name strings | Present-and-functional (two parallel notions) |
| AgentType/Capability | Free-string `capabilities`/`provides`; org `rank`/`department` | Present-but-weak |
| AgentConfig | Employee YAML `execution` block; `config.yaml` | Present-and-functional |
| AgentRun | `runs` table fed by sessions and orchestration, parent/retry/replay links | Present-and-functional (weak transitions) |
| AgentEvent | `run_events` + `telemetry_events` + WS emits | Present-and-functional |
| AgentLog | `messages` + FTS; transcripts; gateway log | Present-and-functional |
| Task/WorkItem | `BoardTicket` in `board.json`; orchestration `task_id` is an unconstrained string | Present-but-weak (two disconnected representations) |
| Assignment | `ticket.assignee` free string + `sessionId`; orchestration leases/allocations (proper M:N) | Present-but-weak |
| Project | Departments-as-directories only | **Missing** |
| Fleet | UI vocabulary only | **Missing** |
| Queue | Registry prompt queue + orchestration blocked-resource queue | Present-and-functional |
| Result/Artifact | `files` table, `artifact_records`, lineage `artifacts`, ledger `run_artifact_refs` — four stores, string-stitched | Present-but-weak as a unified concept |
| Provenance | ledger links + lineage graph + hash-chained audit.jsonl | Present-but-weak (see below) |
| UserSetting | Browser localStorage only | UI-only placeholder |
| SystemSetting | `config.yaml` via settings routes | Present-and-functional |

**Provenance gaps:** orchestration artifacts are registered into lineage **without** `producingRunId` and failures are swallowed (`orchestration/artifacts.ts:206-215`) — the lineage graph has nodes but effectively no run edges (S4); terminal tickets get their `sessionId` link **cleared** (`board-service.ts:280-284`), so a done ticket cannot be traced to the run that did it from board data alone (S4); the run-ledger's `addArtifactReference` has no production writer (S3, broken wiring).

---

## 5. GUI / UX Wiring Audit

**Overall verdict (confirmed):** a genuinely wired, production-shaped UI — not a mock shell. Every shipping screen reads real gateway endpoints; loading/empty/error states are broadly present and honest; no mock data masquerades as live anywhere in production routes. The problems are discoverability, a handful of dead/unreachable capabilities, and split persistence models.

### 5.1 Screen inventory

Router: `packages/web/src/main.tsx:59-88`; nav source of truth `lib/nav.ts:23-35` (11 items). Screens: Chat (`/`), Talk, Org, Kanban, Approvals, Archive, Cron, Limits, Activity (`/logs`), Skills, Settings — all in nav, all backed by real APIs (confirmed to endpoint level). Two more screens exist outside the nav:

- **`/command` (Command Center — the de-facto dashboard) is near-hidden [S3]:** reachable only via the unlabeled brand-logo link (`components/pill-nav.tsx:427-439`) and the ⌘K palette. An operator dashboard absent from the nav ribbon.
- **`/orchestration` is a fully built, dead-end orphan [S2]:** a 9-tab real-data ops console (workers/leases/queue/holds/dual-lane/telemetry/worktrees, 13 wired actions) with **zero inbound links** — not in `NAV_ITEMS`, not in global search (`components/global-search.tsx:49-58`), no `Link`/`navigate` anywhere (grep-confirmed). URL-typing only.
- `/redesign` is a static hardcoded design mock (`routes/redesign/page.tsx:17-33`), correctly DEV-gated (`main.tsx:81`) — the only mock data in the tree (S5).
- Global search omits `/talk`, `/approvals`, `/archive`, `/limits`, `/orchestration` even though most are in the sidebar (S4).

### 5.2 Wiring and refresh model

Typed API wrappers over `authFetch` (`lib/api-core.ts`), domain clients (`api.ts`, `api-org.ts`, `api-hr.ts`, `api-approvals.ts`, `api-archives.ts`, `orchestration-api.ts`). WS client with app-level ping, silence watchdog, exponential backoff (`lib/ws.ts:31-186`). WS events map to debounced react-query invalidations (`hooks/use-query-invalidation.ts:13-143`).

**[S3] Two coexisting refresh paradigms:** react-query hooks (sessions, approvals, cron data, archives, skills, command-center) vs imperative `useState` + `loadData()` on Org, Kanban, Cron page, Settings, Orchestration. Consequence: those pages don't benefit from WS invalidation — e.g. the WS `org:changed` handler invalidates `queryKeys.org.all`, which the Org page never consumes — so a second client's org map goes stale until manual reload.

### 5.3 Forms and actions (all traced to endpoint level; confirmed)

| Action | Verdict |
|---|---|
| Create employee | Wired: validation, `POST /api/org/employees`, refresh, inline error banner |
| Edit employee (engine/model/effort/fallback/execution profile) | Wired: diff-only PATCH. Gap: per-role engine overrides typed but never settable from UI (S4) |
| Delete employee | Wired with confirm step. **Disable/retire lifecycle unreachable as a human action** — `use-org-changes.ts` hooks consumed by no component; lifecycle badges display-only (S3, dead capability) |
| Tickets: create/assign/reassign/drag/dispatch/escalate/delete-restore | All wired via optimistic local store + `PUT board` with `baseUpdatedAt` optimistic concurrency + WS `board:updated` reload; localStorage is a display cache, API is source of truth on load |
| Start/send/stop session runs | Wired; retry = re-send previous text (no dedicated retry endpoint); `api.resetSession` is dead code — no caller (S4) |
| Approvals approve/reject, checkpoint decisions | Wired with react-query mutations + invalidation, validation on revise-notes |
| Cron | Toggle + run-now wired. **No create/edit/delete cron job UI or client method (S3).** Toggle failure silently swallowed — `.catch(()=>{})` (`routes/cron/page.tsx:235`) leaves UI claiming enabled while server disagrees (S3) |
| Settings | Config sections → `PUT /api/config` with banners; STT wired. **Branding/appearance (portalName, operatorName, theme, accent, navOrder) persist to localStorage only** while being *hydrated from* backend `GET /api/onboarding` — edits never write back; second device shows stale values (S3, split-brain) |
| Archive | Create/delete wired. **No unarchive endpoint or UI — archive is one-way** despite the label implying reversibility (S3) |
| Skills | List/detail wired. **The primary "+ Create Skill" CTA is a no-op** — `onClick` only shows a toast telling the user to go chat (`routes/skills/page.tsx:87-101`) (S3/S4) |
| Orchestration ops | 13 actions wired (stop lease, retry continuation, pause/resume queue and task, holds create/extend/cancel, dual-lane select/apply). **"Create hold" and "Requeue" collect input via chained `window.prompt()`** (`routes/orchestration/page.tsx:461-465, 592-599`) — unvalidated, unusable on mobile (S3) |

### 5.4 Dashboard classification

**Functional-but-shallow** (per the evaluation rubric). Command Center shows real agents/running/cron/ticket metrics with per-agent usage day/week/month from `GET /api/command-center` (60s poll), honest skeleton/error/empty states — but read-only rollups, no time-series, no drill-down into run history, no WS invalidation key, and it is hidden from the nav. The Orchestration console is deeper but orphaned. **There is no first-class dashboard in the primary navigation; the default landing screen is Chat.**

### 5.5 Frontend tests

90 test files (vitest + RTL): strong on chat/talk/org components and lib (ws, backoff, orchestration-api endpoint contracts), moderate on route pages. Gaps: no tests for cron/logs/limits/skills/settings pages, `cli-terminal.tsx`, `use-query-invalidation.ts`. **All page tests mock `@/lib/api`** — endpoint renames ship green (this exact drift class already produced the dead `api.getActivity` and phantom `/api/auth/status`/`login` calls).

### 5.6 Terminal integration

Confirmed wired end-to-end: xterm.js pane obtains a 60-second HMAC PTY token (`POST /api/sessions/:id/pty-token`) and connects to `/ws/pty/:sessionId` with loopback-host/origin guards; display-only by design with scrollback replay on reconnect (`components/cli-terminal.tsx:90-116`, `gateway/pty-ws.ts`, `pty-auth.ts`).

---

## 6. Agent Orchestration Audit

### 6.1 The central finding: two parallel orchestration systems, loosely joined

1. **The live, always-on "org" system** — employees as YAML personas, per-department flat-file kanban, `ticket-dispatch.ts` driving engine CLI sessions, plus watchdogs/reconcilers. This is what runs work today.
2. **A feature-flagged, off-by-default "matrix" scheduler** — workers/roles/leases/quotas/worktrees/dual-lane in `src/orchestration/` — which, when enabled, acts as *admission control* (lease allocation + telemetry) layered over the same dispatch path. Gate: `config.orchestration.enabled !== true` → runtime is `undefined` (`gateway/server.ts:130`, `orchestration-runtime-factory.ts:17`).

Bridge: `org-worker-bridge.ts:19-77` synthesizes each Employee 1:1 into a Worker (`maxConcurrentTasks: 1`, exact-match capability pinning) — so even when the matrix layer is on, role-based/class-based scheduling is effectively neutralized to 1:1 routing.

**Consequences (confirmed):**
- **[S1] No per-employee or global concurrency cap in the default path.** The only cap (`maxConcurrentTasks:1`) lives behind the flag; with orchestration disabled, `allocateBoardDispatchLease` returns `undefined` and dispatch proceeds ungated (`ticket-dispatch.ts:200-248`). Only same-ticket re-dispatch is protected.
- **[S1] The shipped product runs without its own scheduler** — leases, quotas, headroom checks, telemetry, worktrees, and dual-lane are all opt-in.

### 6.2 Lifecycle state machines (literal values, confirmed)

| Entity | States | Transition enforcement |
|---|---|---|
| Ticket | `backlog, todo, in_progress, review, done, blocked` (`board-service.ts:5`) | **None** — membership only; `done→backlog` accepted |
| Session | `idle, running, error, waiting, interrupted` (`shared/types/sessions.ts:70`) | **None** — any→any |
| Run (ledger) | `created, running, blocked, failed, interrupted, dead_lettered, completed` (`run-ledger/types.ts:3-11`) | Enum-validated, evented; **no transition matrix** (`completed→running` allowed, verified) |
| Employee | `draft, active, probation, disabled, retired` (`operations.ts:132`) | Enum on update; **not enforced at dispatch** |
| Lease | `running, released, expired` | **Strong** — precondition-throwing accessors |
| Allocation | `allocated, completed, expired, blocked_resource` | **Strong** — derived from lease states; invalid combos unrepresentable |
| Continuation | `queued, dispatching, completed, failed` | **Strong** — transactional CAS claim, retry cap 3, dead-letter |

- **[S1, broken]** Employee availability is dead code: `isActiveEmployee` (`org.ts:1089-1092`) has zero production callers — `disabled`/`draft`/`retired` employees remain dispatchable.
- **[S2]** Only the run-ledger approaches a real FSM; tickets and sessions accept any transition.
- Versus the ideal lifecycle (created→…→retired): no "available" gate (dead code), no explicit "queued-for-agent" state (a ticket is untouched or `in_progress`), and no distinct `cancelled` in the matrix layer (composite of pause+hold+interrupt). Board `blocked` overloads failed / waiting-on-human / interrupted semantics (`board-sync.ts:126-150`).

### 6.3 Assignment

- To a **specific** employee: yes (assignee string, resolver rejects cross-department, `ticket-dispatch.ts:129-146`); `routeToManager` picks the department manager — **alphabetically first** (`:123-127`).
- To a **class/role/capability**: no, in the live path (matrix role matching exists but is 1:1-pinned by the bridge; coordinator role classification is name-substring heuristics, `coordinator.ts:128-215`) — **[S3, missing]**.
- **Reassignment is destructive; assignment history is not preserved [S2].** Assignee overwritten in place; `ticket:dispatched` events are WS-only; board sync is explicitly un-audited by design ("the board itself is derived, not canonical", `board-sync.ts:181-182`); `orchestration/audit.ts` hashes payloads under a constant actor and never covers ticket dispatch/assignment.

### 6.4 Scheduling / queueing

Matrix (flag-off): greedy role-fill with worker ranking (tier → cost class → telemetry score), quota + family constraints, `blocked_resource` queue drained priority→FIFO — no aging/anti-starvation. Live headroom via engine usage (`routing-headroom.ts:27-51`). Leases: 1h TTL, heartbeat-slid, 30s reaper, expiry can interrupt the mapped session. Retry: continuation cap 3, **no backoff**; turn-stall retries default 0, then a bounded model-escalation ladder. Board-worker (live path): 5-min tick, **one ticket per tick**, gated on working hours / chat idle / usage headroom (`board-worker.ts:61-98,170-206`). No capacity queue in the live path: dispatch with no headroom → 409, ticket skipped.

Priority fragmentation: ticket `low/medium/high` vs task `low/normal/high`, never connected (S4).

### 6.5 Tracking

Run-ledger is the strongest component: per-run session link, source, engine, prompt excerpt, state, timestamps, `run_events`, `run_errors`, parent/retry/replay links; written by every session run and orchestration lifecycle; boot-time orphan sweep → `dead_lettered`. Failures vs cancellations distinct end-to-end. Gaps: **no cost/tokens in the ledger** (cost lives only on session rows) [S3]; ledger `addArtifactReference` and lineage edges/quarantine have **no production writers** — the provenance graph has nodes but no edges [S3]; non-orchestration session outputs are not artifact-tracked [S4].

### 6.6 Fleet intelligence

No org-level health rollup exists [S2, missing]. Health is four independent reconcilers (stale-running two-strike sweep; orphaned-ticket reconciler; hourly stuck-ticket watchdog that alerts the manager; leader-ack escalation capped at 1 then silently auto-suppressed). `sleep-guard.ts` is macOS host power management, not agent staleness. Budgets: per-employee monthly caps enforced only as a hard block at session start; `warning` computed but never consumed, `exceeded` unreachable (`budgets.ts:3,16-18`) [S3, broken].

### 6.7 Extensibility

- Engine contract is minimal (`Engine { name, run }`), but **registration requires editing ≥3 hand-maintained lists** (`shared/models.ts:41-121`, `server.ts:253-273`, `ptyViewEngines`) plus a 4th already drifted (`ENGINE_LABELS` omits hermes/aider) [S3].
- **CLI vs API agents are not distinguished — there are no API engines.** All ten engines spawn CLI subprocesses; no `kind/transport` discriminator exists in the type system [S3 vs the product requirement].
- The `mock` engine is unreachable from the normal session path [S4]; session fork supports only claude/codex, the other eight throw (`sessions/fork.ts:270-277`) [S4].
- **The entire `orchestration/adapter/` provider layer (~24KB, incl. a run-status model with `cancelled`/`manual_required` and cancel support) has zero production callers** [S2, disconnected] — the live path uses only the `WebSessionDispatcher` function type.
- Model settings are coherent where wired: per-employee engine/model/effort/modelPolicy → CLI flags via a single arg-resolver chokepoint; fallback priority agent-policy → global chain → escalation ladder (`shared/model-fallback.ts:90-106`).

### 6.8 Supervision (HR / mid-pair)

- The HR layer is a **pre-decision critique gate on org mutations**, not autonomous management: hard guards (steward can never modify itself; acyclicity), risk classification forcing human approval for high-risk changes, LLM critique advisory-only (`hr-steward.ts:77-178`, `org-policy.ts:53-124`). Solid design.
- The mid-pair implementer→reviewer loop is real and bounded (passes/children/wall-clock caps, verdict parsing, loss policies) but **gated off by default** (`features.multiRoleEmployeeExecution`, `employee-execution.ts:40-42`) and, even when on, bypassed by follow-ups, queue replay, and notification dispatch (documented at `mid-pair-orchestrator.ts:26-31`) [S2]. Related: the `review` ticket status is never produced by automation.
- Org hierarchy is authorization/escalation metadata, not a work router — managers do not delegate tickets through it (`org-hierarchy.ts`, consumers: `manager-auth.ts`, escalation recipient selection).

**Genuinely solid [confirmed]:** run-ledger FSM with event/error/link tables; derived allocation states; transactional CAS continuation claims with dead-lettering; corruption quarantine + fail-closed queue pause + poison-safe operator recovery; git-worktree isolation with path-escape hardening (cap 8, non-git downgrade); the org-change critique/approval pipeline; distinct failure taxonomy end-to-end.

---

## 7. API / Backend Contract Audit

### 7.1 Surface

Hand-rolled router: `handleApiRequest` (`gateway/api.ts:44-134`) chains per-domain handlers; `matchRoute` rejects encoded slashes/`..`/NUL (good traversal hygiene). ~120 HTTP routes across auth, sessions (read/write), status/dashboards, org/tickets, orchestration, approvals, checkpoints, archives, artifacts, cron, fs, knowledge, skills, system/config, inspect, email, connectors, talk, files, plus a loopback+HMAC internal hook endpoint. Two WebSockets: `/ws` (server-push event bus + ping/pong heartbeat) and `/ws/pty/:sessionId` (token-gated terminal).

### 7.2 Auth model (confirmed, incl. live probe)

Default loopback bind = **no auth on any route** ("localhost is trusted" — verified live: unauthenticated `POST /api/org/employees` succeeded), with three browser-attack guards: CORS origin gate, DNS-rebinding Host check, `Sec-Fetch-Site: cross-site` write blocker (`server/transports.ts:53-66`, `request-guards.ts:19-38`). Network bind without auth is refused at boot unless explicitly overridden (`auth.ts:202-211`). When auth is on: gateway token, revocable hashed device-cookie sessions via TTL'd single-use pairing codes, constant-time compares. Session-scoped 30-day HMAC agent tokens are confined by a **deny list** (`scoped-token.ts:55-72`).

**Findings:**
- **[S1] Scoped agent tokens can reach the human-oversight control plane.** The deny list omits approvals, checkpoints, cron mutations, orchestration mutations, and session writes on *other* sessions. A prompt-injected agent holding its own session token can `POST /api/checkpoints/:id/decision {"decision":"approved"}` — approving **its own security checkpoint** — or approve fallback/org-change approvals, pause the orchestration queue, or stop another agent's lease. The principal is attached to the request (`transports.ts:94`) but **no handler reads it**. *Fix:* extend `scopedTokenForbidden` to approvals/checkpoints/cron/orchestration mutations, and scope session-write routes to the token's own `sessionId`.
- **[S2] "Manager" authorization is self-asserted.** `authorizeManagerScope` (`manager-auth.ts:9-33`) trusts a `managerName` supplied **in the request body** (`org.ts:241`; `orchestration-routes.ts:128,310`). Any authenticated caller can claim to be an executive. It is an org-consistency check, not authentication; should be tied to the caller's principal.
- **[S2] `/ws` upgrade double-gate breaks cookie-device auth.** The upgrade passes `authenticateGatewayRequest` (accepts device cookies) then *additionally* requires the raw gateway token (`transports.ts:160` vs `auth.ts:453-476`) — a browser paired via pairing code passes gate 1 and fails gate 2, so live events go silently dead for exactly the remote users auth mode exists for.
- **[S2] Notification-role message injection.** `POST /api/sessions/:id/message` coerces `body.role` with no principal check (`session-write.ts:619`), so any caller can inject `notification`-role messages into any session's transcript — a cross-session prompt-injection vector when combined with the scoped-token gaps above.
- **[S3] `/api/status` is always unauthenticated** yet returns connector health, engine availability, email inbox IDs, and session counts (`status.ts:220-289`) — meaningful recon on a network-exposed gateway; `/api/healthz` alone would suffice open.
- **[S3] `reloadConfig` skips `validateGatewayExposure`** (`server.ts:491-519`) — a live `PUT /api/config` can set `authDisabled`/`insecureAllowUnauthenticatedNetwork` and take effect until restart, bypassing the boot-time safety check.

### 7.3 Validation, error shape, pagination, concurrency, drift

- **[S3] No schema validation at the HTTP boundary.** zod exists but is used only for orchestration internals; exactly one HTTP field is zod-parsed. Everything else is `readJsonBody` (1 MB cap) + ad-hoc `typeof` checks — quality varies (employee/board/cron validation is good; `POST /api/sessions`, `/message`, `PUT /api/config` accept largely unvalidated bodies; `PUT /api/config` deep-merges arbitrary unknown keys into the daemon's execution policy).
- **Error envelope** is consistently `{error: string}` (aligned with the frontend `extractErrorMessage`), with stragglers (`{message}` on the hook/403 paths) and status-code oddities: `POST /api/sessions` returns **201 with a `status:"error"` session** when the engine is unavailable (S4); `/message` returns 200 `{status:"checkpoint_required"}` for a blocked run (S5).
- **[S4] Unbounded list endpoints:** `GET /api/sessions?limit=0` serializes every session; messages unbounded without `?last=N`; approvals/checkpoints/change-requests filter by state with no limit; `/api/work` and `/api/command-center` scan all sessions per request. No cursor pagination; no enforced upper bound on `limit`.
- **[S3] Ticket-dispatch TOCTOU → double dispatch.** `dispatchTicket` re-reads the board, then `await`s `resolveTicketResources` before `createSession` + a **blind `writeBoardTickets` overwrite** (`ticket-dispatch.ts:312-370`, `board-service.ts:453-462`). Two concurrent dispatches (manual + board-worker) can both pass the freshness check and create two sessions for one ticket. Cron PUT and employee PATCH have analogous read-then-await-then-write lost-update races (S4). By contrast the `PUT board` path uses per-ticket optimistic concurrency + `BoardConflictError` 409 correctly.
- **[S3] Zero type sharing web↔backend.** Every response type is hand-copied in `packages/web/src/lib/api*.ts` with no runtime validation (`get<T>()` casts). Confirmed drift: `Employee.persona` is required in the web type but **stripped** from `GET /api/org` list responses (`org.ts:151`); ticket-session nullability and `role` unions diverge. `serializeSession` also spreads the entire DB row (`transportMeta`, screening verdicts, full prompt) to every client including scoped agent tokens (S4).
- **[S5] Dead surface:** phantom frontend calls to `/api/auth/status`/`login` (orphaned `auth-gate.tsx`), several never-called backend routes (`/api/sessions/interrupted`, `GET /api/connectors`, `GET /api/tts`, change-request `apply`).

### 7.4 Key-endpoint verdicts

| Endpoint | Verdict |
|---|---|
| `POST /api/sessions` | Works; not idempotent (no request-id → retried create dispatches twice); 201-on-engine-error; unvalidated `parentSessionId` |
| `POST /api/sessions/:id/message` | Works; **notification-role injection + no principal scoping (S2)**; 200-for-blocked |
| `POST /api/sessions/:id/stop` | Solid; honestly reports `wasRunning`; kills all engines on the session key (documented) |
| `POST …/tickets/:id/dispatch` | Works; **double-dispatch race + blind board overwrite (S3)**; lease correctly released on every failure path |
| `PUT …/board` | Best-engineered write path: per-ticket optimistic concurrency, active-session protection, write-back verification; partial-accept returns 200 (clients must inspect `rejectedTickets`) |
| Employee CRUD | Works; **manager identity body-claimed (S2)**; validate-then-write race (S4) |
| `GET /api/status` + `/command-center` | Real data; **unauthenticated info exposure (S3)**; O(sessions × departments) file I/O per poll, uncached (S4) |
| `PUT /api/config` | Secret round-trip via `***` sentinel is good; **reloadConfig skips exposure re-validation (S3)**; unknown keys accepted; keys can't be deleted (merge-only) |

---

## 8. Runtime / Build / Test Audit

All commands executed on a clean clone in a Linux container (Node **v22.22.2** — deliberately off-spec vs pinned `>=24 <25` — pnpm 10.6.4):

| Command | Result | Notes |
|---|---|---|
| `pnpm install --frozen-lockfile` | **PASS** (91s) | better-sqlite3 compiles from source; warns unsupported engine but proceeds (`engine-strict=false` in `.npmrc`); pnpm ignores build scripts for baileys/esbuild/protobufjs |
| `pnpm build` | **PASS** | web (Vite, 8s) + cli (tsc) + static copy into `dist/web` |
| `pnpm typecheck` | **PASS** | both packages, tsc --noEmit clean |
| `pnpm lint` | **PASS** | eslint --max-warnings=0 clean in both packages |
| `pnpm test` | **PASS** | backend: 233 files / 1917 passed, 1 skipped (34s); web suite passes |
| `node dist/bin/cuttlefish.js setup` | **PASS** | scaffolds `~/.cuttlefish` (org/, skills/, cron/, orchestration/, config.yaml, sessions/registry.db) |
| `cuttlefish start --daemon` | **PASS with warning** | logs `ERROR Could not find Node.js >= 24 — daemon may crash` but boots and serves on :8888 |
| `cuttlefish status` / `GET /api/status` | **PASS** | health checks ok (sessions_db, connectors, engines) |
| Live API exercise | **PASS** | `POST /api/org/employees` 201 + YAML persisted; `GET /api/work`, `/api/command-center` return real computed data |
| `cuttlefish stop` | **PASS** | clean SIGTERM shutdown |
| `pnpm test:e2e` | **NOT SELF-CONTAINED** | `playwright.config.ts` has no `webServer`; assumes a gateway already running on **:7779** (a port nothing in the repo starts). Not run in CI either |

Runtime findings:
- **[S3]** E2E suite cannot run from a fresh clone (no webServer, magic port 7779) and is absent from CI (`.github/workflows/ci.yml` runs typecheck/test/build only). The three specs it contains are near-vacuous (smoke title check; nav drag persisting to localStorage; scroll test that injects a fake spacer when no session exists).
- **[S4]** Engine mismatch triangle: `package.json` engines `>=24 <25`, Homebrew `Formula/cuttlefish.rb` `depends_on node@22`, and the daemon merely warns and continues on Node 22. Everything worked on 22 in this audit, so either relax engines or make the check meaningful.
- **[S4]** Fresh start creates only `run-ledger.db` and `sessions/registry.db` eagerly; `orchestration.db`/`artifact-lineage.db` are lazy — fine, but means "database initializes cleanly" is only fully exercised once orchestration is enabled.
- **[S4]** Committed debugging debris at repo root: `explore-*.mjs`, `verify-fix*.mjs` (~3,800 LOC importing from a hardcoded `/home/ericl/...` path — cannot run for anyone else) and `scratchpad/` including `defects-raw.json`, a 84 KB internal defect/triage inventory (with security-triage notes) published in the repo — arguably **S3** for a public repo.
- **[S5]** `tests/test_giles_slot.py` is a no-op pytest stub not wired to CI; root `src/` is a governance placeholder.

---

## 9. Product Coherence Assessment

1. **Main user workflow:** chat with an executive agent that delegates, and/or file kanban tickets that get dispatched to employee agents; monitor via chat streams, kanban, and dashboards.
2. **Obvious from the GUI?** Chat-first is obvious. The ticket→agent dispatch loop is discoverable. What is *not* obvious: the operator dashboard (`/command` hidden behind an unlabeled logo) and the entire orchestration ops console (`/orchestration`, reachable only by typing the URL).
3. **Does the database support it?** Yes for sessions/runs/events/artifacts (4 WAL SQLite stores, genuinely transactional within each store). Weakly for work-items: tickets live in per-department JSON files stitched to sessions by mutable string IDs, and terminal tickets *lose* their session link (`board-service.ts:280-284`).
4. **Does the backend support it?** Yes — dispatch, mid-pair review, watchdogs, reconcilers, approvals, budgets are real and tested at unit level.
5. **Does the agent system support it?** Yes for execution and delegation; no for fleet/project-level management (concepts absent).
6. **Does the dashboard summarize it?** Command Center summarizes agents/tickets/usage from real data, but is shallow (no time-series, no drill-down into run history) and hidden.
7. **Feels like a real product:** chat + engines + kanban dispatch + approvals + the persistence layer (safe-writes, corruption quarantine, hash-chained audit log).
8. **Feels like scaffolding:** projects/fleet vocabulary, Qdrant/knowledge memory, run-ledger GUI absence, `/redesign` mock, root debris, e2e suite.
9. **Highest-risk disconnect:** the org/board layer and the orchestration/ledger layer are two half-coupled systems — assignment history, run history, and ticket↔run provenance fall into the crack between them; and the default (orchestration-disabled) dispatch path has **no concurrency cap** at all.
10. **Fix first:** cap the default dispatch path; surface the run ledger in the GUI; persist assignment/dispatch history; put the two dashboards in the nav.

---

## 10. Findings by Severity

Consolidated, de-duplicated across all audits. Each row: severity · area · evidence · why it matters · fix · effort · dependencies.

### S1 — corrupts/loses data or breaks the security model

| # | Area | Finding | Evidence | Why it matters | Fix | Effort |
|---|---|---|---|---|---|---|
| 1 | API/security | Scoped agent tokens reach the oversight control plane (approve own checkpoints/approvals, stop others' leases, pause queue) | `scoped-token.ts:55-72`; `checkpoints.ts:78-127`; principal attached at `transports.ts:94` but unread | Prompt-injected agent can self-approve its own security gate | Extend deny-list to approvals/checkpoints/cron/orchestration; enforce `principal.sessionId` on session writes | M |
| 2 | Orchestration | No concurrency cap in default (orchestration-off) dispatch path | `ticket-dispatch.ts:200-248` (lease no-op); `org-worker-bridge.ts:64` cap only behind flag | One employee runs unbounded parallel agents; resource exhaustion, billing blowout | Per-employee + global in-process run cap, flag-independent | M |
| 3 | Orchestration | Employee availability lifecycle is dead code | `org.ts:1089-1092` (`isActiveEmployee`, zero prod callers) | `disabled`/`retired` employees still receive work | Enforce active-check in `resolveDispatchEmployee` | S |

### S2 — core workflow broken or misleading

| # | Area | Finding | Evidence | Fix | Effort |
|---|---|---|---|---|---|
| 4 | API/security | `managerName` authorization is body-asserted | `manager-auth.ts:9-33`; `org.ts:241`; `orchestration-routes.ts:128,310` | Tie manager identity to the authenticated principal | M |
| 5 | API/security | `/ws` upgrade double-gate rejects device-cookie-authenticated browsers | `transports.ts:160` vs `auth.ts:453-476` | Accept device sessions in the second gate (or drop it) | S |
| 6 | API/security | Notification-role message injection into any session | `session-write.ts:619` (no principal check) | Scope `/api/sessions/:id/*` writes to the token's session | S |
| 7 | Orchestration/DB | No assignment/dispatch history; reassignment overwrites in place | `ticket-dispatch.ts:368`; `board-sync.ts:181-182`; `audit.ts:5-16` | Append-only assignment ledger; audit dispatch events | M |
| 8 | Orchestration | Durable scheduler + provider-adapter layer opt-in/off by default; `orchestration/adapter/` (~24KB) has zero callers | `server.ts:130`; `orchestration-runtime-factory.ts:17`; `adapter/index.ts` | Decide: wire the adapter layer or delete it; document the default runtime | M |
| 9 | Orchestration | Supervision (mid-pair review) off by default and bypassed by follow-ups/queue/notifications when on | `employee-execution.ts:40-42`; `mid-pair-orchestrator.ts:26-31` | Route all dispatch entry points through the mid-pair wrapper; reconsider default | M |
| 10 | Orchestration | No fleet/org-level health rollup; `sleep-guard` is host power mgmt only | `sleep-guard.ts:23-25`; absence in `org.ts`/`hr-steward.ts` | Add a fleet-health query + screen (idle/running/failed/stale per employee) | M |
| 11 | Testing | No integration/e2e test of the core journey; e2e suite vacuous and not in CI | `e2e/*.spec.ts`; `.github/workflows/ci.yml` | Add a mock-engine integration test + Playwright `webServer` in CI | M |

### S3 — major UX / architecture issues

| # | Area | Finding | Evidence |
|---|---|---|---|
| 12 | DB | Cross-database writes non-atomic (sessions ↔ run-ledger in one txn, different files) | `sessions/registry/sessions.ts:258-300` |
| 13 | DB | AI-executed nondeterministic instance migrations with `--dangerously-skip-permissions`, no verify/rollback | `cli/migrate.ts:95-128` |
| 14 | DB | No run-state transition matrix (`completed→running` allowed, verified) | `run-ledger/store.ts:439` |
| 15 | DB | Dual-lane selection manifest written with raw `fs.writeFileSync` (torn-write bricks the run) | `dual-lane-state.ts:62` |
| 16 | DB | Board JSON concurrent read-modify-write lost updates (no cross-process lock) | `board-service.ts:398-421` |
| 17 | GUI | `/orchestration` fully built but unreachable from any nav/link/search | `main.tsx:75`; grep-confirmed no inbound link |
| 18 | GUI | No dashboard in primary nav; `/command` hidden behind unlabeled logo | `nav.ts:23-35`; `pill-nav.tsx:427-439` |
| 19 | GUI | Cron jobs can't be created/edited/deleted from UI; toggle errors silently swallowed | `routes/cron/page.tsx:235` |
| 20 | GUI | Branding/name settings never persist to backend (localStorage-only, hydrated-from-server) | `lib/settings.ts:53-56`; `settings-provider.tsx:56-66` |
| 21 | GUI | Archive is irreversible (no unarchive) despite the label; employee disable/retire unreachable as a human action | `api-archives.ts`; `use-org-changes.ts:24` (unused) |
| 22 | Dataflow | Run-ledger REST (`/api/inspect/*`) has zero web consumers — run history/dead-letter is CLI-only | `api/routes/inspect.ts:24-83` |
| 23 | Dataflow | Run bundles (final outputs) written under the tmp dir, not durable storage | `shared/paths.ts:99` |
| 24 | API | No schema validation at the HTTP boundary (zod present, unused there); `PUT /api/config` accepts arbitrary keys; `reloadConfig` skips exposure re-validation | `system.ts:62-85`; `server.ts:491-519` |
| 25 | API | Ticket-dispatch TOCTOU → double dispatch + blind board overwrite | `ticket-dispatch.ts:312-370` |
| 26 | API | Zero web↔backend type sharing; confirmed drift (`Employee.persona` stripped from list) | `lib/api-org.ts:41` vs `org.ts:151` |
| 27 | API/security | `/api/status` unauthenticated info exposure | `auth.ts:181`; `status.ts:220-289` |
| 28 | Orchestration | Budget statuses partly dead (`exceeded` unreachable, `warning` unconsumed) — spend control is a hard cliff | `budgets.ts:3,16-18` |
| 29 | Orchestration | Run-ledger records no cost/tokens; lineage edges/quarantine + ledger `addArtifactReference` have no writers | `run-ledger/types.ts:33-48`; `artifact-lineage/store.ts:169-273` |
| 30 | Orchestration | Engine extensibility needs ≥3 hand-maintained lists (a 4th already drifted); no CLI-vs-API discriminator | `models.ts:41-121`; `server.ts:253-273`; `rate-limit-handler.ts:34-43` |
| 31 | Repo hygiene | `scratchpad/defects-raw.json` (84 KB internal triage incl. security notes) + hardcoded-path `explore-*.mjs` committed to a public repo | repo root |
| 32 | GUI | `window.prompt()` input flows on orchestration Holds/Recovery | `routes/orchestration/page.tsx:461-465,592-599` |

### S4 / S5 — minor defects and future improvements

Cross-client org-map staleness (`org:updated` dead event, OrgPage uses local state); `review` ticket status never produced by automation; priority-scheme fragmentation (ticket `low/medium/high` vs task `low/normal/high`); dead client capabilities (`api.resetSession`, per-role engine overrides, phantom `/api/auth/status|login`); dashboard endpoints full-scan all sessions (no retention); `SCHEMA_VERSION` stamped but never checked; Qdrant + `classic-level` unused; engine-version mismatch triangle (`package.json >=24` vs Homebrew `node@22` vs warn-and-continue); e2e not self-contained / not in CI; `tests/test_giles_slot.py` no-op stub; `/redesign` static mock shipped in the bundle; duplicated helpers (`changedFilesFromDiff`, `resolveRecoveryDir`); leader-ack escalation ceiling of 1 then silent auto-suppress.

---

## 11. Priority Implementation Backlog

### P0 — Must fix before meaningful (esp. non-localhost) use

**P0.1 — Lock down scoped agent tokens (finding 1, 4, 6)**
- Problem: session-scoped tokens can drive approvals/checkpoints/orchestration and inject notifications into other sessions; manager identity is body-claimed.
- Files: `gateway/scoped-token.ts`, `gateway/manager-auth.ts`, `gateway/api/routes/{checkpoints,approvals,session-write}.ts`, `gateway/api/orchestration-routes.ts`.
- Sketch: add approvals/checkpoints/cron/orchestration paths to `scopedTokenForbidden`; in session-write handlers require `principal.kind==="admin" || principal.sessionId===:id`; resolve `managerName` from the principal, not the body.
- Acceptance: a session token cannot approve any checkpoint/approval, cannot write another session, cannot claim manager scope. Test: contract tests asserting 403 for each.

**P0.2 — Cap concurrency in the default dispatch path (finding 2)**
- Files: `gateway/ticket-dispatch.ts`, `gateway/board-worker.ts`, config schema.
- Sketch: a flag-independent per-employee semaphore (default 1) + global cap; dispatch beyond the cap enqueues rather than 409-skips.
- Acceptance: with orchestration disabled, N concurrent dispatches to one employee never exceed the cap; the rest queue. Test: concurrency integration test with the mock engine.

**P0.3 — Enforce employee availability at dispatch (finding 3)**
- Files: `gateway/ticket-dispatch.ts`, `gateway/org.ts`.
- Sketch: call `isActiveEmployee` in `resolveDispatchEmployee`; reject `disabled`/`draft`/`retired` with a structured reason.
- Acceptance: dispatch to a disabled employee returns 409 `employee-not-active`. Test: unit + route.

**P0.4 — Fix `/ws` device-cookie auth gate + `reloadConfig` exposure re-validation (findings 5, 24)**
- Files: `gateway/server/transports.ts`, `gateway/server.ts`.
- Acceptance: a pairing-code-paired remote browser receives live WS events; a live `PUT /api/config` that would expose an unauthenticated network gateway is rejected.

### P1 — Must fix for first-class orchestration

**P1.1 — Persist assignment/dispatch history + provenance (findings 7, 29)** — append-only per-ticket assignment log (who/when/by-whom); keep the ticket→session link on terminal tickets; audit dispatch events. Acceptance: a completed ticket's full assignment + run history is queryable after restart.

**P1.2 — Surface the run-ledger in the GUI (finding 22)** — Runs / Dead-letter / Lineage screens consuming the existing `/api/inspect/*` endpoints, linked from the dashboard. Acceptance: a user inspects a historical/failed run and its events without a terminal.

**P1.3 — Resolve the two-orchestration-layer split (finding 8)** — either enable the matrix runtime by default (with the concurrency work from P0.2) or explicitly document it as an advanced admission-control add-on and delete the dead `orchestration/adapter/` layer. Acceptance: no exported-but-unreachable orchestration module; one documented default execution path.

**P1.4 — Transition guards (findings 14, and ticket/session FSMs)** — a small transition-legality table for run-ledger and tickets. Acceptance: illegal transitions (e.g. `completed→running`, `done→backlog`) are rejected. Test: unit.

**P1.5 — Integration + e2e in CI (finding 11)** — one mock-engine integration test through the real gateway (create employee → board PUT → dispatch → assert ticket `done` + session message + ledger `completed`), plus a Playwright `webServer` running a seeded workflow. Acceptance: both run in `.github/workflows/ci.yml`.

**P1.6 — Fleet health view (finding 10)** — a backend query aggregating per-employee idle/running/failed/stale + a dashboard surface.

### P2 — Should fix for product coherence

Put both dashboards in the nav (17, 18); cron CRUD UI + surface toggle errors (19); persist branding settings to backend (20); unarchive + human disable/retire actions (21); HTTP-boundary schema validation via zod (24); ticket-dispatch mutex/CAS (25); shared types package web↔backend (26); durable run-bundle location (23); replace `window.prompt()` flows (32); budget soft-warning surface (28).

### P3 — Polish / future

Project & Fleet entities (see §12); cost/tokens in the ledger (29); pluggable engine registry + CLI/API discriminator (30); dashboard query retention/caching; remove repo-root debris and `defects-raw.json` from the public repo (31); resolve Qdrant/knowledge-memory scaffolding or remove it; `/redesign` mock; engine-version mismatch triangle; delete dead code (`resetSession`, `auth-gate.tsx`, `mock`-engine wiring, duplicated helpers).

---

## 12. Target Architecture Recommendation

The current architecture is **not insufficient** — it is a working product with a high engineering floor. The recommendation is therefore **evolutionary, not a rewrite**: close the seam between the two orchestration layers and add the two missing domain entities (Project, Fleet), rather than replacing what exists.

### 12.1 How closely the repo matches the canonical model

| Canonical concept | Cuttlefish today | Gap |
|---|---|---|
| Project → owns WorkItems & Fleets | Departments-as-directories | **Missing** — no entity, no `/api/projects` (specced, unbuilt) |
| Fleet → contains Agents, has FleetHealth/Policy | UI vocabulary only | **Missing** — nearest is orchestration workers, never grouped |
| Agent → AgentConfig, Capabilities, RuntimeBinding, AvailabilityStatus | Employee YAML (config ✓, capabilities weak, runtime ✓, availability **dead code**) | Availability unenforced; capabilities free-text |
| WorkItem → Priority, Type, Status, Provenance | BoardTicket (JSON) | Provenance weak; status FSM unguarded; two priority schemes |
| Assignment → links WorkItem↔Agent, status, timestamps, assigned_by | `ticket.assignee` string | **No `assigned_by`, no history, no status of its own** |
| Run → belongs to Assignment & Agent, emits Events/Logs, produces Results | run-ledger (strong) | Not linked to an Assignment entity; no cost |
| Event → lifecycle transitions | `run_events` ✓ | Good |
| Result → artifact/output, success/failure summary | run bundles + lineage | Bundles in tmp; lineage edges unwritten |
| Dashboard → reads persistent views, never fake counters | Command Center ✓ (real data) | Shallow; hidden; no drill-down |

### 12.2 Recommended target (evolutionary)

1. **Introduce a first-class `Assignment` record** (SQLite table in the sessions or a new work DB): `{id, work_item_id, agent, assigned_by, status, created_at, released_at}`. Make reassignment an append, not an overwrite. This single addition fixes provenance, history, and the "assignment vs execution" distinction the evaluation calls for.
2. **Promote tickets from `board.json` to a `work_items` table** (or keep the JSON as a cache but make SQLite canonical), with a status transition guard and a single priority enum. This removes the board's concurrency/lost-update and un-audited-provenance problems in one move.
3. **Add `Project` and `Fleet` as thin grouping entities** over existing employees/departments and orchestration workers — a `projects.json`/table owning work-items and fleets, and a `Fleet` = named set of employees with a computed health rollup. These are additive; departments become the default project.
4. **Unify the execution path**: make the matrix runtime (or at least its lease/concurrency/telemetry core) the single default dispatcher, so there is one place where assignment → run → events flows, with the concurrency cap always applied.
5. **Introduce a `RuntimeBinding` discriminator on engines** (`kind: "cli" | "api"`, transport) so CLI agents and API-LLM agents are explicitly modeled, and register engines from a table rather than three hand-maintained lists.
6. **Cross-store integrity**: since a single SQLite file cannot span the current four, either consolidate the work/assignment/run tables into one DB (so the create-run-with-session write is one transaction) or add an outbox/reconciler that guarantees eventual consistency across them (the reconciler pattern already exists — formalize it).

Everything above reuses the existing run-ledger, worktree, corruption-recovery, and approval machinery; nothing requires discarding current code.

---

## 13. Acceptance Criteria for "First-Class Cuttlefish"

Status against each acceptance criterion (✅ met · ⚠️ partial · ❌ not met), verified this audit:

| Criterion | Status | Note |
|---|---|---|
| Fresh install works | ✅ | `pnpm install` + `build` clean (on Node 22, off-spec) |
| Database initializes cleanly | ✅ | `setup` + first `start` create registry + run-ledger DBs; orchestration/lineage lazy |
| Agents can be created | ✅ | Verified live (201 + YAML persisted) |
| Agents can be configured | ✅ | Engine/model/effort/fallback/execution profile via edit form |
| Agents can be assigned work | ✅ | Ticket assignee + dispatch |
| Assignments persist | ⚠️ | Current assignee persists; **no history, no `assigned_by`** |
| Runs are tracked | ✅ | run-ledger with events/errors/links |
| Logs/events are visible | ⚠️ | Chat stream + log tail visible; **run-ledger events GUI-invisible** |
| Results link back to tasks | ⚠️ | Via `sessionId` while active; **cleared on terminal tickets** |
| Project/fleet dashboard uses real data | ⚠️ | Dashboard data is real; **no project/fleet entity; dashboard hidden** |
| Failed runs are diagnosable | ⚠️ | Distinct failure states + errors table; **CLI-only, no GUI** |
| CLI vs API LLM agents differentiated | ❌ | All engines are CLI; no `kind` discriminator |
| GUI controls wired to real backend | ✅ | With noted exceptions (cron CRUD, skill create, branding save) |
| Advanced features don't dominate first-run UX | ✅ | Chat-first; advanced surfaces (arguably too) hidden |

**"Done" is reached when** the ⚠️/❌ rows above are closed: assignments carry `assigned_by` + history and survive restart; the run-ledger (runs, events, dead-letter, lineage) is inspectable in the GUI; terminal tickets retain their run link; a Project/Fleet dashboard reads real grouped data from the nav; failed runs are diagnosable without a terminal; CLI and API engines are distinct types; and the P0 security/concurrency items are fixed so the criteria hold under a network-exposed, multi-agent deployment, not only single-trusted-localhost.

---

## 14. Open Questions / Verification Gaps

Claims that could not be fully verified in this audit, and what would settle them:

1. **Behavior under Node 24 (the pinned runtime).** All runtime testing ran on Node 22 (the container's version); everything passed, but the daemon logs a "may crash" warning. *To verify:* run `pnpm test` + a live dispatch on Node 24.13.0.
2. **The matrix orchestration path end-to-end.** It was audited by code reading; it is off by default and was not exercised live (no orchestration config enabled, no second engine available). *To verify:* enable `orchestration.enabled` and run a multi-role/dual-lane task with two real engines.
3. **AI-executed migrations.** `template/migrations/*/MIGRATION.md` are applied by launching an engine CLI; their determinism and safety depend on model behavior and were not run. *To verify:* execute `cuttlefish migrate` across a version bump and diff the result.
4. **Real multi-engine dispatch.** Only `claude` reported `available` in this environment; codex/grok/antigravity/etc. were unavailable, so cross-engine routing, fallback ladders, and fork (claude/codex only) were verified by code, not execution. *To verify:* install ≥2 engine CLIs and dispatch across them.
5. **Connector paths (Slack/WhatsApp/email).** Audited structurally, not exercised (no credentials). *To verify:* configure a connector and drive an inbound→ticket→dispatch flow.
6. **The security findings' exploitability in a real deployment.** The scoped-token and manager-auth gaps were confirmed by reading the deny-list and handler code; they were not weaponized against a running instance. *To verify:* mint a scoped session token and attempt a checkpoint self-approval against a live gateway with auth enabled.
7. **Whether `packages/web`'s own test command passed independently.** The workspace `pnpm test` reported success overall; the backend's 233-file / 1917-test result was captured explicitly, the web suite's per-file count was not. *To verify:* run `pnpm --filter @cuttlefish/web test` in isolation.

---

*Prepared by an automated multi-agent audit (reconnaissance + six parallel domain audits: database, GUI wiring, agent orchestration, API contract, dataflow, test coverage), with first-hand runtime verification (install/build/typecheck/lint/test + live daemon boot, employee creation, and dashboard probing). Every major claim is cited to a file path or an executed command; unverified claims are enumerated in §14.*
