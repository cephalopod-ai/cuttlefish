import { describe, it, expect, vi, beforeEach } from "vitest";
import { withTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

// Controllable fake PTYs. Each pty.spawn() pushes one here so the test can drive
// its onExit precisely (reproducing the kill->respawn race timing).
interface FakePty {
  pid: number;
  _exitCode: number | null;
  _killCalled: boolean;
  _exitCb?: (e: { exitCode: number }) => void;
  onData: (cb: (d: string) => void) => void;
  onExit: (cb: (e: { exitCode: number }) => void) => void;
  kill: (signal?: string) => void;
  write: (d: string) => void;
  resize: (c: number, r: number) => void;
  on: (event: string, cb: (...a: any[]) => void) => void;
  fireExit: () => void;
}
const ptys: FakePty[] = [];
function makeFakePty(): FakePty {
  const p: FakePty = {
    pid: 1000 + ptys.length,
    _exitCode: null,
    _killCalled: false,
    onData() {},
    onExit(cb) { p._exitCb = cb; },
    kill() { p._killCalled = true; }, // signal sent; real exit is async (fireExit)
    write() {},
    resize() {},
    on() {},
    fireExit() { p._exitCode = 0; p._exitCb?.({ exitCode: 0 }); },
  };
  return p;
}

vi.mock("../pty-stream.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pty-stream.js")>();
  return {
    ...actual,
    spawnPty: vi.fn(() => { const p = makeFakePty(); ptys.push(p); return p; }),
  };
});
// Avoid real sockets: the SSE proxy is exercised empirically elsewhere (Item A).
vi.mock("../sse-pty-proxy.js", () => ({
  MAIN_AGENT_SENTINEL: "<!-- cuttlefish-main-agent:5c1f -->",
  SsePtyProxy: class {
    port = 0;
    constructor(_label: string, _onEvent: (e: unknown) => void) {}
    async start() { return 41000; }
    stop() {}
  },
}));
vi.mock("../shared/claude-settings.js", () => ({
  writeSessionSettings: () => "/tmp/fake-settings.json",
}));

import { InteractiveClaudeEngine } from "../claude-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";

const flush = () => new Promise((r) => setTimeout(r, 15));

withTempCuttlefishHome("cuttlefish-claude-race-");

describe("InteractiveClaudeEngine — kill->respawn race (Item C)", () => {
  let lifecycle: PtyLifecycleManager;
  let hookCb: ((h: any) => void) | undefined;
  let engine: InteractiveClaudeEngine;

  beforeEach(() => {
    ptys.length = 0;
    hookCb = undefined;
    lifecycle = new PtyLifecycleManager({ maxLivePtys: 10 });
    const hookRegistry = {
      register: (_id: string, cb: (h: any) => void) => { hookCb = cb; },
      unregister: () => {},
    } as any;
    engine = new InteractiveClaudeEngine(lifecycle, hookRegistry);
  });

  it("a stale PTY's exit does not kill or poison the freshly-respawned turn", async () => {
    // Turn 1 (cold spawn).
    const p1 = engine.run({ sessionId: "s1", prompt: "a", cwd: "/tmp" } as any);
    await flush();
    const ptyA = ptys[0];
    expect(ptyA).toBeDefined();

    // api.ts interrupts the in-flight turn for a new message.
    engine.kill("s1", "Interrupted: new message received");
    const r1 = await p1;
    expect(r1.error).toBe("Interrupted: new message received");

    // Turn 2 (cold spawn — releaseSession cleared the warm entry).
    let r2: any;
    void engine.run({ sessionId: "s1", prompt: "b", cwd: "/tmp" } as any).then((v) => { r2 = v; });
    await flush();
    const ptyB = ptys[1];
    expect(ptyB).toBeDefined();
    expect(ptyB).not.toBe(ptyA);

    // The OLD PTY's SIGTERM finally takes effect — its exit fires AFTER ptyB was adopted.
    ptyA.fireExit();
    await flush();

    // Fix assertions: the stale exit neither killed ptyB nor settled turn 2.
    expect(ptyB._killCalled).toBe(false);
    expect(r2).toBeUndefined();

    // Turn 2 then completes normally via its own hooks — no double-error.
    hookCb!({ hook_event_name: "SessionStart", session_id: "c2" });
    hookCb!({ hook_event_name: "Stop", last_assistant_message: "done2" });
    await flush();
    expect(r2.result).toBe("done2");
    expect(r2.error).toBeUndefined();
  });

  it("a genuine crash of the current turn's PTY still interrupts (no hang)", async () => {
    const p = engine.run({ sessionId: "s2", prompt: "c", cwd: "/tmp" } as any);
    await flush();
    const ptyC = ptys[0];
    ptyC.fireExit(); // current PTY dies mid-turn with no Stop hook
    const r = await p;
    expect(r.error).toMatch(/claude process exited/);
  });
});
