# Interactive TUI Engine - Design Spec

**Date**: 2026-05-14
**Author**: platform-dev
**Status**: Draft - pending review

## Summary

Starting **June 15, 2026**, `claude -p` and the Claude Agent SDK on subscription
plans draw from a separate, small monthly "Agent SDK credit" (Pro $20 / Max 5x
$100 / Max 20x $200) instead of the generous interactive usage limits. Cuttlefish today
spawns `claude -p` per message, so all of Cuttlefish's usage - web chat, connectors,
cron, the agent org - would land in that small credit pool.

The **interactive Claude Code TUI keeps using normal subscription limits,
unchanged**. This spec adds an `InteractiveClaudeEngine` that drives the real
interactive `claude` binary inside a pseudo-terminal (PTY) so Cuttlefish's usage bills
as `cli` (interactive) rather than `sdk-cli` (headless credit).

Cuttlefish stays a bus, not a brain. No connectors, no org logic, no cron logic
changes. Only the Claude engine's process model changes, plus a new hook-relay
endpoint and an optional embedded-TUI web chat.

## Goals

- Drive Claude such that it bills against **interactive** subscription limits.
- Keep every existing surface working: web chat, Slack/Discord/Telegram, cron, org.
- Preserve structured turn data (final message, tool calls, session id).
- Preserve the web UI's per-session **Chat ↔ CLI toggle** - both render the same
  TUI-backed session, just differently.
- Keep PTYs warm intelligently so turns and web context-switches stay snappy,
  without leaking processes.

## Non-Goals

- Replacing the Codex or Gemini engines.
- Removing the existing `claude -p` engine (kept as a fallback / API-billing path).
- Token-by-token streaming on headless surfaces (not available in interactive mode).
- Shipping a modified `claude` binary (breaks the billing integrity check - see Risks).

## Key Findings (validated)

Validated against the Claude Code v2.1.87 source snapshot at `~/Projects/free-code`
and a working POC (`claude` v2.1.141, PTY via `script`).

1. **Billing bucket** is decided server-side from a `cc_entrypoint` value the
   binary injects. It is `cli` when `isNonInteractive` is false, where
   `isNonInteractive = hasPrintFlag || hasInitOnlyFlag || hasSdkUrl || !process.stdout.isTTY`.
   **POC confirmed**: interactive `claude` in a PTY (no `-p`) →
   `CLAUDE_CODE_ENTRYPOINT=cli`.
2. **Prompt injection**: a positional-arg prompt becomes `initialState.initialMessage`
   and is auto-submitted on startup, bypassing paste/menu/readiness hazards. For
   follow-up turns in a live process, the only input channel is PTY stdin
   (bracketed-paste `\e[200~`…`\e[201~` + `\r`). The CCR "remote control" bridge
   exists but is Anthropic-cloud-gated and not locally addressable - unusable.
3. **All required flags work in interactive mode**: `--resume`,
   `--append-system-prompt`, `--mcp-config`, `--model`,
   `--dangerously-skip-permissions`, `--settings`.
4. **Turn-end signal**: the `Stop` hook fires reliably at turn end and carries
   `{ session_id, transcript_path, cwd, last_assistant_message, ... }` on stdin.
   **POC confirmed.** No screen-scraping needed.
5. **Transcript**: the interactive TUI writes `~/.claude/projects/<cwd-hash>/<session-id>.jsonl`,
   appended ~every 100ms, **one line per completed content block** (not token
   deltas). Tailable for block-level progress.
6. **Folder trust**: a first run in an untrusted directory blocks on a trust
   prompt even with `--dangerously-skip-permissions`. Trust is stored in
   `~/.claude.json` under `projects[<realpath>].hasTrustDialogAccepted`.
   **POC confirmed** - note the `/tmp` → `/private/tmp` realpath gotcha.
7. **Hiding the TUI input box** (for embedded web chat): no config switch exists;
   fixed-row cropping is unreliable. A **CSS overlay** (native textarea painted
   over the bottom region) is the robust approach.

## Architecture

One engine core. Every surface - connectors, cron, org, and **both** web UI
render modes - runs on the same interactive PTY engine. The only thing that
varies is how the session's output is *consumed*.

```
                    ┌─────────────────────────────────────────┐
                    │         InteractiveClaudeEngine         │
                    │  spawn real `claude` in a PTY (no -p)    │
                    │  → bills as cc_entrypoint=cli            │
                    │  PTY lifetime governed by lifecycle mgr  │
                    └────────────┬──────────────┬─────────────┘
                                 │              │
            structured channel   │              │  raw PTY byte stream
        (Stop hook + transcript) │              │  (web "CLI" mode only)
                                 ▼              ▼
                    ┌─────────────────┐  ┌──────────────────────┐
                    │ Cuttlefish's own UI   │  │ xterm.js              │
                    │ - connectors    │  │ + CSS-overlay textarea│
                    │ - cron / org    │  │ → native streaming TUI│
                    │ - web "Chat"    │  └──────────────────────┘
                    │   mode          │
                    └─────────────────┘
                                 │              │
                                 └──────┬───────┘
                        Stop hook → POST /api/internal/hook
                        (turn-end + final message, all surfaces)
```

