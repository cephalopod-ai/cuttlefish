import { describe, it, expect } from "vitest";
import { TurnResolver, isNativeClaudeCommand } from "../claude-interactive.js";

function probe(r: TurnResolver) {
  let value: import("../../shared/types.js").EngineResult | undefined;
  void r.promise.then((v) => { value = v; });
  return () => value;
}

describe("isNativeClaudeCommand — local built-ins that produce no assistant turn", () => {
  it("recognizes the previously-handled context commands", () => {
    expect(isNativeClaudeCommand("/compact")).toBe(true);
    expect(isNativeClaudeCommand("/clear")).toBe(true);
    expect(isNativeClaudeCommand("/model opus")).toBe(true);
  });

  it("recognizes the info/overlay commands that caused duplicate chat echoes", () => {
    // /usage and /limits fire a Stop hook on dismiss but produce no new
    // assistant message — the regression this test guards.
    expect(isNativeClaudeCommand("/usage")).toBe(true);
    expect(isNativeClaudeCommand("/limits")).toBe(true);
    expect(isNativeClaudeCommand("/cost")).toBe(true);
    expect(isNativeClaudeCommand("/status")).toBe(true);
  });

  it("does NOT treat real-turn or skill slash commands as native", () => {
    expect(isNativeClaudeCommand("/init")).toBe(false);
    expect(isNativeClaudeCommand("/review")).toBe(false);
    expect(isNativeClaudeCommand("/sync @cuttlefish-dev")).toBe(false);
    expect(isNativeClaudeCommand("just a normal message")).toBe(false);
  });
});

describe("TurnResolver — native command never persists a stale Stop message", () => {
  it("settles a native turn with empty result even when Stop carries stale last_assistant_message", async () => {
    // Reproduces the duplicate-message bug: a local command (e.g. /usage) ends
    // its turn with a Stop hook whose last_assistant_message is the PREVIOUS
    // turn's text. A native turn must NOT persist that stale text.
    const r = new TurnResolver({ fallbackSessionId: "sid", assumeStarted: true, native: true });
    const get = probe(r);
    r.onHook({ hook_event_name: "Stop", session_id: "sid", last_assistant_message: "Previous assistant message (previous turn)" });
    await Promise.resolve();
    expect(get()?.result).toBe("");
  });

  it("a non-native turn still persists the Stop's last_assistant_message", async () => {
    const r = new TurnResolver({ fallbackSessionId: "sid", assumeStarted: true });
    const get = probe(r);
    r.onHook({ hook_event_name: "Stop", session_id: "sid", last_assistant_message: "real answer" });
    await Promise.resolve();
    expect(get()?.result).toBe("real answer");
  });
});
