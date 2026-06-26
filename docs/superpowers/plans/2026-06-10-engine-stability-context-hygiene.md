# Engine Stability + Context Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate turn-state desync between the gateway and engine CLIs (StopFailure premature failure, codex false completion, stuck "running"), and cut per-session injected context ~60% by audience-scoping `buildContext` and deduping static content into CLAUDE.md.

**Architecture:** Track 1 hardens the existing per-engine completion detection (no state-machine refactor): a grace window + late-recovery supersede in `TurnResolver`, deterministic `task_complete` parsing in codex-interactive, and a periodic gateway status reconciler. Track 2 makes `buildContext()` audience-aware (COO vs manager vs employee) and moves static content (API table, connector recipes) into the engine-ingested CLAUDE.md/AGENTS.md.

**Tech Stack:** TypeScript (Node), vitest, node-pty. Repo: `~/Projects/cuttlefish`, package `packages/cuttlefish` (run tests with `pnpm --filter cuttlefish-cli exec vitest run <file>`; typecheck with `pnpm --filter cuttlefish-cli typecheck`).

**Spec:** `docs/superpowers/specs/2026-06-10-engine-stability-context-hygiene-design.md`

**Execution notes:**
- Work in a git worktree (superpowers:using-git-worktrees) off `main`. Source-only: do NOT rebuild `dist/` or restart the live gateway on port 8888.
- The live instance file `~/.cuttlefish/CLAUDE.md` (Task 9) is edited in place in `~/.cuttlefish` (its own git repo) — NOT part of the cuttlefish repo worktree.
- One deliberate deviation from the spec: the reconciler (Task 5) only fixes the stuck-`running` direction. The reverse direction (engine alive after error-settle) is prevented at the source by Tasks 1–3, so no status flip-flopping is needed.

---

### Task 1: TurnResolver StopFailure grace window

The `TurnResolver` currently settles a turn as failed the instant a `StopFailure` hook arrives (`claude-interactive.ts:259-271`). The interactive CLI survives `invalid_request`/`server_error`/`unknown` API errors and usually retries, so the turn shows "failed" in chat while the CLI finishes the work. Add a 20s grace window for those error types; `rate_limit`, `billing_error`, `authentication_failed`, `max_output_tokens` keep settling immediately (the manager's wait/retry/fallback machinery depends on it).

**Files:**
- Modify: `packages/cuttlefish/src/engines/claude-interactive.ts` (TurnResolver, ~lines 223-314)
- Test: `packages/cuttlefish/src/engines/__tests__/turn-resolver-grace.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `packages/cuttlefish/src/engines/__tests__/turn-resolver-grace.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TurnResolver } from "../claude-interactive.js";

// Helper: a settled-state probe that never blocks the test on an unsettled promise.
function probe(r: TurnResolver) {
  let value: import("../../shared/types.js").EngineResult | undefined;
  void r.promise.then((v) => { value = v; });
  return () => value;
}

