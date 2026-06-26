import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { StreamDelta, EngineResult } from "../../shared/types.js";

interface FakeProc {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end: () => void };
  exitCode: number | null;
  killed: boolean;
  kill: (sig?: string) => boolean;
  pid: number;
  on: (event: string, cb: (...a: any[]) => void) => FakeProc;
  _handlers: Record<string, (...a: any[]) => void>;
  emitStdout: (s: string) => void;
  emitStderr: (s: string) => void;
  close: (code: number | null) => void;
}

interface SpawnCall {
  bin: string;
  args: string[];
  opts: unknown;
  proc: FakeProc;
}

const spawnCalls: SpawnCall[] = [];

function makeFakeProc(): FakeProc {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const handlers: Record<string, (...a: any[]) => void> = {};
  const p: FakeProc = {
    stdout,
    stderr,
    stdin: { end: () => {} },
    exitCode: null,
    killed: false,
    pid: 6363,
    kill: () => true,
    _handlers: handlers,
    on(event, cb) {
      handlers[event] = cb;
      return p;
    },
    emitStdout(s) {
      stdout.emit("data", Buffer.from(s));
    },
    emitStderr(s) {
      stderr.emit("data", Buffer.from(s));
    },
    close(code) {
      p.exitCode = code;
      handlers["close"]?.(code);
    },
  };
  return p;
}

vi.mock("node:child_process", () => ({
  spawn: vi.fn((bin: string, args: string[], opts: unknown) => {
    const proc = makeFakeProc();
    spawnCalls.push({ bin, args, opts, proc });
    return proc;
  }),
}));

const osMockState = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fsm = await import("node:fs");
  const pathm = await import("node:path");
  osMockState.home = fsm.mkdtempSync(pathm.join(actual.tmpdir(), "grok-home-"));
  const homedir = () => osMockState.home;
  return { ...actual, homedir, default: { ...((actual as any).default ?? actual), homedir } };
});

import { buildGrokHeadlessArgs, GrokEngine, grokVisibleDeltas, parseGrokJsonLine } from "../grok.js";

const flush = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2500): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started >= timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await sleep(25);
  }
}

async function runWith(
  stdoutLines: string[],
  opts: Record<string, unknown> = {},
  closeCode = 0,
): Promise<{ result: EngineResult; deltas: StreamDelta[]; call: SpawnCall }> {
  const deltas: StreamDelta[] = [];
  const engine = new GrokEngine();
  const promise = engine.run({
    prompt: "hello",
    cwd: "/tmp",
    sessionId: "cuttlefish-session-1",
    model: "grok-build",
    onStream: (d: StreamDelta) => deltas.push(d),
    ...opts,
  } as any);

  await flush();
  const call = spawnCalls[spawnCalls.length - 1];
  expect(call).toBeDefined();
  if (stdoutLines.length) call.proc.emitStdout(stdoutLines.join("\n") + "\n");
  call.proc.close(closeCode);
  const result = await promise;
  return { result, deltas, call };
}

beforeEach(() => {
  spawnCalls.length = 0;
});

describe("GrokEngine args", () => {
  it("builds headless streaming-json args", () => {
    const args = buildGrokHeadlessArgs({
      prompt: "ignored",
      cwd: "/workspace",
      model: "grok-build",
      effortLevel: "high",
      cliFlags: ["--chrome", "--some-grok-flag"],
    } as any, "do work", "sess-1");

    expect(args).toContain("--no-auto-update");
    expect(args).toContain("--always-approve");
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("streaming-json");
    expect(args[args.indexOf("--model") + 1]).toBe("grok-build");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
    expect(args[args.indexOf("--cwd") + 1]).toBe("/workspace");
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("--resume");
    expect(args).not.toContain("--chrome");
    expect(args).toContain("--some-grok-flag");
    expect(args.slice(-2)).toEqual(["-p", "do work"]);
  });

  it("omits --effort for the default effort", () => {
    const args = buildGrokHeadlessArgs({
      prompt: "ignored",
      effortLevel: "default",
    } as any, "do work", "sess-1");

    expect(args).not.toContain("--effort");
  });

  it("uses --resume for headless follow-up turns", () => {
    const args = buildGrokHeadlessArgs({
      prompt: "ignored",
      resumeSessionId: "sess-1",
    } as any, "continue work", "sess-1");

    expect(args[args.indexOf("--resume") + 1]).toBe("sess-1");
    expect(args).not.toContain("--session-id");
    expect(args.slice(-2)).toEqual(["-p", "continue work"]);
  });
});