The web UI's per-session **Chat ↔ CLI toggle** picks the consumer: "Chat" uses
the same structured channel (Stop hook + transcript tail) that connectors and
cron use; "CLI" attaches xterm.js to the raw PTY stream. Same session, same
engine, same `--resume` id underneath.

### Component: `InteractiveClaudeEngine`

New file `packages/cuttlefish/src/engines/claude-interactive.ts`. Implements
`InterruptibleEngine` - same interface as today's `ClaudeEngine`.

**Spawn model.** Uses `node-pty` instead of `child_process.spawn`. The PTY gives
the binary a TTY on **both stdin and stdout** (required for `cc_entrypoint=cli`).

**Flag parity is mandatory.** The arg list must reproduce *everything*
`ClaudeEngine` passes today (`engines/claude.ts:108-124`), or surfaces silently
regress:
```
claude [--resume <id>] "<prompt>" \
  --chrome \                              # unconditional today - drop it and every session loses browser tooling
  --effort <level> \                      # when effortLevel !== "default"; used on EVERY turn via resolveEffort
  --model <model> \
  --append-system-prompt <sys> \
  --dangerously-skip-permissions \
  --settings <cuttlefish-settings> \
  <...employee.cliFlags> \                # raw splat, per-employee
  --mcp-config <path>                     # variadic - MUST come after the positional prompt
```
- `attachments` are appended to the prompt text (`"\n\nAttached files:\n- ..."`),
  exactly as `claude.ts:115-118` - done in the engine, not assumed.
- `--effort` and `--chrome` must be **verified to work in interactive mode**
  (added to Open Questions). `--effort` drives org-wide effort selection.
- **ARG_MAX risk**: `systemPrompt` from `buildContext` can be ~100 KB. Passing it
  as a CLI arg risks `E2BIG`. Prefer putting `appendSystemPrompt` *inside the
  per-session `--settings` JSON* rather than on argv. Validate.

Environment: clean env (filter `CLAUDE_CODE_*` / `CLAUDECODE` as today), **do not
set `CLAUDE_CODE_ENTRYPOINT`** (the binary sets it). Set `CLAUDE_CODE_NO_FLICKER`
**unconditionally** (fullscreen mode → discrete bottom slot). It is harmless for
the structured channel and means a session can be toggled into CLI mode at any
time without a respawn.

**Turn execution.** On `run()`, the engine asks the **PTY lifecycle manager**
(below) for a process for this Cuttlefish session:
- **No warm PTY** → spawn `claude --resume <id> "<prompt>"` in a PTY; the binary
  auto-submits the positional-arg prompt.
- **Warm PTY exists** (KEEP ALIVE or grace period) → inject the prompt into the
  live PTY's stdin as bracketed-paste + `\r`. No respawn, no `--resume` reload.

Either way the engine waits for the `Stop` hook callback, extracts
`last_assistant_message`, and hands the PTY back to the lifecycle manager - which
decides whether to kill it or keep it warm. The default (no KEEP ALIVE, not
viewed in the web UI) is kill-after-turn, mirroring today's `claude -p` lifecycle.

**`run()` resolution - the turn-completion contract.** This is subtle and several
audit blockers live here:
- Correlation: each Cuttlefish session gets a per-session `--settings` file whose hook
  commands embed the **Cuttlefish session id** (`session.id`, not `sessionKey`). The
  engine registers a pending resolver keyed by `session.id`; the hook endpoint
  resolves it.
- **`run()` must not resolve until BOTH `SessionStart` (Claude session id
  captured) AND `Stop` have been seen.** Claude's session id arrives via the
  `SessionStart` hook, *not* synchronously in `EngineResult`. If it's lost,
  `engineSessionId` stays null and the next turn silently starts a brand-new
  Claude session, losing all history. A missing id is a **hard error**, not an
  empty string.
- **Hook-vs-`run()` race**: `SessionStart` can fire within milliseconds of spawn,
  before the resolver is registered. The endpoint must **buffer hook payloads for
  unknown session ids** (short-TTL map) and drain the buffer on registration.
- **Watchdog**: a missed or delayed `Stop` hook would hang `run()` forever -
  wedging the `SessionQueue` slot, never clearing heartbeats/typing/reactions.
  `run()` has a **turn-timeout watchdog**; on expiry it settles with an error and
  the lifecycle manager kills the PTY.
- **`EngineResult` must synthesize `numTurns: 1`** (and a cost if obtainable -
  see Cost Tracking) so `isDeadSessionError`'s `cost===0 && numTurns===0` heuristic
  doesn't misclassify every errored interactive turn as a dead session and wipe
  `engineSessionId`.

**`kill()` / `isAlive()` / `isTurnRunning()` / `killAll()`:**
- `kill()` SIGTERM→SIGKILLs the PTY **and must independently settle the pending
  hook-resolver** with an `"Interrupted"`-prefixed error - a killed PTY emits no
  `Stop` hook, so without this `run()` hangs. The `"Interrupted"` prefix is a
  load-bearing contract checked in `manager.ts` and `api.ts` (gates skip-reply,
  skip-retry, status→`idle`).
