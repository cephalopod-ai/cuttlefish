import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

interface FakePty {
  pid: number;
  killed: boolean;
  onData: (cb: (d: string) => void) => void;
  onExit: (cb: (e: { exitCode: number }) => void) => void;
  on: (event: string, cb: (...a: any[]) => void) => void;
  kill: (sig?: string) => void;
  resize: (cols: number, rows: number) => void;
  write: (data: string) => void;
  _exit: (code?: number) => void;
  _emitData: (data: string) => void;
  writes: string[];
}

interface SpawnCall { bin: string; args: string[]; opts: any; proc: FakePty }

const spawnCalls: SpawnCall[] = [];

function makeFakePty(): FakePty {
  let exitCb: ((e: { exitCode: number }) => void) | undefined;
  const dataCbs: Array<(d: string) => void> = [];
  const p: FakePty = {
    pid: 7373,
    killed: false,
    writes: [],
    onData: (cb) => { dataCbs.push(cb); },
    onExit: (cb) => { exitCb = cb; },
    on: () => {},
    kill: () => { p.killed = true; },
    resize: () => {},
    write: (data) => { p.writes.push(data); },
    _exit: (code = 0) => { exitCb?.({ exitCode: code }); },
    _emitData: (data) => { for (const cb of dataCbs) cb(data); },
  };
  return p;
}

vi.mock("node-pty", () => ({
  spawn: vi.fn((bin: string, args: string[], opts: any) => {
    const proc = makeFakePty();
    spawnCalls.push({ bin, args, opts, proc });
    return proc as unknown as import("node-pty").IPty;
  }),
}));

const osMockState = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fsm = await import("node:fs");
  const pathm = await import("node:path");
  osMockState.home = fsm.mkdtempSync(pathm.join(actual.tmpdir(), "grok-it-home-"));
  const homedir = () => osMockState.home;
  return { ...actual, homedir, default: { ...((actual as any).default ?? actual), homedir } };
});

import {
  buildGrokInteractiveArgs,
  findGrokTranscriptById,
  GrokInteractiveEngine,
  grokTranscriptLineToDeltas,
} from "../grok-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";

beforeEach(() => {
  spawnCalls.length = 0;
});

describe("Grok interactive protocol helpers", () => {
  it("builds new interactive PTY args without forcing a Grok session id", () => {
    const args = buildGrokInteractiveArgs({
      prompt: "",
      cwd: "/workspace",
      model: "grok-4.5",
      effortLevel: "xhigh",
      cliFlags: ["--chrome", "--custom"],
    } as any);

    expect(args).toContain("--no-auto-update");
    expect(args).toContain("--no-alt-screen");
    expect(args).toContain("--always-approve");
    expect(args[args.indexOf("--model") + 1]).toBe("grok-4.5");
    expect(args[args.indexOf("--effort") + 1]).toBe("xhigh");
    expect(args[args.indexOf("--cwd") + 1]).toBe("/workspace");
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("--resume");
    expect(args).not.toContain("--output-format");
    expect(args).not.toContain("--chrome");
    expect(args).toContain("--custom");
    expect(args).not.toContain("initial prompt");
  });

  it("builds resume args for an existing Grok session id", () => {
    const args = buildGrokInteractiveArgs({
      prompt: "",
      cwd: "/workspace",
      model: "grok-4.5",
    } as any, "grok-session-1");

    expect(args[args.indexOf("--resume") + 1]).toBe("grok-session-1");
    expect(args).not.toContain("--session-id");
  });

  it("can pass the system prompt as a Grok CLI override", () => {
    const args = buildGrokInteractiveArgs({
      prompt: "",
      cwd: "/workspace",
      model: "grok-4.5",
    } as any, "sess-1", "system instructions");

    expect(args[args.indexOf("--system-prompt-override") + 1]).toBe("system instructions");
  });

  it("does not pass the removed grok-build pin to an interactive CLI", () => {
    const args = buildGrokInteractiveArgs({ prompt: "", model: "grok-build" } as any);

    expect(args).not.toContain("--model");
  });

  it("parses transcript lines through the shared Grok JSON parser", () => {
    const parsed = grokTranscriptLineToDeltas(JSON.stringify({
      type: "result",
      result: "done",
      session_id: "grok-session",
      done: true,
    }));
    expect(parsed.sessionId).toBe("grok-session");
    expect(parsed.doneText).toBe("done");
    expect(parsed.terminal).toBe(true);
  });

  it("finds a transcript by session id in filename or contents", () => {
    const root = path.join(osMockState.home, ".grok", "sessions");
    fs.mkdirSync(root, { recursive: true });
    const byNameDir = path.join(root, "session-grok-name-1");
    fs.mkdirSync(byNameDir, { recursive: true });
    const byName = path.join(byNameDir, "updates.jsonl");
    fs.writeFileSync(byName, "{}\n");
    expect(findGrokTranscriptById("grok-name-1", root)).toBe(byName);

    const byContentDir = path.join(root, "random");
    fs.mkdirSync(byContentDir, { recursive: true });
    const byContent = path.join(byContentDir, "chat_history.jsonl");
    fs.writeFileSync(byContent, JSON.stringify({ session_id: "grok-content-1" }) + "\n");
    expect(findGrokTranscriptById("grok-content-1", root)).toBe(byContent);
  });
});