describe("parseGrokJsonLine", () => {
  it("parses assistant message snapshots", () => {
    const parsed = parseGrokJsonLine(JSON.stringify({
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      session_id: "grok-1",
    }));
    expect(parsed?.sessionId).toBe("grok-1");
    expect(parsed?.doneText).toBe("done");
    expect(parsed?.deltas).toContainEqual({ type: "text_snapshot", content: "done" });
  });

  it("parses delta chunks", () => {
    const parsed = parseGrokJsonLine(JSON.stringify({ type: "content_delta", delta: "hel" }));
    expect(parsed?.deltas).toEqual([{ type: "text", content: "hel" }]);
  });

  it("drops thought/reasoning entirely — no placeholder line, no raw text", () => {
    // Raw reasoning ("thought") must never reach the UI. It is dropped completely
    // (no generic placeholder card either — the user hated that line); the spinner
    // covers the reasoning stretch while answer text streams live separately.
    const parsed = parseGrokJsonLine(JSON.stringify({ type: "thought", data: "checking secret files in /etc" }));
    expect(parsed?.deltas).toEqual([]);
    // The raw reasoning text is never echoed into any delta.
    expect(JSON.stringify(parsed?.deltas)).not.toContain("checking secret files");
    // Answer text, by contrast, IS surfaced as a live text delta.
    expect(parseGrokJsonLine(JSON.stringify({ type: "text", data: "G" }))?.deltas)
      .toEqual([{ type: "text", content: "G" }]);
  });

  it("drops reasoning-like event names even when they carry generic text fields", () => {
    const parsed = parseGrokJsonLine(JSON.stringify({
      type: "reasoning_delta",
      content: "private chain-of-thought",
    }));

    expect(parsed?.deltas).toEqual([]);
    expect(JSON.stringify(parsed)).not.toContain("private chain-of-thought");
  });

  it("omits thinking blocks from mixed assistant content snapshots", () => {
    const parsed = parseGrokJsonLine(JSON.stringify({
      type: "message",
      role: "assistant",
      content: [
        { type: "thinking", text: "hidden reasoning" },
        { type: "text", text: "visible answer" },
      ],
      session_id: "grok-1",
    }));

    expect(parsed?.sessionId).toBe("grok-1");
    expect(parsed?.doneText).toBe("visible answer");
    expect(parsed?.deltas).toContainEqual({ type: "text_snapshot", content: "visible answer" });
    expect(JSON.stringify(parsed)).not.toContain("hidden reasoning");
  });

  it("skips Grok transcript user/system entries", () => {
    expect(parseGrokJsonLine(JSON.stringify({ type: "user", content: "<system-reminder>startup</system-reminder>" }))?.deltas)
      .toEqual([]);
    expect(parseGrokJsonLine(JSON.stringify({ type: "system", content: "policy" }))?.deltas)
      .toEqual([]);
  });

  it("parses Grok interactive update message chunks", () => {
    const parsed = parseGrokJsonLine(JSON.stringify({
      method: "session/update",
      params: {
        sessionId: "grok-pty-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
        },
      },
    }));
    expect(parsed?.sessionId).toBe("grok-pty-session");
    expect(parsed?.deltas).toEqual([{ type: "text", content: "hello" }]);
  });

  it("drops interactive thought chunks entirely (raw reasoning never displayed)", () => {
    const parsed = parseGrokJsonLine(JSON.stringify({
      method: "session/update",
      params: {
        sessionId: "grok-pty-session",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "<thinking>checking the repository</thinking>" },
        },
      },
    }));
    expect(parsed?.sessionId).toBe("grok-pty-session");
    // Reasoning is dropped completely — no placeholder status, no raw text.
    expect(parsed?.deltas).toEqual([]);
    expect(JSON.stringify(parsed?.deltas)).not.toContain("checking the repository");
    expect(JSON.stringify(parsed?.deltas)).not.toContain("<thinking>");
  });

  it("parses Grok interactive tool calls and completions", () => {
    const start = parseGrokJsonLine(JSON.stringify({
      method: "session/update",
      params: {
        sessionId: "grok-pty-session",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          title: "read_file",
          rawInput: { target_file: "/tmp/a.txt" },
        },
      },
    }));
    expect(start?.deltas).toEqual([{
      type: "tool_use",
      content: "Using read_file",
      toolName: "read_file",
      toolId: "tool-1",
      input: "{\"target_file\":\"/tmp/a.txt\"}",
    }]);

    const done = parseGrokJsonLine(JSON.stringify({
      method: "session/update",
      params: {
        sessionId: "grok-pty-session",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "ok" } }],
          rawOutput: { type: "ReadFile" },
        },
      },
    }));
    expect(done?.deltas).toEqual([{
      type: "tool_result",
      content: "ok",
      toolName: "read_file",
      toolId: "tool-1",
    }]);
  });

  it("parses Grok plan and retry updates as status", () => {
    const plan = parseGrokJsonLine(JSON.stringify({
      method: "session/update",
      params: {
        sessionId: "grok-pty-session",
        update: {
          sessionUpdate: "plan",
          entries: [
            { content: "Read files", status: "completed" },
            { content: "Patch parser", status: "in_progress" },
          ],
        },
      },
    }));
    expect(plan?.deltas).toEqual([{ type: "status", content: "Plan: Patch parser" }]);

    const retry = parseGrokJsonLine(JSON.stringify({
      method: "session/update",
      params: {
        sessionId: "grok-pty-session",
        update: {
          sessionUpdate: "retry_state",
          attempt: 2,
          max_retries: 15,
          reason: "temporary upstream failure",
        },
      },
    }));
    expect(retry?.deltas).toEqual([{ type: "status", content: "Grok retrying (2/15): temporary upstream failure" }]);
  });

  it("parses Grok end events as terminal with session id", () => {
    const parsed = parseGrokJsonLine(JSON.stringify({
      type: "end",
      stopReason: "EndTurn",
      sessionId: "grok-live-session",
    }));
    expect(parsed?.terminal).toBe(true);
    expect(parsed?.sessionId).toBe("grok-live-session");
  });

  it("parses terminal result lines", () => {
    const parsed = parseGrokJsonLine(JSON.stringify({ type: "result", result: "final answer", done: true }));
    expect(parsed?.terminal).toBe(true);
    expect(parsed?.doneText).toBe("final answer");
  });

  it("maps tool and error events to stream deltas", () => {
    expect(parseGrokJsonLine(JSON.stringify({ type: "tool_start", toolName: "shell", id: "t1" }))?.deltas)
      .toEqual([{ type: "tool_use", content: "Using shell", toolName: "shell", toolId: "t1" }]);

    expect(parseGrokJsonLine(JSON.stringify({ type: "error", message: "bad auth" }))?.deltas)
      .toEqual([{ type: "error", content: "bad auth" }]);
  });

  it("drops nested reasoning wrappers from Grok content blocks", () => {
    const parsed = parseGrokJsonLine(JSON.stringify({
      type: "message",
      content: [
        { type: "content", content: { type: "thinking", text: "private nested reasoning" } },
        { type: "content", content: { type: "text", text: "visible answer" } },
      ],
    }));

    expect(parsed?.deltas).toEqual([{ type: "text_snapshot", content: "visible answer" }]);
    expect(parsed?.deltas.some((d) => String(d.content).includes("private nested reasoning"))).toBe(false);
  });
});