describe("TurnResolver — StopFailure grace window", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("does NOT settle immediately on a grace-eligible StopFailure (invalid_request)", async () => {
    const r = new TurnResolver({ fallbackSessionId: "sid", assumeStarted: true, stopFailureGraceMs: 1000 });
    const get = probe(r);
    r.onHook({ hook_event_name: "StopFailure", error: "invalid_request", session_id: "sid" });
    await vi.advanceTimersByTimeAsync(500);
    expect(r.isSettled).toBe(false);
    expect(get()).toBeUndefined();
  });

  it("settles with the original error if grace expires with no recovery", async () => {
    const r = new TurnResolver({ fallbackSessionId: "sid", assumeStarted: true, stopFailureGraceMs: 1000 });
    const get = probe(r);
    r.onHook({ hook_event_name: "StopFailure", error: "invalid_request", session_id: "sid" });
    await vi.advanceTimersByTimeAsync(1100);
    expect(get()?.error).toBe("Interactive turn failed: invalid_request");
    expect(r.stopFailure?.error).toBe("invalid_request");
  });

  it("a Stop during grace supersedes the failure — turn completes normally", async () => {
    const r = new TurnResolver({ fallbackSessionId: "sid", assumeStarted: true, stopFailureGraceMs: 1000 });
    const get = probe(r);
    r.onHook({ hook_event_name: "StopFailure", error: "server_error", session_id: "sid" });
    await vi.advanceTimersByTimeAsync(400);
    r.onHook({ hook_event_name: "Stop", session_id: "sid", last_assistant_message: "recovered answer" });
    await vi.advanceTimersByTimeAsync(0);
    expect(get()?.result).toBe("recovered answer");
    expect(get()?.error).toBeUndefined();
    // Failure was superseded — downstream rateLimit/no-output checks must not see it.
    expect(r.stopFailure).toBeUndefined();
    // The (cleared) grace timer must not fire later and double-settle.
    await vi.advanceTimersByTimeAsync(2000);
    expect(get()?.result).toBe("recovered answer");
  });

  it("activity (any other hook) during grace re-arms the window", async () => {
    const r = new TurnResolver({ fallbackSessionId: "sid", assumeStarted: true, stopFailureGraceMs: 1000 });
    const get = probe(r);
    r.onHook({ hook_event_name: "StopFailure", error: "invalid_request", session_id: "sid" });
    await vi.advanceTimersByTimeAsync(800);
    r.onHook({ hook_event_name: "PostToolUse", tool_name: "Bash", session_id: "sid" }); // proof of life
    await vi.advanceTimersByTimeAsync(800); // 1600ms total — past the ORIGINAL deadline
    expect(r.isSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(300); // 1100ms after the re-arm
    expect(get()?.error).toBe("Interactive turn failed: invalid_request");
  });

  it("noteActivity() re-arms the window too (SSE-delta path)", async () => {
    const r = new TurnResolver({ fallbackSessionId: "sid", assumeStarted: true, stopFailureGraceMs: 1000 });
    r.onHook({ hook_event_name: "StopFailure", error: "invalid_request", session_id: "sid" });
    await vi.advanceTimersByTimeAsync(800);
    r.noteActivity();
    await vi.advanceTimersByTimeAsync(800);
    expect(r.isSettled).toBe(false);
  });

  it("noteActivity() outside a grace window is a no-op", () => {
    const r = new TurnResolver({ fallbackSessionId: "sid", assumeStarted: true });
    r.noteActivity();
    expect(r.isSettled).toBe(false);
  });

  it("rate_limit still settles immediately (manager wait/retry machinery)", async () => {
    const r = new TurnResolver({ fallbackSessionId: "sid", assumeStarted: true, stopFailureGraceMs: 1000 });
    const get = probe(r);
    r.onHook({ hook_event_name: "StopFailure", error: "rate_limit", session_id: "sid" });
    await vi.advanceTimersByTimeAsync(0);
    expect(get()?.error).toBe("Interactive turn failed: rate_limit");
  });

  it("billing_error settles immediately", async () => {
    const r = new TurnResolver({ fallbackSessionId: "sid", assumeStarted: true, stopFailureGraceMs: 1000 });
    const get = probe(r);
    r.onHook({ hook_event_name: "StopFailure", error: "billing_error", session_id: "sid" });
    await vi.advanceTimersByTimeAsync(0);
    expect(get()?.error).toBe("Interactive turn failed: billing_error");
  });

  it("interrupt() during grace settles with the ORIGINAL StopFailure error", async () => {
    const r = new TurnResolver({ fallbackSessionId: "sid", assumeStarted: true, stopFailureGraceMs: 1000 });
    const get = probe(r);
    r.onHook({ hook_event_name: "StopFailure", error: "server_error", session_id: "sid" });
    r.interrupt("Interrupted: claude process exited"); // PTY-death watchdog path
    await vi.advanceTimersByTimeAsync(0);
    expect(get()?.error).toBe("Interactive turn failed: server_error");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Projects/cuttlefish && pnpm --filter cuttlefish-cli exec vitest run src/engines/__tests__/turn-resolver-grace.test.ts`
Expected: FAIL — "does NOT settle immediately" fails (settles instantly), `noteActivity` not a function, `stopFailureGraceMs` unknown option (TS may also complain).

- [ ] **Step 3: Implement the grace window in TurnResolver**

In `packages/cuttlefish/src/engines/claude-interactive.ts`:

Add constants above `TurnResolverOpts` (~line 222):

```ts
const STOP_FAILURE_GRACE_MS = 20_000;
/** StopFailure error types the interactive CLI routinely survives and retries
 *  (the PTY keeps working) — eligible for the grace window. rate_limit /
 *  billing_error / authentication_failed / max_output_tokens settle
 *  immediately: the CLI genuinely stops on those, and manager.ts's wait/retry/
 *  fallback machinery keys off the prompt settle. */
const GRACE_ELIGIBLE_ERRORS = new Set(["invalid_request", "server_error", "unknown"]);
```

Extend `TurnResolverOpts`:

```ts
export interface TurnResolverOpts {
  fallbackSessionId: string | undefined;
  /** When true (warm-PTY reuse / post-idle-spawn), the resolver skips waiting for
   *  SessionStart (it already fired once at process start) and pre-fills the
   *  Claude session id from fallbackSessionId. */
  assumeStarted?: boolean;
  /** Test override for the StopFailure grace window (default 20s). */
  stopFailureGraceMs?: number;
}
```

In the `TurnResolver` class add a field after `stopFailurePayload`:

```ts
  private graceTimer: NodeJS.Timeout | undefined;
```

Replace `onHook` with:

```ts
  onHook(h: HookPayload): void {
    if (this.settled) return;
    if (h.hook_event_name === "SessionStart") {
      this.gotSessionStart = true;
      if (typeof h.session_id === "string") this.claudeSessionId = h.session_id;
      this.maybeComplete();
    } else if (h.hook_event_name === "Stop") {
      // A Stop supersedes any pending StopFailure — the CLI retried and finished.
      this.clearGrace();
      this.stopFailurePayload = undefined;
      this.stopPayload = h;
      if (typeof h.session_id === "string" && !this.claudeSessionId) this.claudeSessionId = h.session_id;
      this.maybeComplete();
    } else if (h.hook_event_name === "StopFailure") {
      // API error ended the turn. In interactive mode the CLI survives
      // invalid_request/server_error/unknown and usually retries — hold the
      // failure in a grace window instead of settling: a later Stop supersedes
      // it, activity re-arms it, the PTY-death watchdog still fails fast.
      // Other error types (rate_limit, billing, auth) settle immediately.
      // numTurns:1 keeps isDeadSessionError from false-positiving.
      this.stopFailurePayload = h;
      if (typeof h.session_id === "string" && !this.claudeSessionId) this.claudeSessionId = h.session_id;
      if (GRACE_ELIGIBLE_ERRORS.has(String(h.error ?? "unknown"))) {
        this.armGrace();
      } else {
        this.settleWithFailure();
      }
    } else {
      // PreToolUse/PostToolUse/etc — proof of life while a failure is pending.
      this.noteActivity();
    }
  }
```

Add the new methods after `completeRecovered` (~line 307):

```ts
  /** Proof of life (SSE delta / tool hook) while a StopFailure is pending —
   *  re-arms the grace window. No-op when no failure is pending. */
  noteActivity(): void {
    if (this.graceTimer) this.armGrace();
  }

  private armGrace(): void {
    this.clearGrace();
    const ms = this.opts.stopFailureGraceMs ?? STOP_FAILURE_GRACE_MS;
    this.graceTimer = setTimeout(() => this.settleWithFailure(), ms);
    this.graceTimer.unref?.();
  }

  private clearGrace(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
    }
  }

  private settleWithFailure(): void {
    this.settle({
      sessionId: this.claudeSessionId ?? this.opts.fallbackSessionId ?? "",
      result: "",
      error: `Interactive turn failed: ${this.stopFailurePayload?.error ?? "unknown"}`,
      numTurns: 1,
    });
  }
```

Replace `interrupt` so a PTY death during grace reports the real API error:

```ts
  interrupt(reason: string): void {
    // PTY died while a StopFailure was held in grace — the API error is the
    // real cause; report it instead of the generic "process exited".
    if (this.stopFailurePayload && !this.settled) {
      this.settleWithFailure();
      return;
    }
    this.settle({ sessionId: this.claudeSessionId ?? this.opts.fallbackSessionId ?? "", result: "", error: reason });
  }
```

Replace `settle` so the timer can't leak:

```ts
  private settle(r: EngineResult): void {
    if (this.settled) return;
    this.settled = true;
    this.clearGrace();
    this.resolve(r);
  }
```

- [ ] **Step 4: Run the new tests**

Run: `pnpm --filter cuttlefish-cli exec vitest run src/engines/__tests__/turn-resolver-grace.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Update any existing tests that assumed immediate settle**

Run: `pnpm --filter cuttlefish-cli exec vitest run src/engines/__tests__/claude-interactive.test.ts`
The existing test "settles immediately on StopFailure … and exposes it" uses `error: "rate_limit"` — rate_limit still settles immediately, so it should PASS unchanged. If any other existing test feeds a grace-eligible error (`invalid_request`/`server_error`/`unknown`) and expects an immediate settle, pass `stopFailureGraceMs: 0` plus a `await new Promise(r => setTimeout(r, 1))` flush, or switch the fixture to `rate_limit`. Make the full file green.

- [ ] **Step 6: Commit**

```bash
git add packages/cuttlefish/src/engines/claude-interactive.ts packages/cuttlefish/src/engines/__tests__/turn-resolver-grace.test.ts packages/cuttlefish/src/engines/__tests__/claude-interactive.test.ts
git commit -m "fix(engines): hold StopFailure in a grace window so a retrying CLI isn't declared failed"
```

---

### Task 2: Wire SSE streaming activity into the grace window

The grace window re-arms on hooks (Task 1 handles PreToolUse/PostToolUse inside `onHook`), but the strongest proof-of-life is the SSE stream itself (text deltas while the CLI retries/continues). Wire `handleSseEvent` → `resolver.noteActivity()`. Raw PTY output is deliberately NOT used — the TUI redraws its spinner even when idle, which would re-arm grace forever.

**Files:**
- Modify: `packages/cuttlefish/src/engines/claude-interactive.ts:592-598` (`handleSseEvent`)

- [ ] **Step 1: Implement**

Replace `handleSseEvent`:

```ts
  /** Translate parsed SSE events from a PTY's proxy into StreamDeltas and route
   *  them to the active turn's onStream. A PTY outlives its turn, so we look up
   *  the live active entry here rather than capturing onStream at spawn.
   *  Any SSE event is also proof of life for a pending StopFailure grace window. */
  private handleSseEvent(cuttlefishSessionId: string, e: SseDataEvent): void {
    const entry = this.active.get(cuttlefishSessionId);
    if (!entry) return; // idle PTY / no turn in flight — nothing to stream
    entry.resolver.noteActivity();
    if (!entry.onStream) return;
    // Only the main agent's events reach here (the proxy suppresses sub-agent and
    // auxiliary streams), so deltas go straight to the transcript.
    for (const d of sseEventToDeltas(e)) entry.onStream(d);
  }
```

- [ ] **Step 2: Run the engine test files**

Run: `pnpm --filter cuttlefish-cli exec vitest run src/engines/__tests__/claude-interactive.test.ts src/engines/__tests__/turn-resolver-grace.test.ts src/engines/__tests__/claude-interactive-race.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/cuttlefish/src/engines/claude-interactive.ts
git commit -m "fix(engines): SSE stream activity re-arms the StopFailure grace window"
```

---

### Task 3: Late-recovery supersede (a late Stop fixes a wrongly-failed turn)

If grace expires and the turn settles failed, but the CLI later finishes (Stop arrives after settle), the recovered text currently has nowhere to land. Keep listening for a bounded window after an API-error settle; on a late Stop, hand the recovered text to the gateway, which appends it as a follow-up assistant message and restores a clean idle status.

**Files:**
- Modify: `packages/cuttlefish/src/shared/types.ts` (EngineRunOpts)
- Modify: `packages/cuttlefish/src/engines/claude-interactive.ts` (engine class)
- Modify: `packages/cuttlefish/src/gateway/api.ts` (runWebSession engine.run opts, ~line 2260)
- Modify: `packages/cuttlefish/src/sessions/manager.ts` (engine.run opts, ~line 380)
- Test: `packages/cuttlefish/src/engines/__tests__/claude-interactive-late-recovery.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/cuttlefish/src/engines/__tests__/claude-interactive-late-recovery.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InteractiveClaudeEngine } from "../claude-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { HookRegistry } from "../../gateway/hook-registry.js";

describe("InteractiveClaudeEngine — late-recovery supersede", () => {
  let registry: HookRegistry;
  let engine: InteractiveClaudeEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new HookRegistry();
    engine = new InteractiveClaudeEngine(new PtyLifecycleManager({ maxLivePtys: 4 }), registry);
  });
  afterEach(() => {
    registry.dispose();
    vi.useRealTimers();
  });

  it("a late Stop after arming delivers the recovered text via onLateRecovery", () => {
    const recovered: Array<{ result: string; sessionId: string }> = [];
    engine.armLateRecovery("cuttlefish-1", {
      prompt: "x", cwd: "/tmp",
      onLateRecovery: (info) => recovered.push(info),
    });
    registry.deliver("cuttlefish-1", { hook_event_name: "Stop", session_id: "claude-abc", last_assistant_message: "late answer" });
    expect(recovered).toEqual([{ result: "late answer", sessionId: "claude-abc" }]);
  });

  it("fires at most once and unregisters after delivery", () => {
    const recovered: string[] = [];
    engine.armLateRecovery("cuttlefish-1", { prompt: "x", cwd: "/tmp", onLateRecovery: (i) => recovered.push(i.result) });
    registry.deliver("cuttlefish-1", { hook_event_name: "Stop", last_assistant_message: "first" });
    registry.deliver("cuttlefish-1", { hook_event_name: "Stop", last_assistant_message: "second" });
    expect(recovered).toEqual(["first"]);
  });

  it("ignores non-Stop hooks and empty messages", () => {
    const recovered: string[] = [];
    engine.armLateRecovery("cuttlefish-1", { prompt: "x", cwd: "/tmp", onLateRecovery: (i) => recovered.push(i.result) });
    registry.deliver("cuttlefish-1", { hook_event_name: "PostToolUse", tool_name: "Bash" });
    registry.deliver("cuttlefish-1", { hook_event_name: "Stop", last_assistant_message: "   " });
    expect(recovered).toEqual([]);
  });

  it("cancelLateRecovery stops the listener (a new turn owns the session)", () => {
    const recovered: string[] = [];
    engine.armLateRecovery("cuttlefish-1", { prompt: "x", cwd: "/tmp", onLateRecovery: (i) => recovered.push(i.result) });
    engine.cancelLateRecovery("cuttlefish-1");
    registry.deliver("cuttlefish-1", { hook_event_name: "Stop", last_assistant_message: "too late" });
    expect(recovered).toEqual([]);
  });

  it("expires after the recovery window", () => {
    const recovered: string[] = [];
    engine.armLateRecovery("cuttlefish-1", { prompt: "x", cwd: "/tmp", onLateRecovery: (i) => recovered.push(i.result) });
    vi.advanceTimersByTime(10 * 60 * 1000 + 1000);
    registry.deliver("cuttlefish-1", { hook_event_name: "Stop", last_assistant_message: "expired" });
    expect(recovered).toEqual([]);
  });

  it("does nothing when opts.onLateRecovery is absent", () => {
    engine.armLateRecovery("cuttlefish-1", { prompt: "x", cwd: "/tmp" });
    // No listener registered → delivery is buffered by the registry, not crashed on.
    registry.deliver("cuttlefish-1", { hook_event_name: "Stop", last_assistant_message: "ignored" });
    expect(true).toBe(true);
  });
});
```

Note: `HookRegistry.deliver()` buffers when no listener is registered — that's fine for the no-op test.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter cuttlefish-cli exec vitest run src/engines/__tests__/claude-interactive-late-recovery.test.ts`
Expected: FAIL — `armLateRecovery` is not a function.

- [ ] **Step 3: Add `onLateRecovery` to EngineRunOpts**

In `packages/cuttlefish/src/shared/types.ts`, inside `EngineRunOpts` (after `source?: string;`):

```ts
  /** Interactive engines only: called when a turn that already settled as
   *  failed (API-error StopFailure) later produces a real Stop — the CLI
   *  retried past the grace window and finished. The gateway should persist
   *  `result` as a follow-up assistant message and restore idle status.
   *  `sessionId` is the engine-native session id ("" if unknown). */
  onLateRecovery?: (info: { result: string; sessionId: string }) => void;
```

- [ ] **Step 4: Implement arm/cancel in InteractiveClaudeEngine**

In `packages/cuttlefish/src/engines/claude-interactive.ts`:

Add a constant near the other timing constants (~line 322):

```ts
const LATE_RECOVERY_WINDOW_MS = 10 * 60 * 1000;
```

Add a field to the class (after `spawnParams`, ~line 375):

```ts
  /** Sessions with a post-failure recovery listener armed (turn settled as an
   *  API error, but the CLI may still finish — a late Stop supersedes). */
  private lateRecovery = new Map<string, { timer: NodeJS.Timeout }>();
```

Add two methods after `isAlive` (~line 923):

```ts
  /** Keep listening for a late Stop after an API-error settle. Public for run(),
   *  kill(), and tests. No-op when the caller didn't provide onLateRecovery. */
  armLateRecovery(cuttlefishSessionId: string, opts: EngineRunOpts): void {
    if (!opts.onLateRecovery) return;
    this.cancelLateRecovery(cuttlefishSessionId);
    const timer = setTimeout(() => this.cancelLateRecovery(cuttlefishSessionId), LATE_RECOVERY_WINDOW_MS);
    timer.unref?.();
    this.lateRecovery.set(cuttlefishSessionId, { timer });
    this.hookRegistry.register(cuttlefishSessionId, (h) => {
      if (h.hook_event_name !== "Stop") return;
      const text = String(h.last_assistant_message ?? "");
      const sid = typeof h.session_id === "string" ? h.session_id : "";
      this.cancelLateRecovery(cuttlefishSessionId);
      if (text.trim()) {
        logger.info(`InteractiveClaudeEngine: late Stop superseded failed turn for ${cuttlefishSessionId}`);
        opts.onLateRecovery?.({ result: text, sessionId: sid });
      }
    });
  }

  /** Tear down a pending late-recovery listener (new turn starting / kill / expiry). */
  cancelLateRecovery(cuttlefishSessionId: string): void {
    const lr = this.lateRecovery.get(cuttlefishSessionId);
    if (!lr) return;
    clearTimeout(lr.timer);
    this.lateRecovery.delete(cuttlefishSessionId);
    this.hookRegistry.unregister(cuttlefishSessionId);
  }
```

Wire into the turn lifecycle:

1. At the top of `run()`, right after the concurrent-turn guard (~line 389), add:

```ts
    // A previous turn may have left a late-recovery listener armed; this new
    // turn owns the session (and the hook registration) now.
    this.cancelLateRecovery(cuttlefishSessionId);
```

2. At the END of `run()`, immediately before `return result;` (~line 560), add:

```ts
    // Turn settled as an API-error failure — the CLI may still be retrying.
    // Keep listening for a late Stop so a wrong "failed" verdict self-corrects.
    if (result.error && resolver.stopFailure) {
      this.armLateRecovery(cuttlefishSessionId, opts);
    }
```

3. In `kill()` (~line 891), add as the first line:

```ts
    this.cancelLateRecovery(sessionId);
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter cuttlefish-cli exec vitest run src/engines/__tests__/claude-interactive-late-recovery.test.ts src/engines/__tests__/claude-interactive.test.ts`
Expected: PASS

- [ ] **Step 6: Wire the gateway handler — web path (api.ts)**

In `packages/cuttlefish/src/gateway/api.ts`, inside `runWebSession`'s `engine.run({...})` options object (after `source: currentSession.source,` ~line 2271), add:

```ts
      // A turn that settled as failed but whose CLI later finished delivers the
      // recovered text here. Append it and restore a clean idle status — unless
      // the session is gone or a NEW turn owns it (status back to "running").
      onLateRecovery: ({ result: lateText, sessionId: engineSid }) => {
        const live = getSession(currentSession.id);
        if (!live || live.status === "running") return;
        insertMessage(currentSession.id, "assistant", lateText);
        const recovered = updateSession(currentSession.id, {
          ...(engineSid.trim() ? { engineSessionId: engineSid } : {}),
          status: "idle",
          lastActivity: new Date().toISOString(),
          lastError: null,
        });
        if (recovered) {
          notifyParentSession(recovered, { result: lateText, error: null }, { alwaysNotify: employee?.alwaysNotify });
          void deliverConnectorReply(recovered, lateText, context.connectors);
        }
        context.emit("session:completed", {
          sessionId: currentSession.id,
          employee: currentSession.employee || config.portal?.portalName || "Cuttlefish",
          title: currentSession.title,
          result: lateText,
          error: null,
        });
        logger.info(`Web session ${currentSession.id} recovered by late Stop after a failed turn`);
      },
```

All helpers (`getSession`, `insertMessage`, `updateSession`, `notifyParentSession`, `deliverConnectorReply`, `logger`) are already imported/used in this file.

- [ ] **Step 7: Wire the gateway handler — connector path (manager.ts)**

In `packages/cuttlefish/src/sessions/manager.ts`, inside the `engine.run({...})` options object that ends with `source: session.source,` (~line 381), add:

```ts
        onLateRecovery: ({ result: lateText, sessionId: engineSid }) => {
          const live = getSession(session.id);
          if (!live || live.status === "running") return;
          insertMessage(session.id, "assistant", lateText);
          updateSession(session.id, {
            ...(engineSid.trim() ? { engineSessionId: engineSid } : {}),
            status: "idle",
            lastActivity: new Date().toISOString(),
            lastError: null,
          });
          void connector.replyMessage(target, lateText).catch(() => {});
          logger.info(`Session ${session.id} recovered by late Stop after a failed turn`);
        },
```

Check the imports at the top of manager.ts: `getSession`, `insertMessage`, `updateSession` must be imported from `./registry.js` (add any that are missing — `updateSession` already is). `connector` and `target` are in scope (used by the rate-limit hooks just below).

- [ ] **Step 8: Typecheck + full engine/gateway test files**

Run: `pnpm --filter cuttlefish-cli typecheck && pnpm --filter cuttlefish-cli exec vitest run src/engines/ src/gateway/__tests__/run-web-session-connector-reply.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add packages/cuttlefish/src/shared/types.ts packages/cuttlefish/src/engines/claude-interactive.ts packages/cuttlefish/src/engines/__tests__/claude-interactive-late-recovery.test.ts packages/cuttlefish/src/gateway/api.ts packages/cuttlefish/src/sessions/manager.ts
git commit -m "feat(engines): late-Stop recovery supersedes a wrongly-failed interactive turn"
```

---

### Task 4: Codex-interactive deterministic completion (task_complete / turn_aborted)

Codex rollout transcripts carry explicit terminal markers (verified against live `~/.codex/sessions/**.jsonl`): `event_msg` payload `task_complete` (with `last_agent_message`) and `turn_aborted`. Use them as the primary completion signal; keep the quiet-window debounce only as a fallback, raised 800ms → 3s.

**Files:**
- Modify: `packages/cuttlefish/src/engines/codex-interactive.ts` (parser + onParsed + constant)
- Test: `packages/cuttlefish/src/engines/__tests__/codex-interactive.test.ts` (extend)

- [ ] **Step 1: Write the failing parser tests**

Append to `packages/cuttlefish/src/engines/__tests__/codex-interactive.test.ts` (inside or alongside the existing `codexTranscriptLineToDeltas` describe block — match the file's existing import of `codexTranscriptLineToDeltas`):

```ts
describe("codexTranscriptLineToDeltas — terminal markers", () => {
  it("parses task_complete with last_agent_message", () => {
    const line = JSON.stringify({
      timestamp: "2026-06-10T06:19:26.649Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "t-1", last_agent_message: "All done." },
    });
    const parsed = codexTranscriptLineToDeltas(line);
    expect(parsed.taskComplete).toEqual({ lastAgentMessage: "All done." });
    expect(parsed.deltas).toEqual([]);
  });

  it("parses task_complete without last_agent_message", () => {
    const line = JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "t-2" } });
    expect(codexTranscriptLineToDeltas(line).taskComplete).toEqual({ lastAgentMessage: undefined });
  });

  it("parses turn_aborted", () => {
    const line = JSON.stringify({ type: "event_msg", payload: { type: "turn_aborted", turn_id: "t-3" } });
    expect(codexTranscriptLineToDeltas(line).turnAborted).toBe(true);
  });

  it("other event_msg payloads carry no terminal markers", () => {
    const line = JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t-4" } });
    const parsed = codexTranscriptLineToDeltas(line);
    expect(parsed.taskComplete).toBeUndefined();
    expect(parsed.turnAborted).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter cuttlefish-cli exec vitest run src/engines/__tests__/codex-interactive.test.ts`
Expected: FAIL — `taskComplete` undefined on the first two tests.

- [ ] **Step 3: Implement parser + completion wiring**

In `packages/cuttlefish/src/engines/codex-interactive.ts`:

1. Change the debounce constant (line 18) and document its new role:

```ts
// FALLBACK ONLY: task_complete (below) is the primary completion signal; this
// quiet-window debounce settles turns whose transcript misses the marker.
const DONE_DEBOUNCE_MS = 3000;
```

2. Extend the parser's return type and add the two markers. Replace the function signature (line 75) with:

```ts
export function codexTranscriptLineToDeltas(line: string): {
  deltas: StreamDelta[];
  doneText?: string;
  sessionId?: string;
  contextTokens?: number;
  /** event_msg task_complete — the turn's deterministic end marker. */
  taskComplete?: { lastAgentMessage?: string };
  /** event_msg turn_aborted — the turn was interrupted CLI-side. */
  turnAborted?: boolean;
} {
```

3. After the existing `token_count` branch (ends line 95), add:

```ts
  if (msg.type === "event_msg" && msg?.payload?.type === "task_complete") {
    const lam = msg.payload.last_agent_message;
    return { deltas: [], taskComplete: { lastAgentMessage: typeof lam === "string" ? lam : undefined } };
  }

  if (msg.type === "event_msg" && msg?.payload?.type === "turn_aborted") {
    return { deltas: [], turnAborted: true };
  }
```

4. In `run()`'s `onParsed` (line 235), handle the markers FIRST. Replace the function body with:

```ts
    const onParsed = (parsed: ReturnType<typeof codexTranscriptLineToDeltas>) => {
      if (parsed.sessionId && !codexSessionId) codexSessionId = parsed.sessionId;
      if (parsed.contextTokens) lastContextTokens = parsed.contextTokens;
      for (const d of parsed.deltas) opts.onStream?.(d);
      if (parsed.taskComplete) {
        // Deterministic end-of-turn marker — settle now (no quiet window).
        const text = parsed.taskComplete.lastAgentMessage?.trim()
          ? parsed.taskComplete.lastAgentMessage
          : latestAnswer;
        finish({ sessionId: codexSessionId ?? "", result: text, numTurns: 1, contextTokens: lastContextTokens });
        return;
      }
      if (parsed.turnAborted) {
        finish({ sessionId: codexSessionId ?? opts.resumeSessionId ?? "", result: latestAnswer, error: "Interrupted: codex turn aborted" });
        return;
      }
      if (parsed.doneText) {
        latestAnswer = parsed.doneText;
        if (turn.doneTimer) clearTimeout(turn.doneTimer);
        turn.doneTimer = setTimeout(
          () => finish({ sessionId: codexSessionId ?? "", result: latestAnswer, numTurns: 1, contextTokens: lastContextTokens }),
          DONE_DEBOUNCE_MS,
        );
        turn.doneTimer.unref?.();
      }
    };
```

- [ ] **Step 4: Run the test file**

Run: `pnpm --filter cuttlefish-cli exec vitest run src/engines/__tests__/codex-interactive.test.ts`
Expected: PASS. If any pre-existing test asserts the 800ms debounce timing, update it to 3000 (or to use the constant via a timer advance).

- [ ] **Step 5: Commit**

```bash
git add packages/cuttlefish/src/engines/codex-interactive.ts packages/cuttlefish/src/engines/__tests__/codex-interactive.test.ts
git commit -m "fix(engines): codex-interactive completes on task_complete/turn_aborted markers, quiet window is fallback-only"
```

---

### Task 5: Gateway status reconciler (unstick `status:"running"`)

A session stuck at `status:"running"` (lost completion event, hung `runWebSession`) currently stays stuck until manual intervention. Add a 15s sweep: a `running` session whose `lastActivity` heartbeat is stale (>45s; the live heartbeat writes every 5s) and whose engine reports no active turn gets reset to `idle` + `session:completed` is emitted. One structured log line per fix.

**Files:**
- Create: `packages/cuttlefish/src/gateway/status-reconciler.ts`
- Modify: `packages/cuttlefish/src/gateway/server.ts` (start after `resumePendingWebQueueItems`, stop in cleanup)
- Test: `packages/cuttlefish/src/gateway/__tests__/status-reconciler.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/cuttlefish/src/gateway/__tests__/status-reconciler.test.ts` (DB scaffolding mirrors `sessions/__tests__/registry-pagination.test.ts` — CUTTLEFISH_HOME must be set before importing the registry):

```ts
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-reconciler-"));
process.env.CUTTLEFISH_HOME = tmp;

type Reg = typeof import("../../sessions/registry.js");
type Rec = typeof import("../status-reconciler.js");
let reg: Reg;
let rec: Rec;
let db: import("better-sqlite3").Database;

function insert(id: string, status: string, lastActivity: string, engine = "claude") {
  db.prepare(
    `INSERT INTO sessions (id, engine, source, source_ref, status, created_at, last_activity)
     VALUES (?, ?, 'web', ?, ?, ?, ?)`,
  ).run(id, engine, `web:${id}`, status, lastActivity, lastActivity);
}

const NOW = new Date("2026-06-10T12:00:00.000Z").getTime();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function fakeEngine(turnRunning: boolean) {
  return { name: "claude", run: async () => ({ sessionId: "", result: "" }), isTurnRunning: () => turnRunning } as any;
}

beforeAll(async () => {
  reg = await import("../../sessions/registry.js");
  rec = await import("../status-reconciler.js");
  db = reg.initDb();
});

beforeEach(() => {
  db.prepare("DELETE FROM sessions").run();
});

describe("status reconciler sweepOnce", () => {
  it("resets a stale running session whose engine reports no turn", () => {
    insert("stuck-1", "running", iso(120_000));
    const events: any[] = [];
    const fixed = rec.sweepOnce({
      engines: new Map([["claude", fakeEngine(false)]]),
      emit: (event, payload) => events.push({ event, payload }),
      now: () => NOW,
    });
    expect(fixed).toBe(1);
    expect(reg.getSession("stuck-1")?.status).toBe("idle");
    expect(events).toEqual([
      { event: "session:completed", payload: expect.objectContaining({ sessionId: "stuck-1" }) },
    ]);
  });

  it("leaves a running session with a FRESH heartbeat alone", () => {
    insert("live-1", "running", iso(10_000)); // heartbeat 10s ago — turn in flight
    const fixed = rec.sweepOnce({ engines: new Map([["claude", fakeEngine(false)]]), emit: () => {}, now: () => NOW });
    expect(fixed).toBe(0);
    expect(reg.getSession("live-1")?.status).toBe("running");
  });

  it("leaves a stale running session alone when the engine still reports a turn", () => {
    insert("working-1", "running", iso(120_000));
    const fixed = rec.sweepOnce({ engines: new Map([["claude", fakeEngine(true)]]), emit: () => {}, now: () => NOW });
    expect(fixed).toBe(0);
    expect(reg.getSession("working-1")?.status).toBe("running");
  });

  it("ignores idle sessions and unknown engines", () => {
    insert("idle-1", "idle", iso(999_000));
    insert("ghost-1", "running", iso(120_000), "no-such-engine");
    const fixed = rec.sweepOnce({ engines: new Map(), emit: () => {}, now: () => NOW });
    // Unknown engine → no live turn possible → unstick it too.
    expect(fixed).toBe(1);
    expect(reg.getSession("idle-1")?.status).toBe("idle");
    expect(reg.getSession("ghost-1")?.status).toBe("idle");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter cuttlefish-cli exec vitest run src/gateway/__tests__/status-reconciler.test.ts`
Expected: FAIL — module `../status-reconciler.js` not found.

- [ ] **Step 3: Implement the reconciler**

Create `packages/cuttlefish/src/gateway/status-reconciler.ts`:

```ts
import type { Engine } from "../shared/types.js";
import { listSessions, updateSession } from "../sessions/registry.js";
import { logger } from "../shared/logger.js";

const DEFAULT_INTERVAL_MS = 15_000;
/** runWebSession's heartbeat refreshes lastActivity every 5s while a turn is in
 *  flight. A "running" session whose heartbeat is older than this has no live
 *  turn driving it — the completion event was lost. */
const DEFAULT_STALE_MS = 45_000;

export interface StatusReconcilerDeps {
  engines: Map<string, Engine>;
  emit: (event: string, payload: unknown) => void;
  intervalMs?: number;
  staleMs?: number;
  /** Test override. */
  now?: () => number;
}

/** One sweep: unstick sessions stuck at status:"running" with no live turn.
 *  Returns the number of sessions fixed. Exported for tests. */
export function sweepOnce(deps: StatusReconcilerDeps): number {
  const now = deps.now?.() ?? Date.now();
  const staleMs = deps.staleMs ?? DEFAULT_STALE_MS;
  let fixed = 0;
  for (const session of listSessions()) {
    if (session.status !== "running") continue;
    const last = session.lastActivity ? new Date(session.lastActivity).getTime() : 0;
    const staleFor = now - last;
    if (staleFor < staleMs) continue; // heartbeat is live — a turn is in flight
    const engine = deps.engines.get(session.engine);
    // Same live-turn probe as the API status path: interactive engines expose
    // isTurnRunning (warm-but-idle PTYs must not count); headless engines
    // approximate with isAlive; an unknown engine cannot have a live turn.
    const turnRunning = !!engine && (
      "isTurnRunning" in engine
        ? (engine as unknown as { isTurnRunning(id: string): boolean }).isTurnRunning(session.id)
        : (typeof (engine as { isAlive?: (id: string) => boolean }).isAlive === "function"
          ? (engine as unknown as { isAlive(id: string): boolean }).isAlive(session.id)
          : false)
    );
    if (turnRunning) continue;
    updateSession(session.id, {
      status: "idle",
      lastActivity: new Date(now).toISOString(),
      lastError: null,
    });
    deps.emit("session:completed", {
      sessionId: session.id,
      employee: session.employee ?? undefined,
      title: session.title,
      result: null,
      error: null,
    });
    logger.warn(
      `[reconciler] session ${session.id} (${session.engine}) was stuck status=running with no live turn ` +
      `(heartbeat stale ${Math.round(staleFor / 1000)}s) — reset to idle`,
    );
    fixed++;
  }
  return fixed;
}

/** Start the periodic sweep. Returns a stop function. */
export function startStatusReconciler(deps: StatusReconcilerDeps): () => void {
  const timer = setInterval(() => {
    try {
      sweepOnce(deps);
    } catch (err) {
      logger.warn(`[reconciler] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, deps.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter cuttlefish-cli exec vitest run src/gateway/__tests__/status-reconciler.test.ts`
Expected: PASS. (If `listSessions()` requires a filter argument or `title` doesn't exist on Session, adapt to the actual signatures in `sessions/registry.ts` / `shared/types.ts` — `listSessions()` with no args returns all sessions per `api.ts:460` usage.)

- [ ] **Step 5: Wire into the gateway lifecycle**

In `packages/cuttlefish/src/gateway/server.ts`:

1. Add the import near the other gateway imports:

```ts
import { startStatusReconciler } from "./status-reconciler.js";
```

2. After `resumePendingWebQueueItems(apiContext);` (~line 791), add:

```ts
  // Unstick sessions whose completion event was lost (status:"running" with no
  // live turn). 15s sweep; logs one line per fix.
  const stopStatusReconciler = startStatusReconciler({ engines, emit });
```

3. In the cleanup function returned at the end of `startGateway` (~line 997, "Gateway cleanup starting..."), add alongside the other teardown calls:

```ts
    stopStatusReconciler();
```

- [ ] **Step 6: Typecheck + run gateway tests**

Run: `pnpm --filter cuttlefish-cli typecheck && pnpm --filter cuttlefish-cli exec vitest run src/gateway/__tests__/`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/cuttlefish/src/gateway/status-reconciler.ts packages/cuttlefish/src/gateway/__tests__/status-reconciler.test.ts packages/cuttlefish/src/gateway/server.ts
git commit -m "feat(gateway): status reconciler sweep unsticks sessions stuck at running"
```

---

### Task 6: Compact org roster (drop persona previews)

`buildOrgContext` currently appends a persona-preview line per employee (~120 chars each + formatting). Collapse to `Name (slug) — dept, rank` with one pointer line for details. Applies to both the hierarchy path and the filesystem-fallback path.

**Files:**
- Modify: `packages/cuttlefish/src/sessions/context.ts:385-456` (`buildOrgContext`)
- Test: `packages/cuttlefish/src/sessions/__tests__/context.test.ts` (extend/update)

- [ ] **Step 1: Write the failing test**

Add to `packages/cuttlefish/src/sessions/__tests__/context.test.ts` (a hierarchy fixture may already exist in the file — reuse its shape; `OrgHierarchy` is `{ nodes: Record<string, OrgNode>, sorted: string[] }` per `shared/types.ts`):

```ts
describe("buildContext — compact org roster", () => {
  const emp = (name: string, rank: Employee["rank"], persona: string): Employee => ({
    name, displayName: name, department: "eng", rank, engine: "claude", model: "opus", persona,
  });
  const hierarchy = {
    nodes: {
      lead: { employee: emp("lead", "manager", "Secret persona preview text"), parentName: null, directReports: ["dev"], depth: 0, chain: [] },
      dev: { employee: emp("dev", "employee", "Another secret persona"), parentName: "lead", directReports: [], depth: 1, chain: ["lead"] },
    },
    sorted: ["lead", "dev"],
  } as any;

  it("lists name/dept/rank but NOT persona previews", () => {
    const out = buildContext({ ...baseOpts, hierarchy });
    expect(out).toContain("## Organization (2 employee(s))");
    expect(out).toContain("- **lead** (lead) — eng, manager");
    expect(out).not.toContain("Secret persona preview");
    expect(out).not.toContain("Another secret persona");
  });

  it("points at the employee-detail endpoint for full personas", () => {
    const out = buildContext({ ...baseOpts, hierarchy });
    expect(out).toContain("GET /api/org/employees/:name");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter cuttlefish-cli exec vitest run src/sessions/__tests__/context.test.ts`
Expected: the two new tests FAIL (persona preview present, pointer line absent).

- [ ] **Step 3: Implement**

In `buildOrgContext` (context.ts):

1. Hierarchy path — delete the preview block (lines 402-405):

```ts
        const emp = node.employee;
        const indent = "  ".repeat(node.depth);
        lines.push(`${indent}- **${emp.displayName}** (${name}) — ${emp.department}, ${emp.rank}`);
```

2. Replace the trailing pointer line (line 412) with:

```ts
      lines.push(`\nFull persona/details: \`GET /api/org/employees/:name\` or the YAML under \`${ORG_DIR}/\`. Create new employees by writing YAML files there.`);
```

3. Filesystem-fallback path — delete the `personaMatch` extraction and preview append (lines 444-448), keeping:

```ts
      lines.push(`- **${displayMatch?.[1] || name}** (${name}) — ${deptMatch?.[1] || "unassigned"}, ${rankMatch?.[1] || "employee"}`);
```

and replace its trailing line (451) with the same pointer line as above.

- [ ] **Step 4: Run the context tests**

Run: `pnpm --filter cuttlefish-cli exec vitest run src/sessions/__tests__/context.test.ts`
Expected: new tests PASS; fix any pre-existing assertions that expected persona previews in the org section.

- [ ] **Step 5: Commit**

```bash
git add packages/cuttlefish/src/sessions/context.ts packages/cuttlefish/src/sessions/__tests__/context.test.ts
git commit -m "perf(context): compact org roster — name/dept/rank only, personas on demand"
```

---

### Task 7: Audience-scoped context + static/dynamic dedupe

Employee sessions stop receiving the org roster, the cron list, and the full API table. The API reference becomes audience-specific (COO: one pointer line; managers: 4-line delegation mini-ref; others: attachments only). Connector recipes slim to two lines (full examples move to CLAUDE.md in Task 8).

**Files:**
- Modify: `packages/cuttlefish/src/sessions/context.ts` (`buildContext`, `buildApiReference`, `buildConnectorContext`)
- Test: `packages/cuttlefish/src/sessions/__tests__/context.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

Add to `context.test.ts` (reuse `minimalEmployee` — rank "manager" — and add a non-manager variant):

```ts
describe("buildContext — audience scoping", () => {
  const worker: Employee = { ...minimalEmployee, name: "writer", displayName: "Writer", rank: "employee" };
  const hierarchy = {
    nodes: {
      "content-lead": { employee: minimalEmployee, parentName: null, directReports: ["writer"], depth: 0, chain: [] },
      writer: { employee: worker, parentName: "content-lead", directReports: [], depth: 1, chain: ["content-lead"] },
    },
    sorted: ["content-lead", "writer"],
  } as any;

  it("employee sessions get NO org roster and NO cron list", () => {
    const out = buildContext({ ...baseOpts, employee: worker, hierarchy });
    expect(out).not.toContain("## Organization");
    expect(out).not.toContain("## Scheduled cron");
    // Chain of command (their slice of the org) stays.
    expect(out).toContain("## Chain of command");
  });

  it("COO sessions still get the org roster", () => {
    const out = buildContext({ ...baseOpts, hierarchy });
    expect(out).toContain("## Organization (2 employee(s))");
  });

  it("COO API section is a pointer at CLAUDE.md, not the full table", () => {
    const out = buildContext({ ...baseOpts });
    expect(out).toContain("Gateway API");
    expect(out).not.toContain("| `/api/cron` | GET |"); // table rows gone
    expect(out).toContain("CLAUDE.md");
  });

  it("manager employees get the delegation mini-reference", () => {
    const out = buildContext({ ...baseOpts, employee: minimalEmployee, hierarchy });
    expect(out).toContain("Delegate to another employee");
    expect(out).toContain("/api/sessions/:id/message");
    expect(out).toContain("/attachments");
    expect(out).not.toContain("| `/api/cron` | GET |");
  });

  it("non-manager employees get attachments only — no delegation endpoints", () => {
    const out = buildContext({ ...baseOpts, employee: worker, hierarchy });
    expect(out).toContain("/attachments");
    expect(out).not.toContain("Delegate to another employee");
  });

  it("connector section is slim — recipe details live in CLAUDE.md", () => {
    const out = buildContext({ ...baseOpts, connectors: ["slack"] });
    expect(out).toContain("## Available connectors: slack");
    expect(out).toContain("/api/connectors/<name>/send");
    // The old per-connector recipe block is gone:
    expect(out).not.toContain("**Send threaded reply**");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter cuttlefish-cli exec vitest run src/sessions/__tests__/context.test.ts`
Expected: new tests FAIL.

- [ ] **Step 3: Implement scoping in `buildContext`**

In `context.ts`:

1. Org section (lines 148-157) — COO only:

```ts
  // ── STANDARD: Organization (COO only — employees get their chain of command) ──
  if (!opts.employee) {
    const orgCtx = buildOrgContext(opts.hierarchy);
    if (orgCtx) {
      sections.push({
        tier: Tier.STANDARD,
        marker: "## Organization",
        content: orgCtx,
        summary: `## Organization\nEmployee files are in \`${ORG_DIR}/\`. Read them directly when needed.`,
      });
    }
  }
