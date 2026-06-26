# Analysis v2: subsidized Claude + token streaming - best-of-both? (NEW constraint: `-p`/headless is de-subsidized)

**Date:** 2026-06-01 · supersedes the "cost-neutral / don't migrate" conclusion of v1 (which reasoned only from client source and couldn't see server-side billing policy). **Status:** ANALYSIS - NO code changed. Evidence = live `claude` 2.1.158 spawns (raw stdout shown) + `~/Projects/free-code` source (file:line).

## NEW authoritative constraint (from CEO)
Running `claude -p` (headless/print) after ~**2026-06-14** bills **extra usage NOT covered by Max**. A real **interactive** `claude` IS covered. So we must get work turns + chat off the de-subsidized path. Non-negotiable.

## The make-or-break question - answered with raw evidence
**Q: Can a non-`-p` `claude` emit parseable per-token streaming?** → **YES, mechanically.** Live test, no `-p`:
```
echo '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Count 1..5"}]}}' \
 | claude --input-format stream-json --output-format stream-json --include-partial-messages --verbose --model opus
→ exit 0; stdout: stream_event:message_start, content_block_delta×2 (delta:"1\n2\n3\n4\n5"), assistant, message_delta, result
```
The "(only works with --print)" help text is misleading: the streaming writer is gated on `outputFormat==='stream-json' && verbose` (`free-code/src/cli/print.ts:884`), and the enabling boolean is **`isNonInteractive = hasPrintFlag || --sdk-url || !process.stdout.isTTY`** (`main.tsx:803`). A **non-TTY pipe satisfies it without the literal `-p`.**

## …but it does NOT achieve subsidy. The decisive catch.
Billing identity sent to the server is **`cc_entrypoint`**, set as:
```
process.env.CLAUDE_CODE_ENTRYPOINT = isNonInteractive ? 'sdk-cli' : 'cli'   // free-code/src/main.tsx:539
```
emitted in the billing header `cc_entrypoint=…` (`free-code/src/constants/system.ts:74-85`). So **every machine-readable-streaming path sets `isNonInteractive=true` → `cc_entrypoint=sdk-cli`** - the same billing class as `-p`. The literal `-p` token appears **only in telemetry** (`logging.ts:507`), never in a request header. The server cannot distinguish `-p` from a no-`-p` non-TTY pipe; both are `sdk-cli`.

**Therefore the two goals are mutually exclusive at the `isNonInteractive` branch:**
- **Subsidized** ⇒ `cc_entrypoint='cli'` ⇒ requires a **real interactive TTY** (no `-p`, no pipe, no `--sdk-url`) ⇒ output is the **Ink TUI**, which never routes through the stream-json writer.
- **Machine-readable token streaming** ⇒ `isNonInteractive=true` ⇒ `cc_entrypoint='sdk-cli'` ⇒ billed like `-p` (de-subsidized).

**VERDICT: best-of-both (Max-subsidized + per-token stream-json) is NOT achievable by flag choice.** The no-`-p` stream-json pipe is a *streaming* win but **not a billing win** - it is almost certainly de-subsidized too (identical `sdk-cli` entrypoint).

### One caveat for the CEO to confirm with Anthropic (could reopen best-of-both)
The de-subsidy could key on either (a) the **`cc_entrypoint=sdk-cli`** header (what the source shows the server receives) or (b) the literal `-p` token (which the server can't see in-request). If - and only if - Anthropic's trigger is specifically the `-p` token and `sdk-cli`-via-pipe is treated as subsidized, then the **no-`-p` stream-json pipe IS best-of-both** (subsidized + per-token, no PTY, scales like today). The source says it's the entrypoint, so the **safe assumption is: no - they're the same class.** Worth a direct billing-docs/account check because it's the difference between "trivial win" and "real tradeoff."

## If we accept the tradeoff (subsidized interactive, no clean stream-json): what streaming survives?
From an interactive TTY (PTY) session, ranked:
1. **Per-content-block via transcript tail (RECOMMENDED, already built).** The transcript JSONL is written once per *completed* block, never per-token (`free-code/src/QueryEngine.ts:728`; token `stream_event`s are never persisted, `QueryEngine.ts:788-828`; UI-only `streamingText`, `REPL.tsx:1461-1470`). Our `claude-interactive.ts` already tails it + emits PreToolUse/PostToolUse markers → a typical multi-step turn yields **6–20+ mid-turn updates** (each text block, each tool start/result). Only the intra-block typing animation is lost. Low complexity, low brittleness.
2. **Ink ANSI repaint parsing** - sub-token visually but throttled 60fps cell-diff repaints (`ink.tsx:213`, `log-update.ts`); needs a full terminal-emulator + frame-diff + spinner/markdown filtering; breaks on resize/theme/version. High brittleness. Only if literal token animation is mandatory.
3. **Per-token transcript tail** - impossible (never persisted).

## Concurrency / ops reality (the cron circle)
- Subsidized ⇒ interactive PTYs. Today `PtyLifecycleManager maxLivePtys=8` is **not a real cap** (`run()` spawns before checking; `adopt()` always inserts - `claude-interactive.ts:419-422`, `pty-lifecycle.ts:55-56,143`). 34 crons fan out 07:00–10:00 → 5–15+ concurrent → 15+ resident `claude` TUIs (heavy) unless we add an admission gate/queue.
- **Max rate limit (5h + weekly)** is the true org ceiling regardless of mode; funnelling the whole org (Opus) through one Max sub can exhaust the 5h window and (default `rateLimitStrategy:"wait"`) serialize everyone behind the reset.
- **Squaring cron:** cron on `-p` now costs money; cron subsidized needs PTYs (heavy + rate-limit pressure). Realistic answer: **interactive-PTY for everything, with (a) a real concurrency admission gate + immediate reaping of unattended PTYs, and (b) `rateLimitStrategy:"fallback"` to Codex for cron/batch bursts** so a Max-limit window doesn't stall the org.

## Recommendation + plan
**Path:** migrate Claude work turns + chat to the **interactive PTY engine** (`claude-interactive.ts`, `cc_entrypoint=cli`, subsidized), **accepting per-content-block streaming** (6–20 updates/turn - not per-token). This is ~90% already built (it backs the xterm view today + now emits `contextTokens`). Required additions:
1. Route `manager.run` claude turns to the interactive engine (wire `interactiveClaudeEngine` into the manager; keep headless `claude.ts` behind `engines.claude.mode: headless` as rollback).
2. **Concurrency admission gate** (global semaphore on concurrent interactive turns) + **reap unattended-session PTYs immediately** (keepalive only when a viewer is attached) - prerequisite before flipping cron.
3. `rateLimitStrategy:"fallback"` for cron/batch.
4. **Staged rollout**: chat → connectors → cron, watching `livePids()` + memory + Max usage.

**Effort:** medium-high (hot path for the whole org). **Rollback:** config flag to headless. **Risk:** concurrency + Max rate-limit exhaustion - must land the gate + fallback first.

**Pre-req before ANY of this:** CEO confirms with Anthropic whether the trigger is the `-p` token or the `sdk-cli` entrypoint. If it's literally `-p`, the no-`-p` stream-json pipe is the trivial best-of-both and this whole PTY migration is unnecessary. The source says entrypoint (so assume the tradeoff is real), but a 1-question billing check could save the entire migration.

**No code changed - analysis only. Awaiting CEO direction.**