describe("grokVisibleDeltas (live streaming + dedup contract)", () => {
  it("streams answer text live from stdout, but drops the transcript's duplicate copy", () => {
    const text: StreamDelta[] = [{ type: "text", content: "Hello Michael" }];
    const snapshot: StreamDelta[] = [{ type: "text_snapshot", content: "Hello Michael" }];
    // stdout = the live answer the user should see type out.
    expect(grokVisibleDeltas(text, "stdout")).toEqual([{ type: "text", content: "Hello Michael" }]);
    expect(grokVisibleDeltas(snapshot, "stdout")).toEqual([{ type: "text_snapshot", content: "Hello Michael" }]);
    // transcript = the same answer again (agent_message_chunk) — dropped so it is
    // not rendered twice; resultText is accumulated from stdout only.
    expect(grokVisibleDeltas(text, "transcript")).toEqual([]);
    expect(grokVisibleDeltas(snapshot, "transcript")).toEqual([]);
  });

  it("streams tool lifecycle + context live, on the transcript stream", () => {
    const deltas: StreamDelta[] = [
      { type: "tool_use", content: "Using read_file", toolName: "read_file" },
      { type: "tool_result", content: "ok", toolName: "read_file" },
      { type: "context", content: "1234" },
      { type: "text", content: "leaked answer" },
    ];
    expect(grokVisibleDeltas(deltas, "transcript")).toEqual([
      { type: "tool_use", content: "Using read_file", toolName: "read_file" },
      { type: "tool_result", content: "ok", toolName: "read_file" },
      { type: "context", content: "1234" },
    ]);
  });

  it("emits the answer once on stdout while resultText is accumulated identically", () => {
    // Simulate the headless stdout sequence: text chunks build the answer, the
    // transcript carries the same answer (agent_message_chunk) plus tool lifecycle.
    const stdoutLines = [
      parseGrokJsonLine(JSON.stringify({ type: "text", data: "Hello " }))!,
      parseGrokJsonLine(JSON.stringify({ type: "text", data: "Michael" }))!,
      parseGrokJsonLine(JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "s1" }))!,
    ];
    const transcriptLines = [
      parseGrokJsonLine(JSON.stringify({
        method: "session/update",
        params: { sessionId: "s1", update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "write" } },
      }))!,
      parseGrokJsonLine(JSON.stringify({
        method: "session/update",
        params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello Michael" } } },
      }))!,
    ];

    let resultText = "";
    const stdoutVisible: StreamDelta[] = [];
    const transcriptVisible: StreamDelta[] = [];
    for (const parsed of stdoutLines) {
      for (const d of parsed.deltas) {
        if (d.type === "text") resultText += d.content;
        if (d.type === "text_snapshot") resultText = d.content;
      }
      stdoutVisible.push(...grokVisibleDeltas(parsed.deltas, "stdout"));
    }
    for (const parsed of transcriptLines) transcriptVisible.push(...grokVisibleDeltas(parsed.deltas, "transcript"));

    // resultText finalized correctly (canonical result, identical to streamed text)...
    expect(resultText).toBe("Hello Michael");
    // ...the answer streams live from stdout (so the user sees it type out)...
    const streamedText = stdoutVisible.filter((d) => d.type === "text" || d.type === "text_snapshot").map((d) => d.content).join("");
    expect(streamedText).toBe("Hello Michael");
    // ...the transcript's duplicate copy is NOT re-emitted (only the tool card is)...
    expect(transcriptVisible.some((d) => d.type === "text" || d.type === "text_snapshot")).toBe(false);
    expect(transcriptVisible.filter((d) => d.type === "tool_use")).toHaveLength(1);
    // ...and no reasoning placeholder leaks anywhere.
    expect([...stdoutVisible, ...transcriptVisible].some((d) => d.type === "status")).toBe(false);
  });
});

