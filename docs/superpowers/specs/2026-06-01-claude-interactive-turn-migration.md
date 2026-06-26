# Plan: migrate Claude work turns from `claude -p` (headless) to interactive PTY

**Date:** 2026-06-01 · **Author:** Cuttlefish Dev · **Status:** PLAN - awaiting CEO review, NOT implemented · **Risk: HIGH**

## Why (motivation)
Anthropic stops subsidizing `claude -p` (headless one-shot) under the Max subscription on **2026-06-15** - only the interactive TUI keeps billing as `cc_entrypoint=cli`. Today Cuttlefish runs **all** Claude work turns through the **headless** `ClaudeEngine` (`claude -p`); after Jun 15 those turns start drawing on API credits. The directive: drive **interactive `claude`** for every turn (chat, connectors, cron, employees, child sessions) so the whole org stays on the flat Max plan.

## Current architecture (verified)
- `manager.run()` → `this.engines.get(session.engine)`. For `"claude"` that's the **headless `ClaudeEngine`** (`claude.ts`, `spawn("claude", ["-p","--output-format","stream-json",...])`). Used by **everything that isn't the xterm view**: web chat (default), Slack/connectors, **all 34 cron jobs**, employee delegations, child sessions, `/doctor`-style internals.
- `InteractiveClaudeEngine` (`claude-interactive.ts`, node-pty) exists but is reached **only** when `body.mode==="interactive"` (CLI/xterm view) - `api.ts:815/874` swap `context.interactiveClaudeEngine` in and dispatch via `dispatchWebSessionRun`. It is **not** in the manager's engine map, so cron/connectors never touch it.
- Concurrency model differs fundamentally:
  - **Headless**: one ephemeral `claude -p` child per turn; exits when the turn ends. N concurrent turns = N short-lived processes. Cheap, unbounded, fire-and-forget.
  - **Interactive**: a **persistent PTY** per session managed by `PtyLifecycleManager` (`maxLivePtys` default **8**, `CLI_KEEPALIVE_AFTER_LEAVE_MS` **10 min**). PTYs stay warm after a turn; `evictLru()` only reaps entries with **no running turn and no viewer**. Designed for a human watching a handful of live sessions.

## What the headless path provides that interactive MUST replicate
| Capability | Headless (claude.ts) | Interactive (claude-interactive.ts) - status |
|---|---|---|
| Streaming deltas → WS | parses `stream-json` events | ✅ tails transcript JSONL + PreToolUse/PostToolUse hooks |
| Result text | `result` event | ✅ `Stop` hook `last_assistant_message` |
| Usage/cost + contextTokens | result `usage` | ✅ transcript sum (+ `contextTokens` added in this same debug pass) |
| engineSessionId capture + resume | `session_id` / `--resume` | ✅ SessionStart `session_id` + `--resume` |
| effort / model flags | `--effort` / `--model` | ✅ `buildInteractiveArgs` passes both |
| append-system-prompt | `--append-system-prompt` | ✅ per-session `--settings` (written once) |
| MCP config | `--mcp-config` | ✅ supported |
| cwd | spawn cwd | ✅ |
| kill / interrupt | SIGTERM child | ✅ resolver.interrupt + lifecycle release |
| rate-limit → fallback | `rate_limit_event` → result.rateLimit | ✅ `StopFailure` → rateLimit (manager fallback works) |
| **Concurrency / unattended batch** | ✅ unbounded ephemeral | ⚠️ **the gap - see risk** |
| Hook infra dependency | none | needs `hook-relay.mjs` + per-session `--settings` + loopback hook server |

**Functionally, interactive already covers a single turn end-to-end** (it returns a normal `EngineResult`; no human needs to watch). The blocker is **scale**, not capability.

## The key risk: concurrency under unattended load
The org has **34 active cron jobs** plus employee/child delegations. These fire **headlessly and can overlap** (e.g. the content/keywordtool blog pipelines, weekly digests, proactive-research all share morning windows). With headless, 10 simultaneous turns = 10 short processes that exit. With interactive:
- Each turn spawns/holds a **warm PTY** (a full `claude` process) kept alive 10 min after the turn.
- `maxLivePtys=8`; `evictLru` can't evict a PTY with a **running** turn → under a burst of >8 concurrent turns, live PTYs **grow past the cap** (no hard backpressure) → many heavyweight `claude` processes + node-pty FDs at once = memory/FD pressure, possible host instability.
- Plus per-session hook-relay `--settings` files and a loopback hook callback per live session.

So a naive "route everything to interactive" risks **destabilizing the gateway during cron bursts** - a whole-org regression. But "keep headless for cron" **reintroduces the billing problem** the migration exists to solve. The plan must make interactive safe at scale, not dodge it.

## Options
- **A - Route ALL claude turns to interactive, naively.** Simplest code (manager uses interactive engine for `"claude"`). ❌ Concurrency risk above. Rejected.
- **B - Interactive for everything, but with a global turn-concurrency limiter + aggressive reaping (RECOMMENDED).**
  - Add a **global semaphore** on concurrent interactive *turns* (e.g. `maxConcurrentInteractiveTurns`, default ~4–6); turns beyond it **queue** (the per-session queue already exists; add a cross-session gate so a cron burst serializes instead of spawning 30 PTYs).
  - For **unattended** sessions (no xterm viewer - i.e. cron/connector/child), **reap the PTY immediately on turn end** (skip the 10-min keepalive; keepalive only when a viewer is attached). Keeps live-PTY count ≈ the semaphore limit.
  - Wire `interactiveClaudeEngine` into the manager so `engines.get("claude")` (or a mode-aware selector) returns it; keep headless `ClaudeEngine` available behind a config flag (`engines.claude.mode: headless`) as an escape hatch / fallback.
  - **Staged rollout**: (1) web chat default → interactive; bake for a day. (2) connectors. (3) cron/employees last, watching PTY count + host memory.
- **C - Interactive for interactive/chat sessions only; keep headless for cron/batch.** Safe for concurrency but **cron turns keep hitting `-p`** → API billing after Jun 15. Only acceptable if the CEO accepts paying API for cron, or cron volume is low enough to tolerate. Partial solution.

## Recommendation
**Option B, staged**, with the global interactive-turn semaphore + immediate reaping of unattended PTYs as **prerequisites** (do NOT flip cron to interactive without them). Sequence:
1. Land the semaphore + unattended-reap changes (behind config, default conservative).
2. Flip **web chat** to interactive; observe.
3. Flip **connectors**; observe.
4. Flip **cron/employees**; watch `livePids()` + memory during a known cron burst; keep `engines.claude.mode: headless` as instant rollback.

If the CEO wants speed over safety, the fastest *correct* partial is **C now + B later** - but flag that C leaves cron on API billing post-Jun-15.

## Effort / blast radius
- Manager engine-selection rewire + semaphore + lifecycle reap policy: ~moderate (touches the hot path for the **entire org** - every employee + cron). Needs a careful staged deploy + load observation, not a one-shot swap.
- **Highest-risk change of the sprint.** A regression here degrades all automated work, not just chat.

## STOP
Per instructions: **planned only, not implemented.** Awaiting CEO review of scope (B staged vs C-now) and the concurrency-limit defaults before any code change. The 4 debug-pass bug fixes (committed `f96c67d`, deployed) are independent and already live.
