import { describe, it, expect, vi, beforeEach } from "vitest";
import { PassThrough } from "node:stream";

interface FakeProc {
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  killed: boolean;
  pid: number;
  kill: (sig?: string) => boolean;
  on: (event: string, cb: (...a: any[]) => void) => FakeProc;
  _handlers: Record<string, (...a: any[]) => void>;
  emitStdout: (s: string) => void;
  close: (code: number | null) => void;
}

const spawnCalls: Array<{ bin: string; args: string[]; proc: FakeProc }> = [];
const { getMessages } = vi.hoisted(() => ({
  getMessages: vi.fn<() => Array<{ id: string; role: string; content: string; timestamp: number }>>(() => []),
}));

function makeFakeProc(): FakeProc {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const handlers: Record<string, (...a: any[]) => void> = {};
  const proc: FakeProc = {
    stdout,
    stderr,
    exitCode: null,
    killed: false,
    pid: 8888,
    kill: () => {
      proc.killed = true;
      return true;
    },
    _handlers: handlers,
    on(event, cb) {
      handlers[event] = cb;
      return proc;
    },
    emitStdout(text) {
      stdout.write(Buffer.from(text));
    },
    close(code) {
      proc.exitCode = code;
      handlers.close?.(code);
    },
  };
  return proc;
}

vi.mock("node:child_process", () => ({
  spawn: vi.fn((bin: string, args: string[]) => {
    const proc = makeFakeProc();
    spawnCalls.push({ bin, args, proc });
    return proc;
  }),
}));

vi.mock("../../sessions/registry/messages.js", () => ({
  getMessages,
}));

import { KiloEngine } from "../kilo.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  spawnCalls.length = 0;
  getMessages.mockReset();
  getMessages.mockReturnValue([]);
});

describe("KiloEngine", () => {
  it("uses autonomous kilo run flags, model, variant, and attachments", async () => {
    const engine = new KiloEngine();
    const promise = engine.run({
      prompt: "implement feature",
      cwd: "/tmp/project",
      model: "kilo-auto/free",
      effortLevel: "high",
      attachments: ["/tmp/spec.md"],
    });

    await flush();
    const args = spawnCalls[0]?.args ?? [];
    expect(args).toContain("run");
    expect(args).toContain("--auto");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--model");
    expect(args).toContain("kilo-auto/free");
    expect(args).toContain("--variant");
    expect(args).toContain("high");
    expect(args).toContain("--file");
    expect(args).toContain("/tmp/spec.md");

    spawnCalls[0]?.proc.emitStdout("done");
    spawnCalls[0]?.proc.close(0);
    await expect(promise).resolves.toMatchObject({ result: "done" });
  });

  it("replays Cuttlefish session history into the Kilo prompt", async () => {
    getMessages.mockReturnValue([
      { id: "1", role: "user", content: "first question", timestamp: 1 },
      { id: "2", role: "assistant", content: "first answer", timestamp: 2 },
      { id: "3", role: "user", content: "follow up", timestamp: 3 },
    ]);
    const engine = new KiloEngine();
    const promise = engine.run({ prompt: "follow up", cwd: "/tmp/project", sessionId: "sess-1" });

    await flush();
    const prompt = spawnCalls[0]?.args.at(-1) ?? "";
    expect(prompt).toContain("Assistant:\nfirst answer");
    expect(prompt.match(/User:\nfollow up/g)?.length).toBe(1);

    spawnCalls[0]?.proc.emitStdout("answer");
    spawnCalls[0]?.proc.close(0);
    await expect(promise).resolves.toMatchObject({ sessionId: "sess-1", result: "answer" });
  });
});
