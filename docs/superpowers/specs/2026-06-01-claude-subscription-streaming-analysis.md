# Analysis: Claude subscription billing × token streaming - does the `-p`→interactive migration make sense?

**Date:** 2026-06-01 · **Author:** Cuttlefish Dev (5-agent read-only analysis vs `~/Projects/free-code` CLI source + live binary 2.1.158 + our engines) · **Status:** ANALYSIS - verdict for CEO review, NO code changed.

## TL;DR / VERDICT
**Do NOT migrate Claude work turns to interactive/PTY.** The analysis overturns the premise:
1. **Billing is decided by which credential is present, NOT by `-p` vs interactive.** Both modes bill the **Max subscription** on this machine. The migration is **cost-neutral** - it achieves nothing billing-wise.
2. **Interactive/PTY does NOT keep clean token streaming** - only Ink alt-screen ANSI repaints (unparseable) or per-*message* transcript tailing (coarse). **Headless `-p --output-format stream-json --include-partial-messages --verbose` DOES stream per-token - and we already use it.** Migrating would *lose* streaming smoothness.
3. **PTY would worsen concurrency** (no real cap; would spawn 15+ resident `claude` processes under the morning cron-fanout peak) and **the real ceiling is the Max-subscription rate limit** (5-hour/weekly), which is **mode-independent**.

So the migration is **all downside**. The CEO's actual goal - "run claude as a user on the Max subscription" - **is already met by the current headless path**, contingent only on one env-hygiene invariant.

---

## 1. Make-or-break: does interactive keep token streaming? - NO (clean), headless YES
- **Headless `-p` already streams per-token.** `--output-format stream-json` + `--include-partial-messages` (+ mandatory `--verbose`) emits incremental `content_block_delta`/`text_delta` events on stdout. Source: gated at `free-code/src/QueryEngine.ts:818` (re-emits `stream_event` only when `includePartialMessages`), written at `free-code/src/cli/print.ts:884`, `--verbose` enforced at `print.ts:787`. **Empirically confirmed** (`claude -p "count 1..5" --output-format stream-json --include-partial-messages --verbose` produced `message_start → content_block_delta×N → … → result`). Our `claude.ts` already parses these into `text` deltas.
- **Interactive TUI does NOT expose clean token deltas externally.** Streaming `text_delta`s feed React `streamingText` state (`free-code/src/utils/messages.ts:3048-3054`, `screens/REPL.tsx:1464-1469`) and are painted by **Ink as throttled full-region ANSI repaints** (`REPL.tsx:1461-1463`) - a PTY reader sees redraw escapes of the whole growing block, not appended tokens. Alt-screen (opt-in for external users) makes it worse.
- **Transcript JSONL is per-message, not per-token.** `recordTranscript` writes whole completed messages after the turn (`free-code/src/utils/sessionStorage.ts:1408`; `QueryEngine.ts` records only finalized assistant/user msgs, never `stream_event`). Tailing it = per-message granularity. Our `claude-interactive.ts` does exactly this (documented at `claude-interactive.ts:131-136`).

**Conclusion:** the only clean external per-token stream is the headless `-p` path we already run. Interactive = lose token-level streaming (degrade to per-message).

