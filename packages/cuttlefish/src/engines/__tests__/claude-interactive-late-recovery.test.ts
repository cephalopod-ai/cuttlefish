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
    // The blank Stop tore the listener down — a later real Stop must NOT fire.
    registry.deliver("cuttlefish-1", { hook_event_name: "Stop", last_assistant_message: "real text" });
    expect(recovered).toEqual([]);
  });

  it("re-arming replaces the previous listener — only the second callback fires", () => {
    const first: string[] = [];
    const second: string[] = [];
    engine.armLateRecovery("cuttlefish-1", { prompt: "x", cwd: "/tmp", onLateRecovery: (i) => first.push(i.result) });
    engine.armLateRecovery("cuttlefish-1", { prompt: "x", cwd: "/tmp", onLateRecovery: (i) => second.push(i.result) });
    registry.deliver("cuttlefish-1", { hook_event_name: "Stop", last_assistant_message: "answer" });
    expect(first).toEqual([]);
    expect(second).toEqual(["answer"]);
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
    registry.deliver("cuttlefish-1", { hook_event_name: "Stop", last_assistant_message: "ignored" });
    // Nothing consumed the hook — it must still be buffered for the next listener.
    const drained: string[] = [];
    registry.register("cuttlefish-1", (h) => drained.push(String(h.last_assistant_message ?? "")));
    expect(drained).toEqual(["ignored"]);
  });
});