describe("GrokInteractiveEngine", () => {
  let lifecycle: PtyLifecycleManager;
  let engine: GrokInteractiveEngine;
  let sessionsDir: string;
  let fileSeq = 0;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  beforeEach(() => {
    lifecycle = new PtyLifecycleManager({ maxLivePtys: 8 });
    engine = new GrokInteractiveEngine(lifecycle);
    sessionsDir = path.join(osMockState.home, ".grok", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
  });

  function freshTranscriptPath(): string {
    return path.join(sessionsDir, `rollout-${++fileSeq}.jsonl`);
  }

  it("forwards model/session into idle-spawned PTY args", () => {
    engine.ensureIdleSpawn("cuttlefish-session", {
      engineSessionId: "grok-session",
      model: "grok-4.5",
      cwd: "/tmp",
      cols: 100,
      rows: 40,
    });
    const args = spawnCalls[spawnCalls.length - 1]!.args;
    expect(args[args.indexOf("--model") + 1]).toBe("grok-4.5");
    expect(args[args.indexOf("--resume") + 1]).toBe("grok-session");
    lifecycle.dispose();
  });

  it("respawns an idle PTY when effort changes", () => {
    engine.ensureIdleSpawn("cuttlefish-session", {
      engineSessionId: "grok-session",
      model: "grok-4.5",
      effortLevel: "low",
      cwd: "/tmp",
    });
    expect(spawnCalls).toHaveLength(1);
    const first = spawnCalls[0]!;

    engine.ensureIdleSpawn("cuttlefish-session", {
      engineSessionId: "grok-session",
      model: "grok-4.5",
      effortLevel: "high",
      cwd: "/tmp",
    });

    expect(spawnCalls).toHaveLength(2);
    expect(first.proc.killed).toBe(true);
    const args = spawnCalls[1]!.args;
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
    lifecycle.dispose();
  });

  it("disables inherited Claude/Cursor MCP compatibility for PTY launches", () => {
    engine.ensureIdleSpawn("cuttlefish-session", {
      engineSessionId: "grok-session",
      model: "grok-4.5",
      cwd: "/tmp",
    });
    const env = spawnCalls[spawnCalls.length - 1]!.opts.env;
    expect(env.GROK_CLAUDE_MCPS_ENABLED).toBe("false");
    expect(env.GROK_CURSOR_MCPS_ENABLED).toBe("false");
    lifecycle.dispose();
  });

  it("answers Grok terminal cursor-position queries", () => {
    engine.ensureIdleSpawn("cuttlefish-session", {
      engineSessionId: "grok-session",
      model: "grok-4.5",
      cwd: "/tmp",
    });
    const call = spawnCalls[spawnCalls.length - 1]!;
    call.proc._emitData("hello\x1b[6n");
    expect(call.proc.writes).toContain("\x1b[1;1R");
    lifecycle.dispose();
  });

  it("submits the first prompt through the PTY and resolves from the discovered transcript", async () => {
    const run = engine.run({
      prompt: "hello grok",
      systemPrompt: "system instructions\nwith a newline",
      sessionId: "cuttlefish-run-1",
      cwd: "/tmp",
      model: "grok-4.5",
    } as any);

    const call = spawnCalls[spawnCalls.length - 1]!;
    expect(call.args).not.toContain("--session-id");
    expect(call.args).not.toContain("--resume");
    expect(call.args[call.args.indexOf("--system-prompt-override") + 1]).toBe("system instructions\nwith a newline");
    expect(call.args).not.toContain("hello grok");
    expect(call.proc.writes.join("")).not.toContain("hello grok");

    call.proc._emitData("Grok Build Beta ❯ GrokBuild·always-approve");
    await sleep(300);
    expect(call.proc.writes.join("")).toContain("hello grok");
    expect(call.proc.writes.join("")).not.toContain("system instructions");
    expect(call.proc.writes.join("")).not.toContain("\x1b[200~");
    call.proc._emitData("Run Grok Build in a project directory?");
    await sleep(300);
    expect(call.proc.writes).toContain("\r");

    const file = path.join(sessionsDir, "cuttlefish-run-1", "updates.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      JSON.stringify({ session_id: "cuttlefish-run-1" }),
      "",
    ].join("\n"));

    await sleep(300);
    fs.appendFileSync(file, [
      JSON.stringify({
        method: "session/update",
        params: {
          sessionId: "cuttlefish-run-1",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi there" } },
        },
      }),
      JSON.stringify({ type: "end", sessionId: "cuttlefish-run-1", done: true }),
      "",
    ].join("\n"));
    const result = await run;
    expect(result).toMatchObject({ sessionId: "cuttlefish-run-1", result: "hi there", numTurns: 1 });
    lifecycle.dispose();
  }, 30000);
});