```

2. Cron section (lines 159-168) — COO only:

```ts
  // ── STANDARD: Cron jobs (COO only — employees don't manage the schedule) ──
  if (!opts.employee) {
    const cronCtx = buildCronContext();
    if (cronCtx) {
      sections.push({
        tier: Tier.STANDARD,
        marker: "## Scheduled cron",
        content: cronCtx,
        summary: "## Scheduled cron jobs\nCron definitions are in `~/.cuttlefish/cron/jobs.json`. Read directly when needed.",
      });
    }
  }
```

3. API reference section (lines 216-222) — pass the employee through:

```ts
  // ── STANDARD: Gateway API reference (audience-scoped; full table in CLAUDE.md) ──
  sections.push({
    tier: Tier.STANDARD,
    marker: `## ${portalName} Gateway API`,
    content: buildApiReference(gatewayUrl, portalName, opts.employee),
    summary: `## ${portalName} Gateway API (${gatewayUrl})\nFull endpoint reference: CLAUDE.md / AGENTS.md.`,
  });
```

4. Replace `buildApiReference` (lines 630-666) entirely:

```ts
/**
 * Audience-scoped Gateway API reference. The FULL endpoint table lives in
 * CLAUDE.md/AGENTS.md (auto-loaded by every engine) — injecting it here too
 * was pure duplication. What remains dynamic is the live base URL and the
 * short list of calls each audience actually makes.
 */
