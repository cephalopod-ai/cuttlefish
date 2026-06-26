import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InteractiveClaudeEngine } from "../claude-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { HookRegistry } from "../../gateway/hook-registry.js";
import type { UpstreamActivityInfo } from "../sse-pty-proxy.js";

// Post-settle background activity surface: while a run() owns the session,
// upstream activity is recorded but NOT emitted (the turn is already
// "running"); after settle, active streams emit immediately and a 10s quiet
// window at 0 emits `null` (cleared) exactly once.

describe("InteractiveClaudeEngine — onBackgroundActivity", () => {
  let registry: HookRegistry;
  let lifecycle: PtyLifecycleManager;
  let engine: InteractiveClaudeEngine;
  let events: Array<{ id: string; info: UpstreamActivityInfo | null }>;

  const act = (id: string, activeStreams: number) =>
    (engine as any).handleUpstreamActivity(id, { activeStreams, lastActivityAt: Date.now() });
  const markRunning = (id: string) => (engine as any).active.set(id, {});
  const settle = (id: string) => {
    (engine as any).active.delete(id);
    (engine as any).maybeEmitBackground(id);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new HookRegistry();
    lifecycle = new PtyLifecycleManager({ maxLivePtys: 4 });
    engine = new InteractiveClaudeEngine(lifecycle, registry);
    engine.backgroundClearQuietMs = 1000;
    events = [];
    engine.onBackgroundActivity((id, info) => events.push({ id, info }));
  });
  afterEach(() => {
    registry.dispose();
    vi.useRealTimers();
  });

  it("suppresses emissions while a run() is in flight, then reports post-settle", () => {
    markRunning("s1");
    act("s1", 1);
    act("s1", 2);
    expect(events).toEqual([]); // turn already "running" — nothing emitted

    settle("s1"); // run() finally → re-check
    expect(events).toEqual([{ id: "s1", info: expect.objectContaining({ activeStreams: 2 }) }]);
  });

  it("emits null after the quiet window once streams reach 0", () => {
    settle("s1"); // no run in flight
    act("s1", 1);
    expect(events.map((e) => e.info?.activeStreams ?? null)).toEqual([1]);

    act("s1", 0);
    expect(events).toHaveLength(1); // not cleared yet — quiet window armed
    vi.advanceTimersByTime(999);
    expect(events).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({ id: "s1", info: null });
  });

  it("a new stream during the quiet window cancels the pending clear", () => {
    act("s1", 1);
    act("s1", 0);
    vi.advanceTimersByTime(500);
    act("s1", 1); // background work resumed — clear must not fire
    vi.advanceTimersByTime(2000);

    const infos = events.map((e) => e.info?.activeStreams ?? null);
    expect(infos).toEqual([1, 1]); // no null in between
  });

  it("never emits anything for activity that starts AND ends during the run", () => {
    markRunning("s1");
    act("s1", 1);
    act("s1", 0);
    settle("s1");
    vi.advanceTimersByTime(5000);
    expect(events).toEqual([]); // nothing was reported, so nothing to clear
  });

  it("a new run() retracts previously-reported background activity (null) and re-suppresses", () => {
    act("s1", 2); // post-settle background work reported
    expect(events).toHaveLength(1);

    (engine as any).suppressBackground("s1"); // run() start
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({ id: "s1", info: null });

    markRunning("s1");
    act("s1", 3);
    expect(events).toHaveLength(2); // suppressed again while the new turn runs
  });

  it("PTY release clears reported state (emits null) and drops it", () => {
    act("s1", 1);
    expect(events).toHaveLength(1);
    (engine as any).clearBackground("s1");
    expect(events[1]).toEqual({ id: "s1", info: null });
    // No dangling quiet-window timer fires a second null.
    vi.advanceTimersByTime(5000);
    expect(events).toHaveLength(2);
  });

  it("lifecycle onRelease wires into clearBackground", () => {
    act("s1", 1);
    expect(events).toHaveLength(1);
    // Adopt + release a fake handle so the lifecycle fires its release listeners.
    lifecycle.adopt("s1", { kill: () => {} } as any);
    lifecycle.releaseSession("s1");
    expect(events[1]).toEqual({ id: "s1", info: null });
  });
});