- **`isAlive()` ≠ "a turn is running".** With warm PTYs, `isAlive()` is true
  between turns. The five call sites that do `if (isAlive) kill()`
  (`api.ts:446,464,479,609,777`) would kill warm PTYs. Add a distinct
  **`isTurnRunning(id)`** and audit every call site: interrupt-on-new-message and
  delete/reset should use `isTurnRunning` (to interrupt) but route teardown
  through the lifecycle manager's `releaseSession(id)`.
- `killAll()` must delegate to the PTY lifecycle manager (it, not the engine,
  owns the process map).

**Retry / transient-error tier is dropped.** `isTransientError` keys off exit
codes / stderr that interactive mode doesn't produce - that in-engine retry tier
simply won't fire. Acceptable (the manager-level rate-limit retry is what
matters), but state it explicitly rather than "reused unchanged".

### Component: hook relay + endpoint

**Settings file.** Cuttlefish writes a per-session settings JSON to
`CUTTLEFISH_HOME/tmp/settings/<session-id>.json` (mirroring `writeMcpConfigFile`, but
with an **atomic `.tmp`+rename** write - a hook relay must never read a
half-written file). It registers hooks:
- `SessionStart` → learn Claude's `session_id` + `transcript_path`.
- `Stop` → turn-end + `last_assistant_message`.
- `PreToolUse` / `PostToolUse` → optional progress deltas.

It should also carry `appendSystemPrompt` (ARG_MAX, see Spawn model) and **must
not drop** the permissions allowlist that `cli/setup.ts` already writes to
`$CUTTLEFISH_HOME/.claude/settings.local.json` - verify Claude Code's settings-merge
keeps both, or fold those permissions into this file.

**Lifecycle: PTY-lifetime, not turn-lifetime.** The `--settings` file is read on
*every* hook invocation, so a warm PTY needs it to survive across turns. It is
owned and cleaned up by the **PTY lifecycle manager** when the PTY dies - **not**
in `runSession`'s `finally` (which fires the instant a turn ends). `--mcp-config`
is read only at spawn, so that one can still be cleaned up post-spawn.

Each hook `command` is the **Cuttlefish hook-relay script** (written once to
`CUTTLEFISH_HOME`), invoked with the Cuttlefish `session.id` as an arg.

**Relay script.** A tiny script: reads the hook JSON from stdin, wraps it with the
Cuttlefish `session.id`, reads the gateway URL + secret from `CUTTLEFISH_HOME/gateway.json`,
`POST`s to `/api/internal/hook` with the secret header. Exits 0.

**`gateway.json`.** New file written to `CUTTLEFISH_HOME` on gateway boot, containing
`{ port, secret, pid }`. Solves three problems: (a) the relay script - a separate
process spawned by `claude` - has no other way to discover the port (it lives
only in config/memory and is `-p`-overridable); (b) the shared secret needs a
home; (c) PTY/relay pids can be reaped on next boot if the gateway crashed.
Either rewrite `gateway.json` on config hot-reload **or** make `gateway.port`
restart-only (see Configuration).

**Endpoint.** New internal route in `gateway/api.ts`: `POST /api/internal/hook`,
matched in the existing `handleApiRequest` chain, body via `readJsonBody`.
**There is no HTTP auth in Cuttlefish today** - this guard is net-new: require the
`gateway.json` secret as a header **and** independently assert
`req.socket.remoteAddress` is loopback (don't trust `config.gateway.host`, which
operators can set to `0.0.0.0`). Routes by `hook_event_name`:
- `Stop` → resolve the pending `run()` promise for that Cuttlefish session.
- `SessionStart` → record Claude session id + transcript path.
- `Pre/PostToolUse` → emit `StreamDelta` progress via the existing
  `context.emit("session:delta", …)`.
- Unknown session id → buffer in a short-TTL map (hook-vs-`run()` race).

### Component: gateway WebSocket - raw PTY channel

Cuttlefish's existing WebSocket (`gateway/server.ts`) is a **single global broadcast
bus**: one flat `Set<WebSocket>`, every event `JSON.stringify`'d to every client,
**no inbound `message` handling, no per-session routing**. Clients self-filter by
`sessionId`. CLI mode cannot reuse it - raw PTY bytes are high-volume and would
spam every tab, and there's no upstream path for stdin injection or resize.

Add a **dedicated `/ws/pty/:sessionId` channel**, handled in the `upgrade` handler
in `server.ts`:
- Per-session client registry (not the global set).
- Binary frames for PTY stdout (no JSON wrapping).
- `ws.on("message")` for upstream: stdin injection (the CLI-mode textarea send)
  and `{cols, rows}` resize reports → `pty.resize()`.
- On (re)subscribe, replay the gateway-side xterm `serialize`-addon buffer so a
  reconnecting browser gets a populated terminal.

Chat mode keeps using the existing broadcast `/ws` + `session:delta` - that path
is sound and unchanged.

### Component: transcript tailer

`packages/cuttlefish/src/engines/transcript-tail.ts`. Given a `transcript_path` (from
the `SessionStart` hook), tails the JSONL and maps appended lines to `StreamDelta`,
emitting **exactly the delta shapes the web Chat UI already consumes**
(`chat-pane.tsx` handles `text`, `text_snapshot`, `tool_use`, `tool_result`):
- `assistant` message text block → `{ type: "text", content }` **and** a
  `{ type: "text_snapshot", content }` with the full accumulated text - web Chat
  mode relies on `text_snapshot` to self-correct dropped deltas; omitting it
  regresses Chat mode.