function buildApiReference(gatewayUrl: string, portalName: string, employee?: Employee): string {
  const header = `## ${portalName} Gateway API (base URL: ${gatewayUrl})`;
  const attachmentsLine =
    `- Push a file/image into this chat (web view): \`curl -X POST ${gatewayUrl}/api/sessions/<your-session-id>/attachments -H 'Content-Type: application/json' -d '{"path":"/abs/path","text":"caption"}'\``;
  if (!employee) {
    return `${header}\nThe full endpoint reference is in CLAUDE.md / AGENTS.md (auto-loaded). Substitute the base URL above.\n${attachmentsLine}`;
  }
  if (employee.rank === "manager" || employee.rank === "executive") {
    return [
      header,
      `- Delegate to another employee: \`POST ${gatewayUrl}/api/sessions\` with \`{prompt, employee, parentSessionId}\``,
      `- Follow up on a child session: \`POST ${gatewayUrl}/api/sessions/:id/message\` with \`{message}\``,
      `- Read a child's latest replies: \`GET ${gatewayUrl}/api/sessions/:id?last=N\``,
      attachmentsLine,
      `Full endpoint table: CLAUDE.md / AGENTS.md.`,
    ].join("\n");
  }
  return [header, attachmentsLine, `Full endpoint table: CLAUDE.md / AGENTS.md.`].join("\n");
}
```

5. Replace `buildConnectorContext` (lines 539-554):

```ts
function buildConnectorContext(connectors: string[], gatewayUrl: string): string {
  return [
    `## Available connectors: ${connectors.join(", ")}`,
    `Send a message: \`curl -X POST ${gatewayUrl}/api/connectors/<name>/send -H 'Content-Type: application/json' -d '{"channel":"CHANNEL_ID","text":"message"}'\` (add \`"thread":"THREAD_TS"\` for a threaded reply).`,
    `Channel IDs are in \`~/.cuttlefish/config.yaml\`. You may send proactively (completed tasks, errors, status updates). Details: CLAUDE.md / AGENTS.md.`,
  ].join("\n");
}
```

and update its call site (line 196) to `buildConnectorContext(opts.connectors, gatewayUrl)`.

- [ ] **Step 4: Run the context tests + fix pre-existing assertions**

Run: `pnpm --filter cuttlefish-cli exec vitest run src/sessions/__tests__/context.test.ts`
Pre-existing tests asserting the full API table, connector recipes, or org/cron presence for employee sessions will fail — update them to the new contract (they are locking the OLD output by design; the file's header comment says so).

- [ ] **Step 5: Typecheck + full sessions tests**

Run: `pnpm --filter cuttlefish-cli typecheck && pnpm --filter cuttlefish-cli exec vitest run src/sessions/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/cuttlefish/src/sessions/context.ts packages/cuttlefish/src/sessions/__tests__/context.test.ts
git commit -m "perf(context): audience-scope buildContext — employees lose org/cron/API-table, recipes dedupe to CLAUDE.md"
```

---

### Task 8: Template CLAUDE.md — shared facts + role marker + API reference

The injected context now points at CLAUDE.md for the API table and connector recipes — the template must actually contain them, and must tell employee sessions (which auto-ingest the same file via AGENTS.md symlink) which parts apply to them.

**Files:**
- Modify: `packages/cuttlefish/template/CLAUDE.md`

- [ ] **Step 1: Add the role marker**

After the intro paragraph (line 3, "You are **{{portalName}}**…"), insert:

```markdown
> **Who reads this file:** every session in this gateway — the COO **and** all employees (engines auto-load it; `AGENTS.md` is the same file). Sections below are shared operating facts unless marked otherwise. The COO role described in this file applies **only when your session context does not name you as a specific employee** — an injected employee persona overrides it; the shared facts still apply to you.
```

- [ ] **Step 2: Add the Gateway API Reference section**

Insert a new section between "## Cron Jobs" and "## Self-Modification" (after line 279):

```markdown
---

