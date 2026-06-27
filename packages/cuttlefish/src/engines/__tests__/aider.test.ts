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
  emitStderr: (s: string) => void;
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
    pid: 9090,
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
    emitStderr(text) {
      stderr.write(Buffer.from(text));
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

import { AiderEngine } from "../aider.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  spawnCalls.length = 0;
  getMessages.mockReset();
  getMessages.mockReturnValue([]);
});

describe("AiderEngine", () => {
  it("runs one-shot with --message, --no-auto-commits, and per-attachment --file", async () => {
    const engine = new AiderEngine();
    const promise = engine.run({
      prompt: "implement feature",
      cwd: "/tmp/project",
      model: "sonnet",
      attachments: ["/tmp/spec.md"],
    });

    await flush();
    const args = spawnCalls[0]?.args ?? [];
    expect(args).toContain("--yes-always");
    expect(args).toContain("--no-auto-commits");
    expect(args).toContain("--no-pretty");
    expect(args).toContain("--no-check-update");
    expect(args).toContain("--model");
    expect(args).toContain("sonnet");
    expect(args).toContain("--file");
    expect(args).toContain("/tmp/spec.md");
    // --message is the last flag and the prompt is the final positional arg.
    expect(args.at(-2)).toBe("--message");

    spawnCalls[0]?.proc.emitStdout("done editing");
    spawnCalls[0]?.proc.close(0);
    await expect(promise).resolves.toMatchObject({ result: "done editing" });
  });

  it("omits --model when the model is the 'default' auto-detect sentinel", async () => {
    const engine = new AiderEngine();
    const promise = engine.run({ prompt: "hi", cwd: "/tmp/project", model: "default" });

    await flush();
    const args = spawnCalls[0]?.args ?? [];
    expect(args).not.toContain("--model");

    spawnCalls[0]?.proc.emitStdout("ok");
    spawnCalls[0]?.proc.close(0);
    await expect(promise).resolves.toMatchObject({ result: "ok" });
  });

  it("replays Cuttlefish session history into the aider prompt", async () => {
    getMessages.mockReturnValue([
      { id: "1", role: "user", content: "first question", timestamp: 1 },
      { id: "2", role: "assistant", content: "first answer", timestamp: 2 },
      { id: "3", role: "user", content: "follow up", timestamp: 3 },
    ]);
    const engine = new AiderEngine();
    const promise = engine.run({ prompt: "follow up", cwd: "/tmp/project", sessionId: "sess-1" });

    await flush();
    const prompt = spawnCalls[0]?.args.at(-1) ?? "";
    expect(prompt).toContain("Assistant:\nfirst answer");
    expect(prompt.match(/User:\nfollow up/g)?.length).toBe(1);

    spawnCalls[0]?.proc.emitStdout("answer");
    spawnCalls[0]?.proc.close(0);
    await expect(promise).resolves.toMatchObject({ sessionId: "sess-1", result: "answer" });
  });

  it("surfaces stderr as the error on a non-zero exit", async () => {
    const engine = new AiderEngine();
    const promise = engine.run({ prompt: "boom", cwd: "/tmp/project" });

    await flush();
    spawnCalls[0]?.proc.emitStderr("no provider API key found");
    spawnCalls[0]?.proc.close(1);
    await expect(promise).resolves.toMatchObject({ error: "no provider API key found" });
  });

  it("kill() resolves the turn with the termination reason", async () => {
    const engine = new AiderEngine();
    const promise = engine.run({ prompt: "long task", cwd: "/tmp/project", sessionId: "sess-kill" });

    await flush();
    engine.kill("sess-kill", "Interrupted: superseded");
    spawnCalls[0]?.proc.close(null);
    await expect(promise).resolves.toMatchObject({ result: "", error: "Interrupted: superseded" });
  });
});