- `tool_use` block → `{ type: "tool_use", toolName }`
- `user` message `tool_result` block → `{ type: "tool_result" }`

Block-level granularity. Used by **all structured-channel consumers** - connectors,
cron, and the web UI's "Chat" mode - to drive Cuttlefish's existing "thinking…" /
tool-use UI and reactions. Stops on the `Stop` hook. CLI mode does not need it
(xterm.js shows the TUI directly).

### Component: PTY lifecycle manager

`packages/cuttlefish/src/engines/pty-lifecycle.ts`. Gateway-side. Owns every live
`claude` PTY process **keyed by `session.id`**, and decides - on every relevant
event - whether each PTY should stay alive or be killed. It also owns each
session's `--settings` file lifetime.

**Keying - `session.id`, not `sessionKey`.** The `SessionQueue` serializes turns
by `sessionKey`, but `sessionKey` is not unique (`getSessionBySessionKey` does
`ORDER BY last_activity DESC LIMIT 1`; `duplicateSession` can collide keys). If
the lifecycle manager keyed on `sessionKey`, two turns for what the queue thinks
are different sessions could inject into one warm PTY's stdin concurrently →
interleaved bracketed-paste → corrupted prompt. **Mandate: the lifecycle manager
keys on `session.id`, and the engine refuses/serializes a second `run()` for a
session whose PTY is mid-turn** (belt-and-suspenders over the queue).

**A PTY stays alive if ANY of:**
1. **A turn is in progress** - always alive until the `Stop` hook fires.
2. **KEEP ALIVE is set** for the session - an explicit per-session opt-in
   (config field / web UI control). The PTY stays warm after the turn so
   follow-up turns inject via stdin instead of respawning + `--resume`.
   **Cron- and connector-originated sessions are KEEP-ALIVE-ineligible** - only
   web-viewed sessions get persistent warmth; otherwise a recurring cron job
   leaks one PTY per run.
3. **Grace period** - the session was viewed in the web UI within the last
   N minutes (default ~5). Keeps recently-viewed chats hot.

Otherwise the PTY is killed. The default - no KEEP ALIVE, not currently viewed -
is **kill once the turn finishes**; the next turn respawns with `--resume`.

**A PTY is force-killed (`releaseSession(id)`) on:** session delete
(`DELETE /api/sessions/:id`, batch-delete), reset (`/api/sessions/:id/reset`,
the `/new` command - note `SessionManager.resetSession` does *not* kill the
engine today, a gap to fix), engine change (the `engineOverride`/`engineSessions`
swap between `claude` and `codex` orphans a warm Claude PTY), `isDeadSessionError`,
and fork (see below). Every one of these call sites must route through
`releaseSession(id)`.

**Global PTY cap.** Cron has no concurrency limit - N jobs at the same minute →
N concurrent spawns. The manager enforces a hard cap on total live PTYs; over the
cap, new turns queue rather than spawn.

**Boot reconciliation.** After a gateway restart there are no PTYs, but the DB may
still say `running` (`recoverStaleSessions` flips those to `interrupted`). The
manager also reaps orphan `claude`/relay pids recorded in `gateway.json` from a
prior crashed run.

**Org hot-reload.** `onOrgChange` can change an employee's persona / `cliFlags`.
A warm PTY then runs a stale `--append-system-prompt`. Decision: kill warm PTYs
for affected employees on `onOrgChange` (persona changes take effect on next
spawn).

**Events that re-evaluate a PTY's fate:** turn end (`Stop` hook), KEEP ALIVE
toggled, web UI view/unview, grace-period timer expiry, idle timeout (hard cap
even on KEEP ALIVE, e.g. 30 min), `releaseSession` triggers above, `onOrgChange`,
gateway shutdown (`killAll` delegates here).

**Warm-PTY reuse.** When the engine asks for a process and a warm one exists, it
is reused (stdin injection) - no `--resume` history reload, no TUI re-render
flicker between turns.

### Component: fork

`sessions/fork.ts`'s `forkClaudeSession` currently shells out
`claude --resume <id> --fork-session --print -p …` - i.e. **headless**, which
post-June-15 bills against the Agent-SDK credit pool this whole spec exists to
avoid. Also `--resume` on an id held open by a warm PTY can conflict on Claude's
transcript file lock. Fork must: (a) `releaseSession(id)` on the source first,
then (b) fork via the interactive engine (`--fork-session` without `-p`, in a
PTY) so it also bills as `cli`. The forked session's first turn then spawns fresh
against the new id.

### Component: web chat - Chat ↔ CLI toggle

**Current state (corrected from audit).** A Chat/CLI toggle *exists* in
`chat/page.tsx` - but it is ephemeral `useState` (`viewMode`), force-reset to
`'chat'` on every session switch, and **not persisted**. Today "CLI mode" renders
`CliTranscript`, a one-shot `GET /api/sessions/:id/transcript` rendered as styled
HTML - **not a live terminal**. `xterm.js` / `node-pty` are not dependencies
anywhere in the web package. So this work is: (a) make the toggle **per-session,
persisted in `localStorage`** (drop the reset-on-switch logic; use the existing
`cuttlefish-<key>-<sessionId>` localStorage pattern from `conversations.ts`), and
(b) **replace `CliTranscript`** with a live xterm.js view. `getSessionTranscript`
can stay as a non-xterm fallback.