## Gateway API Reference

The gateway base URL (host:port) is provided in your session context under "Current configuration". All endpoints below are relative to it. Call them with `curl`.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/status` | GET | Gateway status, uptime, engine info |
| `/api/sessions` | GET | List all sessions |
| `/api/sessions/:id` | GET | Session detail (`?last=N` for just the latest messages) |
| `/api/sessions` | POST | Create new session (`{prompt, engine?, employee?, parentSessionId?}`) |
| `/api/sessions/:id/message` | POST | Send follow-up message to existing session (`{message}`) |
| `/api/sessions/:id/attachments` | POST | Push a file/image into a chat so the web UI renders it (`{path}` or `{url}` or `{content}` base64, optional `text`) |
| `/api/sessions/:id/children` | GET | List child sessions of a parent |
| `/api/cron` | GET | List cron jobs |
| `/api/cron/:id` | PUT | Update cron job (toggle enabled, etc.) |
| `/api/cron/:id/runs` | GET | Cron run history |
| `/api/org` | GET | Organization structure (hierarchy, ranks, reporting lines) |
| `/api/org/employees/:name` | GET | Employee details (full persona) |
| `/api/skills` | GET | List skills |
| `/api/skills/:name` | GET | Skill content |
| `/api/config` | GET / PUT | Read / update config |
| `/api/connectors` | GET | List connectors |
| `/api/connectors/:name/send` | POST | Send message via connector (`{channel, text, thread?}`) |
| `/api/logs` | GET | Recent log lines |

**Attachments** — when you produce a file (chart, screenshot, PDF) and want it in the web chat, POST its local path to your own session. The file is copied into `~/.cuttlefish/uploads/` and rendered inline (images/audio inline, other types as a download card). Attachments render in the web chat view only — never in the raw CLI/xterm stream.

```bash
curl -s -X POST <gateway>/api/sessions/<your-session-id>/attachments \
  -H 'Content-Type: application/json' \
  -d '{"path":"/tmp/chart.png","text":"Here is the chart"}'
