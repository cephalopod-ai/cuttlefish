import { EventEmitter } from "node:events";
import { mkdtemp, rm, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineRunOpts } from "../../shared/types.js";
import { runWithEngineEnvironment } from "../../shared/engine-env.js";
import { MuseEngine } from "../muse.js";

const io = vi.hoisted(() => ({ spawn: vi.fn(), exec: vi.fn(), stop: vi.fn() }));
vi.mock("../../shared/windows-exec.js", () => ({
  spawnCompat: io.spawn,
  execFileCompat: io.exec,
  killChildTree: io.stop,
}));

const nativeId = "0198f0aa-1111-7000-8000-0000000000aa";
const alternateId = "0198f0aa-1111-7000-8000-0000000000bb";

interface Request {
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

interface Fixture {
  account?: string;
  subscription?: boolean;
  version?: string;
  model?: string;
  cwd?: string;
  resumeFailure?: boolean;
  servers?: string[];
  terminal?: string;
  noFinal?: boolean;
  duplicateTerminal?: boolean;
  conflict?: boolean;
  malformed?: boolean;
  oversized?: boolean;
  holdTurn?: boolean;
  approval?: boolean;
  observedUsage?: boolean;
}

class Peer extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  requests: Request[] = [];
  pid = 12345;
  closed = false;
  private markTurnStarted!: () => void;
  turnStarted = new Promise<void>((resolve) => { this.markTurnStarted = resolve; });

  constructor(private cwd: string, private fixture: Fixture, private sid = nativeId) {
    super();
    createInterface({ input: this.stdin }).on("line", (line) => this.receive(JSON.parse(line) as Request));
    this.stdin.once("end", () => this.close());
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stdin.destroy();
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", 0);
    this.emit("close", 0);
  }

  private reply(req: Request, result: unknown): void {
    this.send({ id: req.id, result });
  }

  private send(message: object, splitUnicode = false): void {
    const data = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
    if (splitUnicode) {
      const split = data.indexOf(Buffer.from("🐙")) + 2;
      this.stdout.write(data.subarray(0, split));
      this.stdout.write(data.subarray(split));
    } else {
      this.stdout.write(data);
    }
  }

  private notify(method: string, params: object, splitUnicode = false): void {
    this.send({ method, params: { sessionId: this.sid, ...params } }, splitUnicode);
  }

  private receive(req: Request): void {
    this.requests.push(req);
    const params = req.params ?? {};
    switch (req.method) {
      case "initialize":
        this.reply(req, {
          serverInfo: { name: "muse", version: this.fixture.version ?? "1.4.25" }, schema: { version: 1 },
          experimentalApi: true, sandboxAvailability: "available", sessionDurability: "durable", museHome: this.cwd,
        });
        break;
      case "account/read":
        this.reply(req, { state: this.fixture.account ?? "accountLogin", credentialRequired: true });
        break;
      case "usage/refresh":
        this.reply(req, { subscriptionActive: this.fixture.subscription ?? true });
        break;
      case "mcpServer/list":
        this.reply(req, { servers: this.fixture.servers ?? [] });
        break;
      case "hook/list":
        this.reply(req, { hooks: [] });
        break;
      case "plugin/list":
        this.reply(req, { plugins: [] });
        break;
      case "mcpServer/readInventory":
        this.reply(req, { servers: [] });
        break;
      case "session/resume":
        if (this.fixture.resumeFailure) {
          this.send({ id: req.id, error: { code: -32011, message: "not found" } });
          break;
        }
        this.reply(req, { session: this.session(params.sessionId), pendingRequests: [] });
        break;
      case "session/start":
        this.reply(req, { session: this.session(this.sid) });
        break;
      case "turn/start":
        this.markTurnStarted();
        this.reply(req, {
          commandId: params.commandId, turnId: params.commandId, status: "accepted", startedNewTurn: true, disposition: "started",
        });
        if (this.fixture.holdTurn) break;
        this.emitTurn(params.commandId);
        break;
      case "approval/decide":
        this.reply(req, { approvalId: params.approvalId, commandId: params.commandId, status: "accepted", terminal: true });
        break;
    }
  }

  private session(id: unknown): object {
    return {
      sessionId: id, providerId: "meta", modelId: this.fixture.model ?? "muse-spark-1.3",
      workspaceRoot: this.fixture.cwd ?? this.cwd, status: "idle", activeTurnId: null, forkedFrom: null,
      approvalMode: { mode: "onRequest" },
      permissionState: {
        profileId: ":ask-me", reviewerAuthority: "human", reviewerAttached: true,
        axes: { network: "off", filesystem: "sandboxed", approval: "onRequest", reviewer: "human" },
      },
    };
  }