Both modes render the *same* TUI-backed session; the toggle only changes the
consumer.

**"Chat" mode** - Cuttlefish's own chat UI, the existing component, rendered from the
structured channel (`Stop` hook + transcript tailer) exactly as connectors and
cron consume it. No xterm.js. This is the default and the lighter-weight mode.

**"CLI" mode** - `xterm.js` attached to the raw PTY byte stream:
- *Gateway side.* The session's PTY (kept warm by the lifecycle manager while the
  chat is viewed) streams stdout over the **dedicated `/ws/pty/:sessionId`
  channel** (not the global broadcast `/ws` - see gateway WebSocket component).
  An xterm `serialize`-addon buffer is kept gateway-side for reconnect replay.
  `CLAUDE_CODE_NO_FLICKER` is already on for every session.
- *Browser side.* `xterm.js` renders PTY stdout. A native `<textarea>` is
  absolutely positioned over the bottom region of the terminal (CSS overlay),
  covering the TUI's own input box. The user types in the textarea (instant,
  local - no per-keystroke round-trip, which was the lag problem). On send, the
  message goes over the WS; the gateway injects it into PTY stdin as
  bracketed-paste + `\r`.
- *Sizing.* The browser reports viewport cols/rows; the gateway `pty.resize()`s.
  The PTY is sized a few rows **taller** than the visible xterm viewport so the
  bottom slot sits just below the fold - belt-and-suspenders with the CSS overlay.
- *Why overlay, not crop:* the input box height varies (multiline, paste refs,
  attachments) and there is no `<Static>` seam in v2.1.87, so fixed-row cropping
  over- or under-crops. The overlay treats the terminal as an opaque black box,
  which is what survives Claude Code version churn.

**Snappy chat switching.** Today `ChatPane` is a *single* instance keyed by
`sessionId`; switching wipes `messages`/`streamingText` and refetches. To keep
recently-viewed chats instant, render **N `<ChatPane>` instances** (one per
recent tab, `display:none` for inactive) or a keep-alive wrapper, instead of one
that remounts. Needs a `lastViewedAt` field added to `ChatTab` (`use-chat-tabs.ts`
persists tab metadata but has no timestamps) to pick the "recent N". Backgrounded
panes should rely on the WS delta stream, **not** React Query - `use-query-
invalidation.ts` invalidates `sessions.detail(id)` on every `session:completed`,
which would refetch across all warm panes. Keep N smaller than `MAX_TABS` (12).

This pairs with the lifecycle manager's grace-period keep-alive: switching back to
a recent chat is instant on both the UI and the process side. After the grace
window, the cached UI state and the warm PTY are both released.

### Component: cost & turn tracking

**This is a blocker, not a nicety.** `claude -p --output-format json` returns
`total_cost_usd`; the `Stop` hook payload does **not**. Today `result.cost` feeds
`accumulateSessionCost`, the cost dashboard, org cost rollups (`notifyParentSession`,
`session:completed`), and - critically - **`checkBudget`, which gates whether a
session is allowed to run at all** (`manager.ts:291-314`). If cost is silently 0,
budget enforcement becomes a no-op.

**VALIDATED 2026-05-14.** Concrete source and implementation:

- **Primary (chosen): transcript JSONL `assistant` lines.** Every `assistant`-type
  line carries `message.usage` with the following fields (confirmed across all POC
  sessions, model `claude-opus-4-7`):
  - `input_tokens` - fresh non-cached tokens
  - `output_tokens` - output tokens
  - `cache_creation_input_tokens` - tokens written into the prompt cache
  - `cache_read_input_tokens` - tokens read from the prompt cache
  - `server_tool_use.web_search_requests` - web search count
  - `service_tier`, `speed`, `iterations` (internal, not needed for cost)

  Sum these across all `assistant` lines in the turn, **deduplicated by
  `message.message.id`** (required: when `--effort high` is set, thinking mode
  produces two `assistant` lines with the same `message.id` - one with a
  `thinking` block and one with the `text` block; they carry identical `usage`,
  so the second must be skipped). Compute cost via Cuttlefish's existing model-cost
  tables (`gateway/costs.ts`, `additionalModelCostsCache`) using the `message.model`
  field on the assistant line.

- **`~/.claude.json` `lastCost` / `lastModelUsage` / `lastTotalInputTokens` etc.:
  UNRELIABLE for Cuttlefish's use case.** These fields are populated only when the
  interactive `claude` process exits *gracefully* (via `/exit` or Ctrl+D). When
  Cuttlefish kills the process after the `Stop` hook fires (SIGTERM or SIGKILL), these
  fields remain zero from the previous normal exit. **Do not use as primary or
  fallback.** They exist in `~/.claude.json` under `projects[cwd]` but will
  always be stale in Cuttlefish's kill-after-turn model.

- The interactive `EngineResult` populates `cost` from the transcript-parsed
  usage and `numTurns: ≥1`. The transcript is available at `transcript_path` from
  the `SessionStart` hook payload and is appended before the `Stop` hook fires.