```

**Connectors** — send a message through any configured connector (channel IDs live in `~/.cuttlefish/config.yaml`); add `"thread":"THREAD_TS"` for a threaded reply. You may send proactively — completed tasks, errors, status updates:

```bash
curl -X POST <gateway>/api/connectors/slack/send \
  -H 'Content-Type: application/json' \
  -d '{"channel":"CHANNEL_ID","text":"message"}'
```
```

- [ ] **Step 3: Check the template renders (placeholder sanity)**

Run: `grep -n "{{" ~/Projects/cuttlefish/packages/cuttlefish/template/CLAUDE.md | grep -v "portalName\|portalSlug"`
Expected: no output (only the two known placeholders are used). Also run the template/setup tests if present: `pnpm --filter cuttlefish-cli exec vitest run src/cli/` — expected PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/cuttlefish/template/CLAUDE.md
git commit -m "docs(template): CLAUDE.md carries the API reference + role marker — injected context dedupes against it"
```

---

### Task 9: Live instance — update `~/.cuttlefish/CLAUDE.md` (separate repo)

The operator's live CLAUDE.md predates this dedupe: it lacks the Gateway API table (the injected context used to provide it) and has no role marker for the 42 employees that auto-ingest it. Edit in place; commit in the `~/.cuttlefish` git repo (NOT the cuttlefish worktree). Do not touch any other dirty files in `~/.cuttlefish`.

**Files:**
- Modify: `~/.cuttlefish/CLAUDE.md`

- [ ] **Step 1: Add the role marker**

After the opening line ("You are Jimbo, the COO of the user's AI organization."), insert:

```markdown
> **Who reads this file:** every session in this gateway — Jimbo (COO) **and** all employees (engines auto-load it; `AGENTS.md` is the same file). Sections below are shared operating facts unless they are clearly COO doctrine (org management, cron review, delegation rules). The COO role applies **only when your session context does not name you as a specific employee** — an injected employee persona overrides it; the shared facts still apply.
```

- [ ] **Step 2: Add the Gateway API Reference section**

Insert the same "## Gateway API Reference" section from Task 8 Step 2 (table + attachments recipe + connector example), with `<gateway>` spelled as `http://0.0.0.0:8888` is NOT hardcoded — keep the `<gateway>` placeholder wording ("base URL is in your session context"). Place it after the "## Toolbox" section.

