import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// node-pty loads a native module at import time that fails on Linux CI; the
// recycle path under test never spawns, so mocking keeps it portable.
vi.mock("node-pty", () => ({ spawn: vi.fn() }));

import { InteractiveClaudeEngine } from "../claude-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { HookRegistry } from "../../gateway/hook-registry.js";

function fakeHandle() {
  const h: any = { killed: false, pid: Math.floor(Math.random() * 9999) };
  h.kill = () => { h.killed = true; };
  return h;
}

describe("InteractiveClaudeEngine — killIdle (org-reload recycle)", () => {
  let registry: HookRegistry;
  let lifecycle: PtyLifecycleManager;
  let engine: InteractiveClaudeEngine;

  beforeEach(() => {
    registry = new HookRegistry();
    lifecycle = new PtyLifecycleManager({ maxLivePtys: 8 });
    engine = new InteractiveClaudeEngine(lifecycle, registry);
  });
  afterEach(() => registry.dispose());

  it("releases idle warm PTYs but never interrupts or releases an in-flight turn", () => {
    // An idle warm PTY (no active turn) — should be recycled so the next turn
    // cold-respawns with the fresh persona.
    const idle = fakeHandle();
    lifecycle.adopt("idle", idle);

    // A session mid-turn: it wrote the org file that triggered the reload. Its
    // PTY must survive and its resolver must NOT be interrupted.
    const active = fakeHandle();
    lifecycle.adopt("active", active);
    lifecycle.turnStarted("active");
    const interrupt = vi.fn();
    (engine as any).active.set("active", { resolver: { interrupt } });

    engine.killIdle();

    expect(idle.killed).toBe(true);
    expect(engine.hasWarmPty("idle")).toBe(false);

    expect(active.killed).toBe(false);
    expect(engine.hasWarmPty("active")).toBe(true);
    expect(interrupt).not.toHaveBeenCalled();
    expect(engine.isTurnRunning("active")).toBe(true);
  });
});
