import { afterEach, describe, it, expect, vi } from "vitest";

// claude-interactive.ts imports node-pty at the top level. node-pty loads its
// native module at import time and that fails on Linux CI runners (looks for
// prebuilds/linux-x64/pty.node under a wrong relative path). TurnResolver is a
// pure-JS class with zero PTY dependency, so mocking the module keeps the test
// focused and CI-portable.
vi.mock("node-pty", () => ({ spawn: vi.fn() }));

import { TurnResolver, buildInteractiveArgs, claudeHookToDeltas, pasteAndSubmit } from "../claude-interactive.js";
import { MAIN_AGENT_SENTINEL } from "../sse-pty-proxy.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("claudeHookToDeltas", () => {
  it("does not emit a duplicate tool_use for PreToolUse", () => {
    expect(claudeHookToDeltas({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "printf ok" },
    })).toEqual([]);
  });

  it("emits a tool_result for PostToolUse", () => {
    expect(claudeHookToDeltas({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
    })).toEqual([{ type: "tool_result", content: "Bash", toolName: "Bash" }]);
  });
});

describe("TurnResolver", () => {
  it("resolves only after BOTH SessionStart and Stop", async () => {
    const r = new TurnResolver({ fallbackSessionId: "old" });
    let resolved: any;
    r.promise.then((v) => { resolved = v; });
    r.onHook({ hook_event_name: "Stop", last_assistant_message: "done" });
    await new Promise((res) => setTimeout(res, 5));
    expect(resolved).toBeUndefined(); // Stop alone is not enough
    r.onHook({ hook_event_name: "SessionStart", session_id: "claude-123" });
    await new Promise((res) => setTimeout(res, 5));
    expect(resolved.result).toBe("done");
    expect(resolved.sessionId).toBe("claude-123");
    expect(resolved.numTurns).toBe(1);
  });

  it("settles with an Interrupted error when killed", async () => {
    const r = new TurnResolver({ fallbackSessionId: "old" });
    r.onHook({ hook_event_name: "SessionStart", session_id: "c1" });
    r.interrupt("Interrupted: user");
    const v = await r.promise;
    expect(v.error).toMatch(/^Interrupted/);
  });

  it("treats a missing session id as a hard error", async () => {
    const r = new TurnResolver({ fallbackSessionId: undefined });
    r.onHook({ hook_event_name: "SessionStart" }); // no session_id
    r.onHook({ hook_event_name: "Stop", last_assistant_message: "x" });
    const v = await r.promise;
    expect(v.error).toMatch(/session id/i);
  });

  it("with assumeStarted, resolves on Stop alone using fallbackSessionId", async () => {
    const r = new TurnResolver({ fallbackSessionId: "warm-sid", assumeStarted: true });
    r.onHook({ hook_event_name: "Stop", last_assistant_message: "ok" });
    const v = await r.promise;
    expect(v.result).toBe("ok");
    expect(v.sessionId).toBe("warm-sid");
    expect(v.numTurns).toBe(1);
  });

  it("strips leaked thinking blocks from Stop hook assistant text", async () => {
    const r = new TurnResolver({ fallbackSessionId: "warm-sid", assumeStarted: true });
    r.onHook({
      hook_event_name: "Stop",
      last_assistant_message: "<thinking>private reasoning</thinking>\n\nVisible answer.",
    });
    const v = await r.promise;
    expect(v.result).toBe("Visible answer.");
    expect(v.result).not.toContain("private reasoning");
    expect(v.sessionId).toBe("warm-sid");
  });

  it("settles immediately on StopFailure (does not wait for SessionStart) and exposes it", async () => {
    const r = new TurnResolver({ fallbackSessionId: "old" });
    r.onHook({ hook_event_name: "StopFailure", error: "rate_limit", error_details: "resets 3pm" });
    const v = await r.promise;
    expect(v.error).toMatch(/rate_limit/);
    expect(v.numTurns).toBe(1);
    expect(r.stopFailure?.error).toBe("rate_limit");
  });

  it("can recover-complete a turn when the Stop hook is missing", async () => {
    const r = new TurnResolver({ fallbackSessionId: "old" });
    r.onHook({ hook_event_name: "SessionStart", session_id: "c1" });
    r.completeRecovered("transcript final", "c1");
    const v = await r.promise;
    expect(v.result).toBe("transcript final");
    expect(v.sessionId).toBe("c1");
    expect(v.numTurns).toBe(1);
  });

  it("strips leaked thinking blocks from recovered transcript text", async () => {
    const r = new TurnResolver({ fallbackSessionId: "old" });
    r.onHook({ hook_event_name: "SessionStart", session_id: "c1" });
    r.completeRecovered("<thinking>private transcript reasoning</thinking>\n\nVisible transcript answer.", "c1");
    const v = await r.promise;
    expect(v.result).toBe("Visible transcript answer.");
    expect(v.result).not.toContain("private transcript reasoning");
  });
});

describe("buildInteractiveArgs — system prompt + sentinel via CLI flag", () => {
  // Regression guard: the claude CLI ignores the settings-file `appendSystemPrompt`
  // KEY (≥2.1.x), so the persona + MAIN_AGENT_SENTINEL MUST go via the
  // --append-system-prompt FLAG, or the SSE proxy never tees and live streaming dies.
  const flagValue = (args: string[]): string | undefined => {
    const i = args.indexOf("--append-system-prompt");
    return i >= 0 ? args[i + 1] : undefined;
  };

  it("emits --append-system-prompt carrying the persona AND the sentinel", () => {
    const args = buildInteractiveArgs({
      prompt: "hi",
      settingsPath: "/tmp/s.json",
      appendSystemPrompt: `You are Cuttlefish's COO.\n\n${MAIN_AGENT_SENTINEL}`,
    });
    const v = flagValue(args);
    expect(v).toBeDefined();
    expect(v).toContain("You are Cuttlefish's COO.");
    expect(v).toContain(MAIN_AGENT_SENTINEL);
  });

  it("omits the flag when no appendSystemPrompt is given", () => {
    const args = buildInteractiveArgs({ prompt: "hi", settingsPath: "/tmp/s.json" });
    expect(args).not.toContain("--append-system-prompt");
  });
});

describe("pasteAndSubmit", () => {
  it("waits for multiline bracketed paste to settle before submitting", () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const proc = { write: (data: string) => { writes.push(data); } };

    pasteAndSubmit(proc as any, "Describe this image\n\nAttached files:\n- /tmp/image.png");

    expect(writes).toEqual(["\x1b[200~Describe this image\n\nAttached files:\n- /tmp/image.png\x1b[201~"]);
    vi.advanceTimersByTime(149);
    expect(writes).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(writes).toEqual([
      "\x1b[200~Describe this image\n\nAttached files:\n- /tmp/image.png\x1b[201~",
      "\r",
    ]);
  });
});
