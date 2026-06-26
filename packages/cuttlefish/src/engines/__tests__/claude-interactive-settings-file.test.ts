import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { withTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

// Regression: the mid-chat model/effort switch cold-respawn used to write the
// per-turn --settings file BEFORE calling releaseSession() — but releaseSession()
// fires onCleanup → cleanupSessionSettings(), which DELETES that exact file. So the
// cold respawn spawned `claude --settings <file>` against a path we'd just unlinked,
// and the CLI/xterm view showed "Settings file not found". This test uses the REAL
// write/cleanup helpers and asserts the file exists on disk at every pty.spawn().

// Records, per pty.spawn() call, whether the --settings file existed at that instant.
const settingsExistedAtSpawn: boolean[] = [];

interface FakePty {
  pid: number;
  _exitCode: number | null;
  _exitCb?: (e: { exitCode: number }) => void;
  onData: (cb: (d: string) => void) => void;
  onExit: (cb: (e: { exitCode: number }) => void) => void;
  kill: () => void;
  write: () => void;
  resize: () => void;
  on: () => void;
}
const ptys: FakePty[] = [];
function makeFakePty(): FakePty {
  const p: FakePty = {
    pid: 2000 + ptys.length,
    _exitCode: null,
    onData() {},
    onExit(cb) { p._exitCb = cb; },
    kill() {},
    write() {},
    resize() {},
    on() {},
  };
  return p;
}

vi.mock("../pty-stream.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pty-stream.js")>();
  return {
    ...actual,
    spawnPty: vi.fn((_bin: string, args: string[]) => {
    const i = args.indexOf("--settings");
    const settingsPath = i >= 0 ? args[i + 1] : "";
    settingsExistedAtSpawn.push(settingsPath ? fs.existsSync(settingsPath) : false);
    const p = makeFakePty();
    ptys.push(p);
    return p;
    }),
  };
});
vi.mock("../sse-pty-proxy.js", () => ({
  MAIN_AGENT_SENTINEL: "<!-- cuttlefish-main-agent:5c1f -->",
  SsePtyProxy: class {
    port = 0;
    constructor(_label: string, _onEvent: (e: unknown) => void) {}
    async start() { return 41000; }
    stop() {}
  },
}));
// IMPORTANT: do NOT mock ../shared/claude-settings.js — the bug lived in the real
// write→delete ordering, so the test must exercise the real helpers.

import { InteractiveClaudeEngine } from "../claude-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { cleanupSessionSettings, sessionSettingsPath } from "../../shared/claude-settings.js";
import { CLAUDE_SETTINGS_DIR } from "../../shared/paths.js";

const flush = () => new Promise((r) => setTimeout(r, 15));
const SID = "test-settings-file-regression";

withTempCuttlefishHome("cuttlefish-claude-settings-");

describe("InteractiveClaudeEngine — settings file survives model-switch cold respawn", () => {
  let lifecycle: PtyLifecycleManager;
  let hookCb: ((h: any) => void) | undefined;
  let engine: InteractiveClaudeEngine;

  beforeEach(() => {
    ptys.length = 0;
    settingsExistedAtSpawn.length = 0;
    hookCb = undefined;
    // Mirror the gateway wiring: onCleanup deletes the per-session --settings file.
    lifecycle = new PtyLifecycleManager({
      maxLivePtys: 10,
      onCleanup: (id) => cleanupSessionSettings(CLAUDE_SETTINGS_DIR, id),
    });
    const hookRegistry = {
      register: (_id: string, cb: (h: any) => void) => { hookCb = cb; },
      unregister: () => {},
    } as any;
    engine = new InteractiveClaudeEngine(lifecycle, hookRegistry);
  });

  afterEach(() => {
    lifecycle.killAll();
    cleanupSessionSettings(CLAUDE_SETTINGS_DIR, SID);
  });

  it("the cold-respawned PTY is spawned against an EXISTING settings file", async () => {
    // Turn 1 — cold spawn with model "opus"; complete it so the PTY stays warm.
    const p1 = engine.run({ sessionId: SID, prompt: "a", cwd: "/tmp", model: "opus" } as any);
    await flush();
    hookCb!({ hook_event_name: "SessionStart", session_id: "c1" });
    hookCb!({ hook_event_name: "Stop", last_assistant_message: "done1" });
    await p1;
    expect(settingsExistedAtSpawn[0]).toBe(true); // baseline: turn 1 wrote then spawned

    // Turn 2 — same session, DIFFERENT model → triggers releaseSession (which deletes
    // the settings file) then a cold respawn. The fix re-writes the file AFTER the
    // release, so the new PTY must still spawn against an existing file.
    void engine.run({ sessionId: SID, prompt: "b", cwd: "/tmp", model: "sonnet" } as any);
    await flush();
    expect(ptys.length).toBe(2);                    // a genuine cold respawn happened
    expect(settingsExistedAtSpawn[1]).toBe(true);   // ← the regression guard
    // And the file is really on disk for the live PTY.
    expect(fs.existsSync(sessionSettingsPath(CLAUDE_SETTINGS_DIR, SID))).toBe(true);

    // Settle turn 2 so nothing dangles.
    hookCb!({ hook_event_name: "SessionStart", session_id: "c2" });
    hookCb!({ hook_event_name: "Stop", last_assistant_message: "done2" });
    await flush();
  });
});