Note `runWebSession` never calls `accumulateSessionCost` today (only the manager's
`runSession` does) - web-session cost surfaces only via the `session:completed`
payload. Fixing the cost source fixes both paths.

### Component: rate-limit detection (interactive)

Another blocker the original draft under-scoped. `detectRateLimit` /
`EngineRateLimitInfo` / `recordClaudeRateLimit` / the `waiting`-status retry loop
/ Codex fallback / `isLikelyNearClaudeUsageLimit` preflight are **100% dependent
on `claude -p`'s structured `rate_limit_event` JSON**, which interactive mode
never emits. Left alone, the entire rate-limit machinery silently goes dark -
sessions just hang or error.

**VALIDATED 2026-05-14.** Concrete mechanism: the **`StopFailure` hook**.

When an API error (rate limit, auth failure, billing error, etc.) ends a turn,
Claude Code fires **`StopFailure` instead of `Stop`**. The hook payload carries:
```json
{
  "hook_event_name": "StopFailure",
  "error": "rate_limit",          // enum: rate_limit | authentication_failed |
                                  //   billing_error | invalid_request |
                                  //   server_error | max_output_tokens | unknown
  "error_details": "...",         // optional human-readable details
  "last_assistant_message": "..."  // optional partial response
}
```
(Source: `free-code/src/utils/hooks/hooksConfigManager.ts:100-115`,
`free-code/src/entrypoints/sdk/coreSchemas.ts:529-537`,
`free-code/src/utils/hooks.ts:3594-3627`.)

This is structured, reliable, and requires no transcript scanning or PTY banner
parsing. The Cuttlefish hook-relay settings file must register a `StopFailure` hook
alongside `Stop`. The hook endpoint (`/api/internal/hook`) routes `StopFailure`
events to reconstruct an `EngineRateLimitInfo` and reject `run()` with a
rate-limit error - matching the contract Cuttlefish's `manager.ts` wait-retry loop
already handles.

**`Notification` hook does NOT fire for rate-limit events.** It fires only for
desktop "turn complete" notifications when the interactive TUI is backgrounded
(idle >6 s before completion). It is not a rate-limit signal and was not needed.
PTY banner scanning and transcript scanning were also evaluated and rejected:
neither provides a structured, parseable rate-limit signal without fragile
regex over terminal escape sequences or an undocumented transcript entry type.

**Implementation note:** register `StopFailure` in the per-session settings file
alongside `Stop`. The existing hook-relay script can forward both. The endpoint
checks `hook_event_name` and routes accordingly. No existing `manager.ts` /
`api.ts` wait-retry logic changes are needed - the engine simply must resolve
`run()` with an error whose shape matches `detectRateLimit`'s expected input.

### Component: configuration

`engines.claude` (`shared/types.ts`) gains `mode?: "headless" | "interactive"`,
`keepAlive?: boolean`, `idleTimeoutMs?`, `graceWindowMs?`. Caveats from audit:
- `loadConfig()` does **no validation or defaulting** - `mode` will be `undefined`
  for every existing user. Default to `"headless"` **at the read site**, and treat
  a garbage value as `"headless"` rather than throwing. `cli/setup.ts`'s
  `DEFAULT_CONFIG` emits `mode: headless` explicitly for new installs.
- Hot-reload does **not** reach the engine: `SessionManager` captures `config` by
  value with no setter, and the engine instance is created once at gateway boot.
  **Decision for v1: `engines.claude.mode` and `gateway.port` are restart-only**
  - documented, not silently ignored. (A later version can add a config setter +
  engine swap.) Other knobs (`keepAlive`, timeouts) can be read live.

### Component: trust pre-seeding

On gateway startup, ensure the **real** `~/.claude.json` (the user's home, *not*
the existing `$CUTTLEFISH_HOME/.claude/settings.local.json` that `cli/setup.ts` writes)
has `projects[realpath(CUTTLEFISH_HOME)].hasTrustDialogAccepted = true` and
`hasCompletedProjectOnboarding = true`. Idempotent, atomic write. `realpath` is
mandatory (the `/tmp` → `/private/tmp` gotcha). Cuttlefish runs all engine processes
with `cwd: CUTTLEFISH_HOME` today (`manager.ts` hard-codes it), so this is a single
path.

## Data Flow

**Connector / cron turn (e.g. a Slack message):**
1. `SessionManager.runSession` calls `engine.run(opts)` (unchanged call site).
2. The engine writes the per-session settings file (if not already present for a
   warm PTY) and asks the lifecycle manager for a process: warm PTY → inject
   prompt via stdin; otherwise spawn `claude --resume <id> "<prompt>" …` in a PTY.
   (Trust is already seeded - done once at gateway startup.)
3. The engine registers its pending resolver, then `SessionStart` hook → gateway
   records Claude session id + transcript path → transcript tailer starts.
   (Hook payloads arriving before the resolver is registered are buffered.)
4. Tailer emits `text` / `text_snapshot` / `tool_use` deltas → `onStream` →
   existing reaction/typing UI.
5. `Stop` hook → gateway resolves `run()` with `last_assistant_message` (only
   once both SessionStart id and Stop are seen). A watchdog covers a missed hook.