describe("GrokEngine run", () => {
  it("streams answer text live AND accumulates the identical canonical result", async () => {
    const { result, deltas, call } = await runWith([
      JSON.stringify({ session_id: "grok-session-1" }),
      JSON.stringify({ type: "content_delta", delta: "hel" }),
      JSON.stringify({ type: "content_delta", delta: "lo" }),
      JSON.stringify({ type: "result", result: "hello", done: true }),
    ]);

    expect(path.basename(call.bin)).toBe("grok");
    expect(call.args).not.toContain("--session-id");
    // Answer text streams live (the user sees it type out) from the stdout deltas...
    expect(deltas.filter((d) => d.type === "text").map((d) => d.content).join("")).toBe("hello");
    // ...and the canonical result is identical, so the FE reconciles by identity at
    // completion (no duplicate bubble). Reasoning never leaks as a status line.
    expect(deltas.some((d) => d.type === "status")).toBe(false);
    expect(result).toMatchObject({ sessionId: "grok-session-1", result: "hello", numTurns: 1 });
    expect(result.error).toBeUndefined();
  });

  it("settles on the terminal end event even if the process never closes", async () => {
    // Regression: a `bash`/shell tool call can leave a grandchild that inherits the
    // child's stdout pipe, so `proc.on('close')` never fires even after grok exits.
    // The turn must still settle from grok's stdout `end` marker — never hang.
    const deltas: StreamDelta[] = [];
    const engine = new GrokEngine();
    const promise = engine.run({
      prompt: "hatch an employee",
      cwd: "/tmp",
      sessionId: "cuttlefish-session-hang",
      model: "grok-build",
      onStream: (d: StreamDelta) => deltas.push(d),
    } as any);

    await flush();
    const call = spawnCalls[spawnCalls.length - 1];
    expect(call).toBeDefined();
    // Stream session id + answer text, then the terminal end event. Crucially we
    // NEVER call call.proc.close(...) — the pipe is "held open" by a grandchild.
    call.proc.emitStdout([
      JSON.stringify({ session_id: "grok-hang-session" }),
      JSON.stringify({ type: "text", data: "Done — React Reviewer is ready." }),
      JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "grok-hang-session" }),
      "",
    ].join("\n"));

    // Resolves promptly from the terminal event (no close). A 1s race guard proves
    // we don't depend on `close` (which would hang here).
    const raced = await Promise.race([
      promise,
      sleep(1000).then(() => "TIMED_OUT" as const),
    ]);
    expect(raced).not.toBe("TIMED_OUT");
    const result = raced as EngineResult;
    expect(result).toMatchObject({ sessionId: "grok-hang-session", result: "Done — React Reviewer is ready.", numTurns: 1 });
    expect(result.error).toBeUndefined();
    expect(engine.isAlive("cuttlefish-session-hang")).toBe(false);
  });

  it("settles from the exit backstop when no end marker arrives and close never fires", async () => {
    // Deterministic-settle backstop: grok exits (process gone) but a grandchild
    // holds the stdout pipe open, so `close` never fires — AND no parseable `end`
    // marker arrived (crash/kill). Without the `exit`-grace backstop the turn would
    // hang in "running" forever (the empty/stuck outcome). It must settle with the
    // text accumulated so far and free the session.
    const deltas: StreamDelta[] = [];
    const engine = new GrokEngine();
    const promise = engine.run({
      prompt: "do a tool-heavy thing",
      cwd: "/tmp",
      sessionId: "cuttlefish-session-exit-backstop",
      model: "grok-build",
      onStream: (d: StreamDelta) => deltas.push(d),
    } as any);

    await flush();
    const call = spawnCalls[spawnCalls.length - 1];
    expect(call).toBeDefined();
    // Answer text streams, but NO `end` event and NO close() — only `exit` fires.
    call.proc.emitStdout([
      JSON.stringify({ session_id: "grok-exit-session" }),
      JSON.stringify({ type: "text", data: "Partial answer before exit." }),
      "",
    ].join("\n"));
    call.proc.exitCode = 0;
    call.proc._handlers["exit"]?.(0);

    const raced = await Promise.race([
      promise,
      sleep(3000).then(() => "TIMED_OUT" as const),
    ]);
    expect(raced).not.toBe("TIMED_OUT");
    const result = raced as EngineResult;
    expect(result).toMatchObject({ sessionId: "grok-exit-session", result: "Partial answer before exit." });
    expect(result.error).toBeUndefined();
    expect(engine.isAlive("cuttlefish-session-exit-backstop")).toBe(false);
  });

  it("uses resumeSessionId when present", async () => {
    const { call, result } = await runWith([
      JSON.stringify({ type: "result", result: "resumed", done: true }),
    ], { resumeSessionId: "existing-grok-session" });

    expect(call.args[call.args.indexOf("--resume") + 1]).toBe("existing-grok-session");
    expect(result.sessionId).toBe("existing-grok-session");
  });

  it("mirrors headless tool deltas from Grok's transcript", async () => {
    const deltas: StreamDelta[] = [];
    const engine = new GrokEngine();
    const promise = engine.run({
      prompt: "read a file",
      cwd: "/tmp",
      sessionId: "cuttlefish-session-tool",
      model: "grok-build",
      onStream: (d: StreamDelta) => deltas.push(d),
    } as any);

    await flush();
    const call = spawnCalls[spawnCalls.length - 1];
    expect(call).toBeDefined();
    call.proc.emitStdout(JSON.stringify({ session_id: "tool-session" }) + "\n");

    const file = path.join(osMockState.home, ".grok", "sessions", "tool-session", "updates.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{}\n");
    await sleep(350);
    fs.appendFileSync(file, [
      JSON.stringify({
        method: "session/update",
        params: {
          sessionId: "tool-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-1",
            title: "read_file",
            rawInput: { target_file: "AGENTS.md" },
          },
        },
      }),
      JSON.stringify({
        method: "session/update",
        params: {
          sessionId: "tool-session",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-1",
            status: "completed",
            title: "read_file",
            content: [{ type: "content", content: { type: "text", text: "ok" } }],
          },
        },
      }),
      "",
    ].join("\n"));
    await waitFor(() => deltas.some((delta) => delta.type === "tool_result" && delta.toolId === "tool-1"), "Grok transcript tool result");

    call.proc.emitStdout([
      JSON.stringify({ type: "text", data: "done" }),
      JSON.stringify({ type: "result", result: "done", done: true }),
      "",
    ].join("\n"));
    call.proc.close(0);

    const result = await promise;
    expect(result.result).toBe("done");
    expect(deltas).toContainEqual({
      type: "tool_use",
      content: "Using read_file",
      toolName: "read_file",
      toolId: "tool-1",
      input: "{\"target_file\":\"AGENTS.md\"}",
    });
    expect(deltas).toContainEqual({
      type: "tool_result",
      content: "ok",
      toolName: "read_file",
      toolId: "tool-1",
    });
  });

  it("ignores changed transcript files that belong to another Grok session", async () => {
    const deltas: StreamDelta[] = [];
    const engine = new GrokEngine();
    const promise = engine.run({
      prompt: "read the right file",
      cwd: "/tmp",
      sessionId: "cuttlefish-session-filter",
      model: "grok-build",
      onStream: (d: StreamDelta) => deltas.push(d),
    } as any);

    await flush();
    const call = spawnCalls[spawnCalls.length - 1];
    expect(call).toBeDefined();
    call.proc.emitStdout(JSON.stringify({ session_id: "right-session" }) + "\n");

    const wrongFile = path.join(osMockState.home, ".grok", "sessions", "wrong-session", "updates.jsonl");
    fs.mkdirSync(path.dirname(wrongFile), { recursive: true });
    fs.writeFileSync(wrongFile, [
      JSON.stringify({ session_id: "wrong-session" }),
      JSON.stringify({
        method: "session/update",
        params: {
          sessionId: "wrong-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "wrong-tool",
            title: "read_file",
            rawInput: { target_file: "WRONG.md" },
          },
        },
      }),
      "",
    ].join("\n"));

    const rightFile = path.join(osMockState.home, ".grok", "sessions", "right-session", "updates.jsonl");
    fs.mkdirSync(path.dirname(rightFile), { recursive: true });
    fs.writeFileSync(rightFile, [
      JSON.stringify({ session_id: "right-session" }),
      JSON.stringify({
        method: "session/update",
        params: {
          sessionId: "right-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "right-tool",
            title: "read_file",
            rawInput: { target_file: "RIGHT.md" },
          },
        },
      }),
      "",
    ].join("\n"));

    await waitFor(() => deltas.some((delta) => delta.type === "tool_use" && delta.toolId === "right-tool"), "filtered Grok transcript tool call");
    call.proc.emitStdout([
      JSON.stringify({ type: "text", data: "done" }),
      JSON.stringify({ type: "result", result: "done", done: true }),
      "",
    ].join("\n"));
    call.proc.close(0);

    await promise;
    expect(deltas).toContainEqual({
      type: "tool_use",
      content: "Using read_file",
      toolName: "read_file",
      toolId: "right-tool",
      input: "{\"target_file\":\"RIGHT.md\"}",
    });
    expect(deltas).not.toContainEqual(expect.objectContaining({ toolId: "wrong-tool" }));
  });
});