- [ ] **Step 3: Commit in ~/.cuttlefish only**

```bash
cd ~/.cuttlefish && git add CLAUDE.md && git commit -m "docs: role marker + gateway API reference (context-hygiene dedupe)"
```

(`~/.cuttlefish` has unrelated dirty files — stage ONLY `CLAUDE.md`.)

---

### Task 10: Full verification

- [ ] **Step 1: Full cuttlefish-cli suite + typecheck**

Run: `cd ~/Projects/cuttlefish && pnpm --filter cuttlefish-cli exec vitest run && pnpm --filter cuttlefish-cli typecheck`
Expected: all tests PASS (was 444 + new ones), typecheck clean.

- [ ] **Step 2: Web package untouched but verify it still builds/tests**

Run: `pnpm --filter @cuttlefish/web exec vitest run && pnpm --filter @cuttlefish/web typecheck`
Expected: PASS (no web changes in this plan; this guards against accidental type ripple through shared types).

- [ ] **Step 3: Context-size spot check**

Run a quick size probe (script, not committed):

```bash
cd ~/Projects/cuttlefish/packages/cuttlefish && pnpm exec tsx -e "
import { buildContext } from './src/sessions/context.js';
const coo = buildContext({ source: 'web', channel: 'c', user: 'u' });
const emp = buildContext({ source: 'web', channel: 'c', user: 'u', employee: { name: 'w', displayName: 'W', department: 'd', rank: 'employee', engine: 'claude', model: 'opus', persona: 'You write blogs.' } });
console.log('COO chars:', coo.length, 'EMPLOYEE chars:', emp.length);
"
```

