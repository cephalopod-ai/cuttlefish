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

  it("non-hard permission/safety failures are graced because Claude may continue", async () => {
    const r = new TurnResolver({ fallbackSessionId: "sid", assumeStarted: true, stopFailureGraceMs: 1000 });
    const get = probe(r);
    r.onHook({ hook_event_name: "StopFailure", error: "permission_error", session_id: "sid" });
    await vi.advanceTimersByTimeAsync(0);
    expect(r.isSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1100);
    expect(get()?.error).toBe("Interactive turn failed: permission_error");
  });

  it("does not expire a graced StopFailure while upstream sub-agent work is still active", async () => {
    let activeUpstream = true;
    const r = new TurnResolver({
      fallbackSessionId: "sid",
      assumeStarted: true,
      stopFailureGraceMs: 1000,
      shouldDeferStopFailure: () => activeUpstream,
    });
    const get = probe(r);

    r.onHook({ hook_event_name: "StopFailure", error: "invalid_request", session_id: "sid" });
    await vi.advanceTimersByTimeAsync(2500);
    expect(r.isSettled).toBe(false);
    expect(get()).toBeUndefined();

    activeUpstream = false;
    await vi.advanceTimersByTimeAsync(1100);
    expect(get()?.error).toBe("Interactive turn failed: invalid_request");
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

  it("a user interrupt during grace keeps the Interrupted reason (quiet-interrupt path)", async () => {
    const r = new TurnResolver({ fallbackSessionId: "sid", assumeStarted: true, stopFailureGraceMs: 1000 });
    const get = probe(r);
    r.onHook({ hook_event_name: "StopFailure", error: "server_error", session_id: "sid" });
    r.interrupt("Interrupted: user stopped the turn");
    await vi.advanceTimersByTimeAsync(0);
    expect(get()?.error).toBe("Interrupted: user stopped the turn");
  });

  it("a late Stop after grace expiry does not mutate the settled failure", async () => {
    const r = new TurnResolver({ fallbackSessionId: "sid", assumeStarted: true, stopFailureGraceMs: 1000 });
    const get = probe(r);
    r.onHook({ hook_event_name: "StopFailure", error: "invalid_request", session_id: "sid" });
    await vi.advanceTimersByTimeAsync(1100);
    r.onHook({ hook_event_name: "Stop", session_id: "sid", last_assistant_message: "too late" });
    await vi.advanceTimersByTimeAsync(0);
    expect(get()?.error).toBe("Interactive turn failed: invalid_request");
    expect(get()?.result).toBe("");
  });

  it("a second StopFailure during grace re-arms and expiry reports the newer error", async () => {
    const r = new TurnResolver({ fallbackSessionId: "sid", assumeStarted: true, stopFailureGraceMs: 1000 });
    const get = probe(r);
    r.onHook({ hook_event_name: "StopFailure", error: "invalid_request", session_id: "sid" });
    await vi.advanceTimersByTimeAsync(800);
    r.onHook({ hook_event_name: "StopFailure", error: "server_error", session_id: "sid" });
    await vi.advanceTimersByTimeAsync(800); // past original deadline, within re-armed window
    expect(r.isSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    expect(get()?.error).toBe("Interactive turn failed: server_error");
  });
});