6. Engine returns `EngineResult` (with synthesized `numTurns`, cost from the cost
   component); hands the PTY to the lifecycle manager, which kills it (default,
   incl. all cron/connector turns) or keeps it warm. Rest of `runSession` unchanged.

**Web chat turn:**
1. User sends a message from the web UI. Same `run()` path as above - the
   lifecycle manager keeps the PTY warm because the session is currently viewed
   (grace period) and/or KEEP ALIVE is set, so the prompt is injected via stdin.
2. **Chat mode**: transcript tailer + `Stop` hook drive Cuttlefish's own chat UI.
   **CLI mode**: xterm.js renders the live PTY stream; the toggle is read from
   `localStorage`. Both modes observe the same turn.
3. `Stop` hook → persist `last_assistant_message` to Cuttlefish's DB, update status.
4. On switch-away, the UI state is cached and the PTY stays warm for the grace
   window; after it expires both are released.

## Tradeoffs Accepted

- **No token-level streaming on headless surfaces** - block-level only. Slack/
  Discord/cron post whole messages anyway, so impact is minimal. Web chat keeps
  full streaming via xterm.js.
- **Heavier process model** - a persistent PTY per open web chat tab; per-turn
  spawn for headless (same weight as today).
- **Native dependency** - `node-pty` (has prebuilds; falls back to node-gyp).
- **Branding** - showing the verbatim TUI in web chat leans on Anthropic's SDK
  branding guidance ("don't mimic Claude Code visual elements"). Grey for a
  self-hosted OSS tool; the headless path renders in Cuttlefish's own UI and is clean.

## Risks

- **Server-side heuristics.** Anthropic could, post-June-15, detect automated
  interactive sessions server-side - unknowable from source. The POC proves it
  works *today*. Treat as a monitored risk, not a blocker.
- **ToS.** Anthropic discourages third-party tools leveraging subscription rate
  limits. Self-hosted, user's own subscription, user's own logged-in `claude` is
  a grey area; the user has accepted this.
- **Binary integrity.** The billing header carries an integrity hash over the
  genuine binary. We must run the unmodified `claude` - PTY-wrapping is fine,
  patching `free-code` and shipping it is **not** (would flip to a non-`cli`
  bucket or fail attestation).
- **Version drift.** Hook payloads, flag behavior, and TUI layout can change
  across `claude` versions. Mitigations: black-box the terminal (overlay, not
  crop); pin a tested `claude` version range; smoke-test on upgrade.
- **"Review hooks" prompt.** `--settings` with hooks *could* trigger a review
  prompt that blocks a non-interactive driver. The POC did not hit it with
  `--dangerously-skip-permissions` - but validate across versions.
- **Orphan PTYs on crash.** Warm PTYs (and their `claude`/MCP children) outlive a
  *crashed* gateway - `cleanup()` only runs on graceful SIGTERM. Mitigation: pids
  in `gateway.json`, reaped on next boot. `node-pty`'s process-group handling
  differs from today's `detached`+`process.kill(-pid)`; verify children are reaped.
- **Wedged sessions on a missed `Stop` hook.** With no process-exit fallback, a
  dropped hook would hang `run()`, the queue slot, heartbeats, and reactions. The
  turn-timeout watchdog is the mitigation - it must be reliable.
- **Cost-blind budgets.** Until cost tracking is validated (see component),
  `checkBudget` could silently pass everything. Migration step 3 is gated on this.

## Migration Path

0. **Validation spike** - resolve the Open Questions below that gate the design:
   `--resume "<prompt>"` auto-submit, bracketed-paste follow-ups, `--effort` /
   `--chrome` in interactive mode, ARG_MAX for the system prompt, and the cost &
   rate-limit data sources. The design has known-unknowns; settle them first.
1. Add `InteractiveClaudeEngine` alongside `ClaudeEngine`. Config key
   `engines.claude.mode` (default `headless`, restart-only). `gateway.json`
   writer. The turn-completion contract (SessionStart+Stop, watchdog, hook-buffer,
   `numTurns` synthesis), `isTurnRunning`, `kill()` settling the resolver.
2. Land the hook relay script, `/api/internal/hook` endpoint (auth + loopback),
   settings-file writer (atomic, PTY-lifetime), trust pre-seeding, transcript
   tailer, and the **PTY lifecycle manager** (keyed on `session.id`; start with
   kill-after-turn + `releaseSession` wired into delete/reset/engine-change;
   KEEP ALIVE and grace period come in step 4).
3. Build **cost & turn tracking** and **interactive rate-limit detection** - both
   are blockers, not nice-to-haves. Then switch **connectors and cron** to
   `interactive`. Validate billing on the Anthropic usage dashboard and confirm
   `checkBudget` still trips.
4. Web UI: dedicated `/ws/pty/:sessionId` channel; per-session **Chat ↔ CLI
   toggle** (localStorage, drop reset-on-switch); replace `CliTranscript` with the
   xterm.js + overlay live view; the **KEEP ALIVE** control; grace-period
   keep-alive; multi-`ChatPane` recently-viewed cache (`lastViewedAt`).
5. Fork: route `forkClaudeSession` through the interactive engine; `releaseSession`
   the source PTY first.
6. Keep `ClaudeEngine` (`claude -p`) as a selectable fallback for users who
   prefer API-key billing or if interactive mode regresses.