Expected: employee context is dramatically smaller than before (no org/cron/API table). Note: this runs against the live `~/.cuttlefish` data (CUTTLEFISH_HOME default) — numbers reflect the real instance. Record both numbers in the final report.

- [ ] **Step 4: Commit any stragglers, push is NOT automatic**

```bash
git status --short   # should be clean
git log --oneline main..HEAD
```

Merging the worktree branch into `main` and pushing happens after review (superpowers:finishing-a-development-branch). **Do NOT rebuild dist/ or restart the live 8888 gateway.**

---

## Self-Review (done at plan time)

- **Spec coverage:** 1a→Task 1+2, 1b→Task 3, 1c→Task 4, 1d→Task 5, 2a→Task 7, 2b→Tasks 7+8+9, 2c→Task 6, testing→every task + Task 10, rollout→execution notes. One documented deviation (reconciler direction 2) — justified in the header.
- **Placeholders:** none — every code step has full code; the two "adapt if signature differs" notes name the exact file to check.
- **Type consistency:** `noteActivity()`/`armGrace()`/`settleWithFailure()` consistent across Task 1-2; `armLateRecovery`/`cancelLateRecovery` consistent across Task 3; `taskComplete`/`turnAborted` consistent across Task 4; `sweepOnce`/`startStatusReconciler` consistent across Task 5; `buildApiReference(gatewayUrl, portalName, employee?)` matches its call site in Task 7.
