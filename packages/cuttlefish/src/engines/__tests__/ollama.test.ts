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

import { OllamaEngine, buildOllamaPrompt } from "../ollama.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  spawnCalls.length = 0;
  getMessages.mockReset();
  getMessages.mockReturnValue([]);
});

describe("buildOllamaPrompt", () => {
  it("serializes prior turns and appends latest-turn attachments", () => {
    const prompt = buildOllamaPrompt(
      {
        prompt: "review the diff",
        systemPrompt: "be terse",
        attachments: ["/tmp/patch.diff"],
        sessionId: "s1",
      },
      [
        { id: "1", role: "user", content: "please help", timestamp: 1 },
        { id: "2", role: "assistant", content: "what do you need?", timestamp: 2 },
        { id: "3", role: "user", content: "review the diff", timestamp: 3 },
      ],
    );

    expect(prompt).toContain("System instructions:");
    expect(prompt).toContain("User:\nplease help");
    expect(prompt).toContain("Assistant:\nwhat do you need?");
    expect(prompt).toContain("Attached files for the latest user turn:\n- /tmp/patch.diff");
    expect(prompt.endsWith("Assistant:")).toBe(true);
  });
});

describe("OllamaEngine", () => {
  it("spawns ollama run and resolves streamed stdout on close", async () => {
    const engine = new OllamaEngine();
    const streamed: string[] = [];
    const promise = engine.run({
      prompt: "hello",
      cwd: "/tmp",
      model: "gemma4",
      onStream: (delta) => streamed.push(delta.content),
    });

    await flush();
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.args[0]).toBe("run");
    expect(spawnCalls[0]?.args[1]).toBe("gemma4");
    expect(spawnCalls[0]?.args[2]).toContain("User:\nhello");

    spawnCalls[0]?.proc.emitStdout("hi there");
    spawnCalls[0]?.proc.close(0);

    const result = await promise;
    expect(streamed.join("")).toBe("hi there");
    expect(result.result).toBe("hi there");
    expect(result.error).toBeUndefined();
  });

  it("rebuilds session history from Cuttlefish messages instead of relying on native resume ids", async () => {
    getMessages.mockReturnValue([
      { id: "1", role: "user", content: "first", timestamp: 1 },
      { id: "2", role: "assistant", content: "done", timestamp: 2 },
      { id: "3", role: "user", content: "follow up", timestamp: 3 },
    ]);
    const engine = new OllamaEngine();
    const promise = engine.run({ prompt: "follow up", cwd: "/tmp", sessionId: "sess-1", model: "gemma4" });

    await flush();
    expect(spawnCalls[0]?.args[2]).toContain("Assistant:\ndone");
    expect(spawnCalls[0]?.args[2].match(/User:\nfollow up/g)?.length).toBe(1);

    spawnCalls[0]?.proc.emitStdout("answer");
    spawnCalls[0]?.proc.close(0);
    await expect(promise).resolves.toMatchObject({ sessionId: "sess-1", result: "answer" });
  });
});