  private emitTurn(turnId: unknown): void {
    const item = { itemId: "answer", kind: "agentMessage", turnId, messagePhase: "finalAnswer" };
    this.notify("item/started", { item: { ...item, text: "" } });
    this.notify("item/delta", { itemId: "answer", field: "text", delta: "Hello 🐙" }, true);
    this.notify("item/completed", { item: { ...item, turnId: "nested", text: "wrong", status: "completed" } });
    this.notify("session/contextUsage", { usedTokens: 0 });
    if (this.fixture.approval) {
      this.notify("approval/requested", {
        turnId, approvalId: "approval", currentRequirementId: { approvalId: "approval", sourceIndex: 0 },
        availableChoices: [
          { choiceId: "grant", decision: "approved", scope: "once" },
          { choiceId: "denial-id-from-peer", decision: "denied", scope: "once" },
        ],
      });
    }
    if (this.fixture.malformed) { this.stdout.write("broken JSON\n"); return; }
    if (this.fixture.oversized) { this.stdout.write(Buffer.alloc(2 * 1024 * 1024 + 1, 65)); return; }
    if (!this.fixture.noFinal) {
      this.notify("item/completed", {
        item: { ...item, status: "completed", text: this.fixture.conflict ? "Changed" : "Hello 🐙!" },
      });
    }
    if (this.fixture.observedUsage) {
      const record = {
        turnId, sourceRange: { last: { id: "model-call-1" } }, usage: { inputTokens: 4, outputTokens: 0 },
      };
      this.notify("session/tokenUsage", record);
      this.notify("session/tokenUsage", record);
      this.notify("session/tokenUsage", {
        turnId, sourceRange: { last: { id: "model-call-2" } }, usage: { inputTokens: 7, outputTokens: 2 },
      });
    }
    const terminal = { turnId, terminal: this.fixture.terminal ?? "completed", durationMs: 20,
      usage: this.fixture.observedUsage ? undefined : { inputTokens: 9, outputTokens: 0, reasoningTokens: -1 } };
    this.notify("turn/completed", terminal);
    if (this.fixture.duplicateTerminal) this.notify("turn/completed", terminal);
  }
}

let cwd: string;
let fixture: Fixture;
let peers: Peer[];
let engine: MuseEngine;

beforeEach(async () => {
  cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "muse-contract-")));
  fixture = {};
  peers = [];
  engine = new MuseEngine();
  io.spawn.mockReset().mockImplementation(() => {
    const peer = new Peer(cwd, { ...fixture }, peers.length ? alternateId : nativeId);
    peers.push(peer);
    return peer;
  });
  io.exec.mockReset().mockImplementation((_bin, _args, _options, cb) => cb(null, '{"sources":[{"state":"absent"}]}'));
  io.stop.mockReset().mockImplementation((peer: Peer) => peer.close());
});

afterEach(async () => {
  engine.killAll();
  await rm(cwd, { recursive: true, force: true });
});

function run(options: Partial<EngineRunOpts> = {}) {
  return engine.run({ cwd, sessionId: "session", model: "muse-spark-1.3", prompt: "Run", ...options });
}
function methods(peer = peers[0]): string[] {
  return peer.requests.map((request) => request.method);
}

