# Engine Stability + Context Hygiene — Design

**Date:** 2026-06-10
**Status:** Approved
**Scope:** `packages/cuttlefish` (engines, gateway, sessions, template), `packages/web` (only if reconciler events need UI handling)

## Problem

Two classes of issues:

1. **Turn-state desync.** The gateway's idea of a turn ("running" / "failed" / "completed")
   can diverge from what the engine CLI is actually doing. Observed symptoms:
   - `Error: Interactive turn failed: invalid_request` shown in chat while the underlying
     claude CLI kept working and finished the turn (visible by switching to CLI view).
   - "In progress" indicators ending while the engine still works, or persisting after it
     finished.

   Root cause: turn state is settled **once, immutably**, from racey signals, and nothing
   reconciles gateway status with live engine state afterwards.
   - `StopFailure` hook settles the `TurnResolver` as failed immediately
     (`claude-interactive.ts` `TurnResolver.onHook`), but in interactive mode the CLI
     survives API errors and often retries; the later `Stop` has nowhere to land.
   - `codex-interactive` completes turns on an 800ms quiet-window heuristic
     (`DONE_DEBOUNCE_MS`) — false completions on brief stalls.
   - Nothing ever resets a stuck `status:"running"` if `runWebSession` hangs.

2. **Context stuffing.** `buildContext()` (`src/sessions/context.ts`) injects the same
   payload into every session regardless of audience: full org roster with persona
   previews, full cron list, connector curl recipes, and the complete gateway API table.
   Meanwhile each engine *also* auto-ingests `~/.cuttlefish/CLAUDE.md`/`AGENTS.md` (one symlinked
   file), so static content (API table, connector recipes) is delivered twice. Employee
   child sessions — the most numerous session type (cron pipelines) — ingest the full
   COO manual plus an org-wide context they don't need, with their persona injected on
   top to override the contradictory COO identity.

## Design — Track 1: Stability (targeted hardening)

### 1a. StopFailure grace window (`claude-interactive.ts`)

On `StopFailure`, `TurnResolver` no longer settles immediately. It records the failure
payload and arms a **20s grace timer**:

- If a `Stop` hook arrives during grace → discard the failure, complete normally.
- If new streaming activity is observed during grace (SSE proxy deltas / PTY output) →
  keep waiting; the CLI is retrying.
- If the PTY process exits during grace → settle failed immediately (the existing
  death watchdog path); rate-limit/billing errors where the CLI truly stops still fail
  fast.
- If grace expires with no activity and no Stop → settle with the original error
  (same outcome as today, delayed 20s, only for genuinely dead turns).

`rateLimitFromStopFailure` mapping is preserved on the final settle.

### 1b. Late-recovery supersede

If a turn *was* settled as failed but a late `Stop` hook for the same engine session
arrives within the turn window, the gateway appends the recovered assistant text as a
follow-up message on the session and restores a clean completed status. Implementation:
the engine keeps its hook listener registered for a bounded period after error-settle
(instead of unregistering at settle), and surfaces a `recovered` callback that
`manager.ts` uses to persist the message + emit `session:completed`.

### 1c. Codex-interactive deterministic completion (`codex-interactive.ts`)

Codex rollout transcripts contain explicit terminal markers (verified against real
`~/.codex/sessions/**.jsonl`):

- `event_msg` payload `task_started` — turn begin
- `event_msg` payload `task_complete` with `last_agent_message` — turn end + final text
- `event_msg` payload `turn_aborted` — interrupt