## Open Questions / Validation Steps

The **step 0 validation spike** must resolve these before the design is locked:

- **RESOLVED** `claude --resume <id> "<prompt>"` **auto-submits the prompt**.
  Validated 2026-05-14 (claude v2.1.141): `Stop` hook fired in ~3s,
  `last_assistant_message = "RESUME_OK"`, same `session_id` as the original
  session - history resumed correctly. The spawn path (no warm PTY) works as
  designed.

- **RESOLVED (with CRITICAL caveat)** Bracketed-paste injection submits follow-up
  turns for prompts that do **not** start with `/`. Validated: injecting
  `\x1b[200~Reply with exactly PASTE_OK\x1b[201~\r` into a live PTY via
  `pty.openpty()` + `os.write()` fired `Stop` in ~9s,
  `last_assistant_message = "PASTE_OK"`.

  **HOWEVER: bracketed-paste mode does NOT neutralize a leading `/`.**
  Injecting `\x1b[200~/Reply with exactly SLASH_OK\x1b[201~\r` triggered the
  TUI's slash-command handler - output: `Unknown command: /Reply` + `Args from
  unknown skill: with exactly SLASH_OK`. The turn was never submitted and
  `Stop` did not fire. Paste-mode does NOT protect `/`, `@`, or `!` prefixes.

  **Design implication**: the engine MUST pre-process every user prompt before
  PTY injection to escape or strip a leading `/`, `@`, or `!`. A safe approach
  is to prefix such prompts with a zero-width space (U+200B) or a Unicode
  invisible character, or to wrap in a double bracketed-paste with the prefix
  character sent separately as a literal keystroke before the paste region.
  Alternatively, keep a per-session "avoid leading slash" normalization step in
  `InteractiveClaudeEngine` before calling `os.write(ptyMaster, pasteSeq)`.
  **Every turn must use the FIFO/paste path for follow-ups in a warm PTY.**
- **RESOLVED** `--effort high` and `--chrome` **work in interactive mode**.
  Validated 2026-05-14 (claude v2.1.141): both flags accepted, no arg-parse error
  or crash. PTY banner confirms `Opus 4.7 (1M context) with high effort · Claude
  Max`; Stop hook fired, `last_assistant_message = "FLAGS_OK"`. The interactive
  engine's flag list can keep `--chrome` unconditional and `--effort <level>` as
  today.

- **RESOLVED** ARG_MAX for the ~120 KB system prompt: **both paths work on
  macOS** (ARG_MAX = 1 048 576 bytes). Validated 2026-05-14 (claude v2.1.141):
  - **argv**: `--append-system-prompt <120 000-char string>` - Stop fired, no
    E2BIG, `last_assistant_message = "ARG_OK"`. The 117 KB string fits comfortably
    in macOS's 1 MB ARG_MAX.
  - **settings file**: `appendSystemPrompt` key in the per-session `--settings`
    JSON (120 226-byte file) - Stop fired, `last_assistant_message = "ARG_OK"`.
    `appendSystemPrompt` is a valid Claude Code settings key.

  **Recommendation**: use the settings-file path regardless (it is also
  safer for Linux containers where ARG_MAX may be tighter), and keep argv as a
  fallback. The per-session `--settings` file already must exist for hooks, so
  folding `appendSystemPrompt` into it adds no new file.
- **RESOLVED** **Cost source**: transcript JSONL `assistant` lines are the
  reliable source. Every `assistant` line carries `message.usage` with
  `input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
  `cache_read_input_tokens` (confirmed 2026-05-14, claude v2.1.141, all POC
  sessions). Compute cost via `message.model` + `gateway/costs.ts`. Deduplicate
  by `message.message.id` - thinking-mode turns produce two `assistant` lines
  (thinking block + text block) with the same `message.id` and identical usage.
  `~/.claude.json` `lastCost`/`lastModelUsage` fields are UNRELIABLE: they are
  zero whenever claude is killed (SIGTERM or SIGKILL after the Stop hook), which
  is Cuttlefish's normal pattern. Do not use.
- **RESOLVED** **Rate-limit source**: the **`StopFailure` hook** is the concrete
  mechanism (not `Notification`, not transcript scanning, not PTY banner parsing).
  `StopFailure` fires instead of `Stop` when an API error ends the turn; its
  payload carries `error: "rate_limit"` (or other error type). Register
  `StopFailure` in the per-session settings file alongside `Stop`. The `Notification`
  hook does not fire on rate-limit events - it is a desktop notification hook
  for backgrounded turns and was not fired in any POC session.
- Confirm the `Stop` hook fires on user-interrupted turns (`kill()` path); if not,
  the watchdog + `kill()`-settles-resolver is the only safety net.
- Confirm `--settings` hooks never trigger a blocking "review hooks" prompt under
  `--dangerously-skip-permissions`, across `claude` versions.
- Confirm `CLAUDE_CODE_NO_FLICKER` fullscreen output renders cleanly in xterm.js.
- Confirm Claude Code's settings merge keeps the `settings.local.json` permissions
  allowlist alongside the per-session `--settings` file.
- Measure transcript-tail visibility latency (100ms batched appends + fs flush).
- `node-pty` prebuild availability + child-process reaping on target platforms.