describe("Muse MSP engine", () => {
  it("binds the native session before admission, streams Unicode, and returns only the settled root result", async () => {
    const stream = vi.fn();
    const bind = vi.fn(() => expect(methods()).not.toContain("turn/start"));
    const result = await runWithEngineEnvironment(
      { META_API_KEY: "dummy", model_api_key: "dummy", MUSE_HOME: "elsewhere", CUTTLEFISH_SESSION_TOKEN: "dummy" },
      () => run({ bin: "/explicit/muse", systemPrompt: "Assigned employee", effortLevel: "minimal", onStream: stream, onNativeSessionReady: bind }),
    );
    expect(result).toMatchObject({
      sessionId: nativeId, result: "Hello 🐙!", transport: "msp", contextTokens: 0, durationMs: 20,
      tokenUsage: { inputTokens: 9, outputTokens: 0, reasoningTokens: undefined },
    });
    expect(result.error).toBeUndefined();
    expect(bind).toHaveBeenCalledWith(nativeId);
    expect(peers[0].closed).toBe(true);
    expect(stream.mock.calls.map(([event]) => event).filter((event) => event.type === "text").map((event) => event.content).join("")).toBe(result.result);
    expect(io.spawn.mock.calls[0][0]).toBe("/explicit/muse");
    const [, argv, { env }] = io.spawn.mock.calls[0];
    expect(argv).not.toContain("Assigned employee");
    for (const key of ["META_API_KEY", "model_api_key", "MUSE_HOME", "CUTTLEFISH_SESSION_TOKEN"]) {
      expect(env).not.toHaveProperty(key);
    }
    const request = peers[0].requests.find((event) => event.method === "turn/start");
    expect(request?.params).toMatchObject({ reasoningEffort: "minimal", input: [{ type: "text", text: expect.stringContaining("Assigned employee") }] });
  });

  it.each([
    [{ account: "apiKey" }, /API-key/],
    [{ account: "loggedOut" }, /signed out/],
    [{ subscription: false }, /no active subscription/],
    [{ version: "1.4.24" }, /1.4.25/],
    [{ model: "wrong" }, /requested Meta model/],
    [{ servers: ["inherited"] }, /inherited MCP/],
  ])("refuses %j before sending a prompt", async (options, error) => {
    fixture = options;
    expect((await run()).error).toMatch(error);
    expect(methods()).not.toContain("turn/start");
  });

  it("refuses unsafe inherited configuration before session construction", async () => {
    await writeFile(path.join(cwd, "settings.json"), JSON.stringify({ hooks: { SessionStart: ["fixture"] } }));
    expect((await run()).error).toMatch(/user hooks/);
    expect(methods()).not.toContain("session/start");
  });

  it.each<Partial<EngineRunOpts>>([
    { restrictToJudgeOnly: true }, { requiresMcp: true }, { attachments: ["unavailable"] }, { cliFlags: ["--yolo"] },
  ])("fails closed before launching for %j", async (options) => {
    expect((await run(options)).error).toBeDefined();
    expect(io.spawn).not.toHaveBeenCalled();
  });

  it("does not silently replace a missing native session", async () => {
    fixture.resumeFailure = true;
    expect(await run({ resumeSessionId: nativeId })).toMatchObject({ sessionId: nativeId, error: expect.stringContaining("exact native session") });
    expect(methods()).not.toContain("session/start");
    expect(methods()).not.toContain("turn/start");
  });

  it("resumes an exact native ID and sends the updated employee instructions", async () => {
    expect((await run({ resumeSessionId: nativeId, systemPrompt: "Updated employee" })).result).toBe("Hello 🐙!");
    expect(peers[0].requests.find((req) => req.method === "session/resume")?.params)
      .toMatchObject({ sessionId: nativeId, autoRecover: false, workspaceRoot: cwd });
    expect(peers[0].requests.find((req) => req.method === "turn/start")?.params)
      .toMatchObject({ input: [{ type: "text", text: expect.stringContaining("Updated employee") }] });
  });

  it("uses the advertised one-time rejection choice", async () => {
    fixture.approval = true;
    expect((await run()).error).toBeUndefined();
    expect(peers[0].requests.find((req) => req.method === "approval/decide")?.params)
      .toMatchObject({ approvalId: "approval", choiceId: "denial-id-from-peer" });
  });

  it("deduplicates reported model-call usage when a terminal total is absent", async () => {
    fixture.observedUsage = true;
    expect((await run()).tokenUsage).toEqual({ inputTokens: 11, outputTokens: 2, source: "observed_model_calls" });
  });

  it.each([
    [{ terminal: "failed" }, /failed/],
    [{ terminal: "cancelled" }, /cancelled/],
    [{ noFinal: true }, /without a complete final/],
    [{ duplicateTerminal: true }, /duplicate terminal/],
    [{ conflict: true }, /conflicts with streamed/],
    [{ malformed: true }, /invalid JSON-RPC/],
    [{ oversized: true }, /oversized JSON-RPC/],
  ])("preserves partial output on %j", async (options, error) => {
    fixture = options;
    const result = await run();
    expect(result.result).toContain("Hello 🐙");
    expect(result.error).toMatch(error);
  });

  it("cancels a held turn, fences concurrent IDs, and permits an independent session", async () => {
    fixture.holdTurn = true;
    const first = run({ resumeSessionId: nativeId });
    await vi.waitFor(() => expect(peers).toHaveLength(1));
    await peers[0].turnStarted;
    expect(engine.isAlive("session")).toBe(true);
    expect((await run()).error).toMatch(/already has a turn/);
    expect((await run({ sessionId: "other", resumeSessionId: nativeId })).error).toMatch(/already has a turn/);
    fixture.holdTurn = false;
    expect((await run({ sessionId: "other" })).sessionId).toBe(alternateId);
    engine.kill("session", "operator cancelled");
    expect(await first).toMatchObject({ error: "operator cancelled", sessionId: nativeId });
    expect(engine.isAlive("session")).toBe(false);
    expect(peers[0].closed).toBe(true);
  });
});