These become the **primary** completion signal (analogous to Claude's Stop hook),
replacing the quiet-window as primary. The quiet-window debounce remains only as a
fallback for malformed/missed transcript lines, raised from 800ms to 3s. Result text
comes from `task_complete.last_agent_message`, with the existing transcript-tail text
extraction as fallback.

### 1d. Status reconciler sweep (gateway)

A periodic sweep (every ~15s) compares sessions with DB `status:"running"` against
live engine truth: engine `isTurnRunning()` where available, warm-PTY liveness,
resolver settled-state.

- DB says running, engine idle/dead and no in-flight `runWebSession` → persist final
  status, emit `session:completed` (unsticks spinners).
- Turn error-settled but PTY demonstrably still streaming → keep/restore `running`
  so UI matches reality (pairs with 1b which delivers the eventual result).
- Every drift correction logs one structured line (`[reconciler] ...`) for future
  diagnosis.

Out of scope: Antigravity quiet-window staleness (mitigated by
`finalizePartialMessages`, commit 8ec9fc9, plus the reconciler), full turn-state-machine
refactor (deliberately rejected in favor of targeted fixes).

## Design — Track 2: Context hygiene

### 2a. Audience scoping (`buildContext`)

| Section | COO | Manager employee | Non-manager employee |
|---|---|---|---|
| Identity / persona | COO anchor | full | full |
| Chain of command | — | yes | yes |
| Session context | yes | yes | yes |
| Configuration | yes | yes | yes |
| Org roster | compact tree (2c) | **dropped** (chain of command suffices) | **dropped** |
| Cron jobs | yes (enabled only) | **dropped** | **dropped** |
| Gateway API table | moved to static file (2b) | 4-line mini ref (spawn child / message / read session / attachments) | 2-line mini ref (attachments / connector send) |
| Connectors | dynamic values only (2b) | same | same |
| Knowledge listing | yes | yes | yes |
| Language override | yes | yes | yes |

### 2b. Static/dynamic dedupe

Content identical across all sessions moves into the engine-ingested static file
(`~/.cuttlefish/CLAUDE.md` = `AGENTS.md`) and is **removed from injection**:

- Gateway API reference table (`buildApiReference`)
- Connector curl recipe boilerplate (`buildConnectorContext` keeps only dynamic values:
  connector names, channel IDs, gateway base URL)
- Self-evolution guidance remnants

The static file is restructured into:

1. **Shared operating facts** — home directory layout, skills mechanism, gateway API
   reference, child-session protocol, conventions, git rules. Role-neutral; applies to
   any session ingesting the file.
2. **"Default role: COO"** section — explicitly marked as applying only when the
   injected session context does not name an employee. Injected employee personas
   override it by construction.

Applied to `packages/cuttlefish/template/CLAUDE.md` (fresh installs) and, by hand, to the
operator's live `~/.cuttlefish/CLAUDE.md` (preserving instance-specific custom content).
No automated migration of user-edited CLAUDE.md files — users own that file; the
template change benefits new installs and the release notes describe the manual step.

### 2c. Compact roster (COO only)

`buildOrgContext` collapses to a hierarchy tree of `Name (slug) — dept, rank` with no
persona previews, plus one pointer: full details via `GET /api/org/employees/:name` or
the YAML under `~/.cuttlefish/org/`. For a ~40-employee org: ~5K chars → ~1.5K.

**Expected net effect:** COO injected context ≈ 9K → 4K chars; employee sessions
≈ 10K → 3K; multiplied across dozens of daily cron-spawned employee sessions.

## Error handling

- Grace timer and reconciler are additive guards; on any internal error they fall
  back to current behavior (settle with original error / skip sweep cycle).
- `task_complete` parsing failures fall back to the existing quiet-window path.
- Late-recovery (1b) is best-effort: if the session was already deleted or a new turn
  started, the recovered text is dropped with a log line.

## Testing

TDD (vitest) throughout:

- `TurnResolver`: grace-window semantics (failure→Stop supersede, failure→activity→
  expiry, failure→PTY-death fast-fail), late-recovery supersede.
- Codex transcript parser: `task_started`/`task_complete`/`turn_aborted` mapping,
  `last_agent_message` extraction, malformed-line fallback.
- Reconciler: fake-clock tests for both drift directions, no-op on healthy sessions.
- `buildContext`: scoping snapshots for COO / manager / non-manager; dedupe assertions
  (API table absent from injection; dynamic connector values present).
- Full existing `cuttlefish-cli` + `@cuttlefish/web` suites stay green; typecheck both packages.

## Rollout

Source-only commits on `main`, developed in a git worktree. **No rebuild or restart of
the live gateway** until the operator explicitly schedules it. Template changes ship
with the next release.