## 2. The billing bombshell: auth-credential-determined, not mode-determined
- `isClaudeAISubscriber()` (`free-code/src/utils/auth.ts:1621`) = `isAnthropicAuthEnabled() && shouldUseClaudeAIAuth(scopes)` (inference scope). **No print-mode check anywhere.**
- Client wiring (`free-code/src/services/api/client.ts:323-338`): subscriber ⇒ `apiKey:null, authToken:<OAuth bearer>` (subscription billing). Same for `-p` and interactive.
- **The ONLY thing that flips to metered API billing:** an external API credential in the env - `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `apiKeyHelper` makes `isAnthropicAuthEnabled()` false (`auth.ts:144-149`). This affects BOTH modes equally.
- `cc_entrypoint` / `cc_workload` headers (`free-code/src/constants/system.ts:68-89`) are **telemetry/QoS only, not credential selectors** (`cc_workload=cron` just hints a lower-QoS pool).
- **Live state verified:** `~/.claude/.credentials.json` has a Max OAuth token (`subscriptionType: max`, `user:inference` scope); **no `ANTHROPIC_API_KEY`/`AUTH_TOKEN` in config, secrets, or shell profiles.** ⇒ **the gateway's headless turns ALREADY bill the Max subscription.**
- The believed "**`-p` de-subsidized ~2026-06-15**" is **not in the client source** - if real, it's a **server-side/account policy** this code can't reveal or enforce. **Action: verify against Anthropic's billing docs/account directly**, not by changing how we spawn.

## 3. Streaming data contract (so we know what NOT to break)
Web UI consumes `session:delta` WS events `{type, content, toolName}` (`api.ts:2058`, `server.ts:699`). It expects: incremental `text` (append), `text_snapshot` (cumulative drop-recovery), `tool_use` (flush boundary, needs `toolName`), `tool_result`. Headless `claude.ts` emits all of these (`claude.ts:408-450`). `claude-interactive.ts` meets the *minimal* contract (text/tool_use/tool_result, correct EngineResult incl. contextTokens) but **omits `text_snapshot` and is coarser (whole-message `text`)** - correct, just less smooth. Connectors (Slack) consume **final result only** (no `onStream`), so they're unaffected by mode.

## 4. Concurrency / ops (why PTY is worse at org scale)
- **Headless `-p`:** one ephemeral process per turn, exits in seconds, **no live-process cap** (`claude.ts:138,220`). OS-bounded only.
- **PTY (`PtyLifecycleManager`):** `maxLivePtys=8` is **NOT a concurrency limit** - `run()` spawns *before* any capacity check and `adopt()` always inserts even when `evictLru()` no-ops (all entries have running turns) (`claude-interactive.ts:419-422`, `pty-lifecycle.ts:55-56,143`). `isAtCapacity()` exists but is unused on the run path. ⇒ **>8 concurrent turns grow the PTY pool unbounded**, each a full resident `claude` process + node-pty FDs + per-session settings file + hook-server slot + 10-min keepalive.
- **Realistic peak:** 34 enabled crons cluster 07:00–10:00 and **fan out** (COO→employee→sub-agents), giving **~5–15+ concurrent turns**. PTY mode → 15+ heavyweight resident processes; headless → none held between turns.
- **The real ceiling - subscription rate limits (mode-independent):** Max has **5-hour + weekly** caps (`free-code/.../statuslineSetup.ts:68,72`; `mappers.ts:229-246`). Funneling the whole org (Opus, "always Opus") through ONE Max sub can exhaust the 5h window, after which **every** session hits the limit at once; our default `rateLimitStrategy:"wait"` (`rate-limit-handler.ts:160`) then **serializes the org behind the reset**. This bites `-p` and PTY equally - it's a *subscription-routing* limit, not a streaming-mode choice.

## 5. Ranked options (goal: subscription billing + keep streaming + don't regress org)
| Rank | Path | Per-token streaming | Max-sub billing | Concurrency | Risk |
|---|---|---|---|---|---|
| **1 (current)** | Headless `-p stream-json --include-partial-messages --verbose` | **Yes** | **Yes** (iff no API-key env) | Excellent (ephemeral) | Low - already shipped |
| 2 | PTY + transcript tail (current interactive engine) | No (per-message) | Yes | Poor (PTY explosion) | Med - keep ONLY for xterm view |
| 3 | PTY + scrape Ink stdout repaints | Partial (ANSI diff) | Yes | Poor | High - brittle to TUI changes |

## 6. Recommendation
**Keep the headless `-p stream-json` path for work turns (it already streams per-token AND bills the Max subscription). Do not migrate to PTY.** Instead, the only real action items - all small, none requiring the migration:
1. **Harden env hygiene (recommended, 1-line):** extend `claude.ts buildCleanEnv()` (`:558`) to also delete `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the spawn env, guaranteeing subscription billing even if those vars ever appear in the gateway environment. (Currently safe - none set - but it's a silent-API-billing landmine.) Same hardening for codex/agy env builders if desired. **No streaming impact, no restart risk beyond a normal deploy.**
2. **Verify the Jun-15 `-p` de-subsidy claim** against Anthropic's account/billing docs directly. If true, it's server-side and the mitigation is *still not* PTY (auth is identical) - it would mean Max no longer covers headless at all, in which case the real lever is the Max-vs-API account decision, not the spawn mode.
3. **Treat the Max rate limit as the org-scale ceiling:** consider `sessions.rateLimitStrategy: "fallback"` (Codex) for cron/batch so a subscription-limit window doesn't stall the whole org behind a wait timer.

## 7. Implementation / effort
- **Recommended path = essentially no migration.** Item 1 (env strip) is a ~1-line change + normal gated deploy. Items 2–3 are a doc check + a config toggle.
- If the CEO still wants PTY-for-everything despite the above (e.g. a confirmed server-side `-p` cutoff), it's the earlier plan (`2026-06-01-claude-interactive-turn-migration.md`) PLUS accepting the streaming downgrade (per-message) and building a real PTY admission gate/queue - **HIGH effort, regresses streaming, and still hits the same Max rate limit.** Not recommended unless forced by an account-policy change.

**Bottom line:** the current architecture already accomplishes the CEO's goal (subscription-billed, token-streamed Claude turns). The migration is unnecessary and would regress streaming + concurrency. The one worthwhile follow-up is env-hygiene hardening.
