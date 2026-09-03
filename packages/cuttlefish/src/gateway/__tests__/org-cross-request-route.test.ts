import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import type { Engine } from "../../shared/types.js";

const hoisted = vi.hoisted(() => ({
  dispatchEmployeeSessionRun: vi.fn(async () => {}),
}));

vi.mock("../mid-pair-orchestrator.js", () => ({
  dispatchEmployeeSessionRun: hoisted.dispatchEmployeeSessionRun,
}));

const testHome = withTempCuttlefishHome("cuttlefish-cross-request-");

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number) {
      status = s;
      return this;
    },
    end(buf?: Buffer | string) {
      if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get body() {
      const raw = Buffer.concat(chunks).toString("utf-8");
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    },
  };
}

function makeJsonReq(method: string, urlPath: string, body: unknown) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as any;
  Object.assign(req, {
    method,
    url: urlPath,
    headers: {
      host: "localhost",
      "content-type": "application/json",
    },
  });
  return req;
}

function writeEmployee(department: string, name: string, yaml: string): void {
  const dir = path.join(testHome.home(), "org", department);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.yaml`), yaml.trimStart());
}

function makeCtx() {
  const engine: Engine = {
    name: "claude",
    run: async () => ({ result: "ok", sessionId: "engine-session" }),
  };
  return {
    getConfig: () => ({
      gateway: {},
      engines: { default: "claude", claude: { model: "sonnet" } },
      portal: { portalName: "Cuttlefish" },
    }),
    connectors: new Map(),
    startTime: Date.now(),
    emit: vi.fn(),
    sessionManager: {
      getEngine: () => engine,
      getEngines: () => new Map([["claude", engine]]),
      getQueue: () => ({
        enqueue: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()),
        getPendingCount: () => 0,
        getTransportState: (_key: string, status: string) => status,
        clearQueue: vi.fn(),
      }),
    },
  } as any;
}

function configureDeduplicatingDestination(ctx: any, id: string, agentCardUrl: string): void {
  const baseConfig = ctx.getConfig();
  ctx.getConfig = () => ({
    ...baseConfig,
    a2a: {
      destinations: [{
        id,
        agentCardUrl,
        token: "0123456789abcdef",
        allowedSkills: ["research"],
        messageIdDeduplication: "guaranteed",
        services: [],
      }],
    },
  });
}

async function setup() {
  vi.resetModules();
  const api = await import("../api.js");
  const externalA2A = await import("../external-a2a-cross-request.js");
  const reg = await import("../../sessions/registry.js");
  const lifecycle = await import("../session-lifecycle-service.js");
  const runLedger = await import("../../run-ledger/index.js");
  const runRecovery = await import("../../shared/run-recovery.js");
  reg.initDb();
  return { api, externalA2A, reg, lifecycle, runLedger, runRecovery };
}

beforeEach(() => {
  hoisted.dispatchEmployeeSessionRun.mockClear();
  writeEmployee("content", "content-writer", `
name: content-writer
displayName: Content Writer
department: content
rank: employee
engine: claude
model: sonnet
persona: Write content.
`);
  writeEmployee("platform", "platform-dev", `
name: platform-dev
displayName: Platform Dev
department: platform
rank: senior
engine: claude
model: opus
persona: Review frontend and backend code.
provides:
  - name: code-review
    description: Review PRs and provide feedback
`);
  writeEmployee("personnel", "hr-manager", `
name: hr-manager
displayName: HR Manager
department: personnel
rank: manager
engine: claude
model: sonnet
persona: Advise the human operator.
provides:
  - name: org-advice
    description: Human-only organization advice
`);
});

describe("POST /api/org/cross-request", () => {
  it("includes configured external A2A services in normal service discovery", async () => {
    const { api } = await setup();
    const cap = makeRes();
    const ctx = makeCtx();
    const baseConfig = ctx.getConfig();
    ctx.getConfig = () => ({
      ...baseConfig,
      a2a: {
        destinations: [{
          id: "independent-peer",
          agentCardUrl: "https://peer.example/.well-known/agent-card.json",
          token: "0123456789abcdef",
          allowedSkills: ["research"],
          services: [{ name: "external-research", description: "Research via an A2A peer", skillId: "research" }],
        }],
      },
    });

    await api.handleApiRequest(makeJsonReq("GET", "/api/org/services", {}), cap.res, ctx);

    expect(cap.status).toBe(200);
    expect(cap.body.services).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "code-review", provider: expect.objectContaining({ name: "platform-dev" }) }),
      expect.objectContaining({ name: "external-research", provider: expect.objectContaining({ name: "a2a:independent-peer" }) }),
    ]));
  });

  it("creates and dispatches a provider session for a discovered service", async () => {
    const { api, reg } = await setup();
    const ctx = makeCtx();
    const cap = makeRes();

    await api.handleApiRequest(makeJsonReq("POST", "/api/org/cross-request", {
      fromEmployee: "content-writer",
      service: "code-review",
      prompt: "Review the new blog template component",
    }), cap.res, ctx);

    expect(cap.status).toBe(201);
    expect(cap.body).toMatchObject({
      provider: {
        name: "platform-dev",
        displayName: "Platform Dev",
        department: "platform",
      },
      service: "code-review",
    });
    expect(cap.body.route).toContain("content-writer");
    expect(cap.body.route).toContain("platform-dev");

    const session = reg.getSession(cap.body.sessionId);
    expect(session).toMatchObject({
      employee: "platform-dev",
      engine: "claude",
      model: "opus",
      title: "Cross request: code-review",
    });
    const messages = reg.getMessages(cap.body.sessionId);
    expect(messages[0].content).toContain("## Cross-service request");
    expect(messages[0].content).toContain("**From**: Content Writer (content)");
    expect(messages[0].content).toContain("Review the new blog template component");
    expect(hoisted.dispatchEmployeeSessionRun).toHaveBeenCalledTimes(1);
  });

  it("returns an actionable no-provider response when the requested service is not provided", async () => {
    const { api } = await setup();
    const cap = makeRes();

    await api.handleApiRequest(makeJsonReq("POST", "/api/org/cross-request", {
      fromEmployee: "content-writer",
      service: "does-not-exist",
      prompt: "Need help",
    }), cap.res, makeCtx());

    expect(cap.status).toBe(422);
    expect(cap.body).toMatchObject({
      code: "no_service_provider",
      requestedService: "does-not-exist",
      availableServices: [{ name: "code-review", provider: { name: "platform-dev" } }],
    });
    expect(hoisted.dispatchEmployeeSessionRun).not.toHaveBeenCalled();
  });

  it("does not expose the human-only HR role as a cross-service provider", async () => {
    const { api, reg } = await setup();
    const cap = makeRes();

    await api.handleApiRequest(makeJsonReq("POST", "/api/org/cross-request", {
      fromEmployee: "content-writer",
      service: "org-advice",
      prompt: "Assess this manager request",
    }), cap.res, makeCtx());

    expect(cap.status).toBe(422);
    expect(cap.body).toMatchObject({
      code: "no_service_provider",
      requestedService: "org-advice",
      availableServices: [{ name: "code-review", provider: { name: "platform-dev" } }],
    });
    expect(reg.listSessions()).toHaveLength(0);
    expect(hoisted.dispatchEmployeeSessionRun).not.toHaveBeenCalled();
  });

  it("routes a simulated Gosling A2A-backed delegate through the same cross-request surface", async () => {
    const { api, reg } = await setup();
    const cap = makeRes();
    const ctx = makeCtx();
    const baseConfig = ctx.getConfig();
    ctx.getConfig = () => ({
      ...baseConfig,
      a2a: {
        destinations: [{
          id: "gosling-delegate",
          agentCardUrl: "https://peer.example/.well-known/agent-card.json",
          token: "0123456789abcdef",
          allowedSkills: ["research"],
          services: [{ name: "external-research", description: "Research via an A2A peer", skillId: "research" }],
        }],
      },
    });
    ctx.a2aOutbound = {
      send: vi.fn(async () => ({
        id: "remote-task-1",
        contextId: "remote-context-1",
        status: {
          state: 3,
          message: {
            messageId: "remote-message-1",
            taskId: "remote-task-1",
            contextId: "remote-context-1",
            role: 2,
            parts: [{ content: { $case: "text", value: "Remote research completed" }, filename: "", mediaType: "text/plain" }],
            metadata: {},
            extensions: [],
            referenceTaskIds: [],
          },
          timestamp: new Date().toISOString(),
        },
        artifacts: [],
        history: [],
        metadata: {},
      })),
      waitForTask: vi.fn(),
    };

    await api.handleApiRequest(makeJsonReq("POST", "/api/org/cross-request", {
      fromEmployee: "content-writer",
      service: "external-research",
      prompt: "Research this protocol",
    }), cap.res, ctx);

    expect(cap.status).toBe(201);
    expect(cap.body).toMatchObject({
      provider: { name: "a2a:gosling-delegate", department: "external" },
      service: "external-research",
      route: ["content-writer", "a2a:gosling-delegate"],
    });
    await vi.waitFor(() => expect(ctx.a2aOutbound.send).toHaveBeenCalledWith(expect.objectContaining({
      destinationId: "gosling-delegate",
      skillId: "research",
      messageId: expect.any(String),
    })));
    await vi.waitFor(() => expect(reg.getSession(cap.body.sessionId)).toMatchObject({
      engine: "a2a",
      status: "idle",
    }));
    expect(reg.getMessages(cap.body.sessionId).at(-1)?.content).toContain("Remote research completed");
    expect(reg.getSession(cap.body.sessionId)?.transportMeta?.a2aOutbound).toMatchObject({
      requestMessageId: ctx.a2aOutbound.send.mock.calls[0]![0].messageId,
      requestMessage: expect.stringContaining("Research this protocol"),
    });
    expect(hoisted.dispatchEmployeeSessionRun).not.toHaveBeenCalled();
  });

  it("does not replay an unknown send outcome without an explicit peer guarantee", async () => {
    const { api, externalA2A, reg } = await setup();
    const cap = makeRes();
    const ctx = makeCtx();
    const baseConfig = ctx.getConfig();
    ctx.getConfig = () => ({
      ...baseConfig,
      a2a: {
        destinations: [{
          id: "non-idempotent-peer",
          agentCardUrl: "https://peer.example/.well-known/agent-card.json",
          token: "0123456789abcdef",
          allowedSkills: ["research"],
          services: [{ name: "external-research", description: "Research via an A2A peer", skillId: "research" }],
        }],
      },
    });
    const send = vi.fn(async (_input: unknown) => {
      throw new Error("connection closed before response");
    });
    ctx.a2aOutbound = { send, waitForTask: vi.fn() };

    await api.handleApiRequest(makeJsonReq("POST", "/api/org/cross-request", {
      fromEmployee: "content-writer",
      service: "external-research",
      prompt: "Do not replay an ambiguous request",
    }), cap.res, ctx);

    await vi.waitFor(() => expect(reg.getSession(cap.body.sessionId)).toMatchObject({
      status: "error",
      lastError: expect.stringContaining("outcome is unknown and was not replayed"),
      transportMeta: { a2aOutbound: { dispatchOutcome: "unknown-not-replayed" } },
    }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(externalA2A.recoverableExternalA2ACrossRequestSessionIds().has(cap.body.sessionId)).toBe(false);
  });

  it("reconciles an opted-in peer with one stable message ID and bounded retries", async () => {
    const { api, reg } = await setup();
    const cap = makeRes();
    const ctx = makeCtx();
    const baseConfig = ctx.getConfig();
    ctx.getConfig = () => ({
      ...baseConfig,
      a2a: {
        destinations: [{
          id: "deduplicating-peer",
          agentCardUrl: "https://peer.example/.well-known/agent-card.json",
          token: "0123456789abcdef",
          allowedSkills: ["research"],
          messageIdDeduplication: "guaranteed",
          services: [{ name: "external-research", description: "Research via an A2A peer", skillId: "research" }],
        }],
      },
    });
    const completed = {
      id: "remote-deduplicated-task",
      contextId: "remote-deduplicated-context",
      status: { state: 3, message: undefined, timestamp: new Date().toISOString() },
      artifacts: [],
      history: [],
      metadata: {},
    };
    let attempts = 0;
    const send = vi.fn(async (_input: { messageId: string }) => {
      attempts += 1;
      if (attempts <= 2) throw new Error(`ambiguous attempt ${attempts}`);
      return completed;
    });
    ctx.a2aOutbound = { send, waitForTask: vi.fn() };

    await api.handleApiRequest(makeJsonReq("POST", "/api/org/cross-request", {
      fromEmployee: "content-writer",
      service: "external-research",
      prompt: "Reconcile under an explicit guarantee",
    }), cap.res, ctx);

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(reg.getSession(cap.body.sessionId)).toMatchObject({
      status: "waiting",
      lastError: expect.stringContaining("reconciliation pending"),
      transportMeta: {
        a2aOutbound: {
          messageIdDeduplication: "guaranteed",
          destinationAgentCardUrl: "https://peer.example/.well-known/agent-card.json",
          reconciliationAttempts: 1,
          reconciliationPendingAt: expect.any(String),
        },
      },
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3), { timeout: 2_500 });
    await vi.waitFor(() => expect(reg.getSession(cap.body.sessionId)).toMatchObject({
      status: "idle",
      lastError: null,
      transportMeta: { a2aOutbound: { reconciliationAttempts: 0 } },
    }));
    expect(new Set(send.mock.calls.map(([input]) => input.messageId)).size).toBe(1);
  });

  it("projects remote progress and registers outbound artifacts in lineage", async () => {
    const { api, reg, runLedger } = await setup();
    const cap = makeRes();
    const ctx = makeCtx();
    const baseConfig = ctx.getConfig();
    ctx.getConfig = () => ({
      ...baseConfig,
      a2a: {
        destinations: [{
          id: "progress-peer",
          agentCardUrl: "https://peer.example/.well-known/agent-card.json",
          token: "0123456789abcdef",
          allowedSkills: ["research"],
          services: [{ name: "external-research", description: "Research via an A2A peer", skillId: "research" }],
        }],
      },
    });
    const task = (state: number, text: string, artifacts: unknown[] = []) => ({
      id: "remote-progress-task",
      contextId: "remote-progress-context",
      status: {
        state,
        message: {
          messageId: `remote-progress-${state}`,
          taskId: "remote-progress-task",
          contextId: "remote-progress-context",
          role: 2,
          parts: [{ content: { $case: "text", value: text }, filename: "", mediaType: "text/plain" }],
          metadata: {},
          extensions: [],
          referenceTaskIds: [],
        },
        timestamp: new Date().toISOString(),
      },
      artifacts,
      history: [],
      metadata: {},
    });
    ctx.a2aOutbound = {
      send: vi.fn(async () => task(2, "Remote work started")),
      waitForTask: vi.fn(async (_destinationId: string, _taskId: string, options: { onUpdate: (value: any) => Promise<void> }) => {
        const completed = task(3, "Remote work completed", [{
          artifactId: "report-1",
          name: "research-report.txt",
          description: "Remote report",
          parts: [{ content: { $case: "text", value: "Report body" }, filename: "research-report.txt", mediaType: "text/plain" }],
          metadata: {},
          extensions: [],
        }]);
        await options.onUpdate(completed);
        return completed;
      }),
    };

    await api.handleApiRequest(makeJsonReq("POST", "/api/org/cross-request", {
      fromEmployee: "content-writer",
      service: "external-research",
      prompt: "Research progress and artifacts",
    }), cap.res, ctx);

    await vi.waitFor(() => expect(reg.getSession(cap.body.sessionId)).toMatchObject({
      status: "idle",
      transportMeta: { a2aOutbound: { state: "TASK_STATE_COMPLETED", artifactCount: 1 } },
    }));
    expect(reg.getMessages(cap.body.sessionId).map((entry) => entry.content).join("\n")).toContain("Remote work started");
    const session = reg.getSession(cap.body.sessionId)!;
    const activeRunId = session.transportMeta?.activeRunId as string;
    const artifacts = reg.listArtifacts({ producingRunId: activeRunId });
    expect(artifacts).toEqual([expect.objectContaining({
      filename: "research-report.txt",
      artifactKind: "generated",
      path: null,
      tags: expect.arrayContaining(["a2a-output", "metadata-only"]),
    })]);
    expect(runLedger.getRunLedger().getRun(activeRunId)).toMatchObject({
      sessionId: cap.body.sessionId,
      engine: "a2a",
      currentState: "completed",
    });
  });

  it("propagates a local stop and lets remote completion win the cancellation race", async () => {
    const { api, reg, lifecycle, runLedger } = await setup();
    const cap = makeRes();
    const ctx = makeCtx();
    const baseConfig = ctx.getConfig();
    ctx.getConfig = () => ({
      ...baseConfig,
      a2a: {
        destinations: [{
          id: "race-peer",
          agentCardUrl: "https://peer.example/.well-known/agent-card.json",
          token: "0123456789abcdef",
          allowedSkills: ["research"],
          services: [{ name: "external-research", description: "Research via an A2A peer", skillId: "research" }],
        }],
      },
    });
    const working = {
      id: "remote-race-task",
      contextId: "remote-race-context",
      status: { state: 2, message: undefined, timestamp: new Date().toISOString() },
      artifacts: [],
      history: [],
      metadata: {},
    };
    const completed = {
      ...working,
      status: {
        state: 3,
        message: {
          messageId: "remote-race-completed",
          taskId: working.id,
          contextId: working.contextId,
          role: 2,
          parts: [{ content: { $case: "text", value: "Remote completion won the race" }, filename: "", mediaType: "text/plain" }],
          metadata: {},
          extensions: [],
          referenceTaskIds: [],
        },
        timestamp: new Date().toISOString(),
      },
    };
    ctx.a2aOutbound = {
      send: vi.fn(async () => working),
      waitForTask: vi.fn(async (_destinationId: string, _taskId: string, options: { signal: AbortSignal }) => new Promise((_, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      })),
      cancelTask: vi.fn(async () => completed),
    };

    await api.handleApiRequest(makeJsonReq("POST", "/api/org/cross-request", {
      fromEmployee: "content-writer",
      service: "external-research",
      prompt: "Exercise cancellation race",
    }), cap.res, ctx);
    await vi.waitFor(() => expect(reg.getSession(cap.body.sessionId)?.transportMeta?.a2aOutbound).toMatchObject({
      taskId: "remote-race-task",
      state: "TASK_STATE_WORKING",
    }));

    const stopped = lifecycle.stopSession(cap.body.sessionId, ctx);

    expect(stopped).toMatchObject({ statusCode: 200, body: { externalInterruptible: true } });
    await vi.waitFor(() => expect(ctx.a2aOutbound.cancelTask).toHaveBeenCalledWith("race-peer", "remote-race-task"));
    await vi.waitFor(() => expect(reg.getSession(cap.body.sessionId)).toMatchObject({ status: "idle", lastError: null }));
    expect(reg.getMessages(cap.body.sessionId).at(-1)?.content).toContain("Remote completion won the race");
    const activeRunId = reg.getSession(cap.body.sessionId)?.transportMeta?.activeRunId as string;
    expect(runLedger.getRunLedger().getRun(activeRunId)?.currentState).toBe("completed");
  });

  it("does not cancel a terminal task when stop arrives during raw artifact persistence", async () => {
    const { api, reg, lifecycle } = await setup();
    const cap = makeRes();
    const ctx = makeCtx();
    const baseConfig = ctx.getConfig();
    ctx.getConfig = () => ({
      ...baseConfig,
      a2a: {
        destinations: [{
          id: "terminal-race-peer",
          agentCardUrl: "https://peer.example/.well-known/agent-card.json",
          token: "0123456789abcdef",
          allowedSkills: ["research"],
          services: [{ name: "external-research", description: "Research via an A2A peer", skillId: "research" }],
        }],
      },
    });
    const completed = {
      id: "remote-terminal-race-task",
      contextId: "remote-terminal-race-context",
      status: {
        state: 3,
        message: {
          messageId: "remote-terminal-race-completed",
          taskId: "remote-terminal-race-task",
          contextId: "remote-terminal-race-context",
          role: 2,
          parts: [{ content: { $case: "text", value: "Remote task already completed" }, filename: "", mediaType: "text/plain" }],
          metadata: {},
          extensions: [],
          referenceTaskIds: [],
        },
        timestamp: new Date().toISOString(),
      },
      artifacts: [{
        artifactId: "terminal-race-file",
        name: "terminal-race.txt",
        description: "Raw terminal result",
        parts: [{
          content: { $case: "raw", value: Uint8Array.from(Buffer.from("terminal artifact")) },
          filename: "terminal-race.txt",
          mediaType: "text/plain",
        }],
        metadata: {},
        extensions: [],
      }],
      history: [],
      metadata: {},
    };
    const cancelTask = vi.fn(async () => completed);
    ctx.a2aOutbound = {
      send: vi.fn(async () => completed),
      waitForTask: vi.fn(),
      cancelTask,
    };

    const originalMkdir = fs.promises.mkdir.bind(fs.promises);
    let enteredPersistence!: () => void;
    let releasePersistence!: () => void;
    const persistenceEntered = new Promise<void>((resolve) => { enteredPersistence = resolve; });
    const persistenceGate = new Promise<void>((resolve) => { releasePersistence = resolve; });
    const mkdirSpy = vi.spyOn(fs.promises, "mkdir").mockImplementation((async (dirPath: any, options?: any) => {
      enteredPersistence();
      await persistenceGate;
      return originalMkdir(dirPath, options);
    }) as typeof fs.promises.mkdir);

    try {
      await api.handleApiRequest(makeJsonReq("POST", "/api/org/cross-request", {
        fromEmployee: "content-writer",
        service: "external-research",
        prompt: "Exercise terminal artifact cancellation race",
      }), cap.res, ctx);
      await persistenceEntered;
      expect(reg.getSession(cap.body.sessionId)?.transportMeta?.a2aOutbound).toMatchObject({
        taskId: "remote-terminal-race-task",
        state: "TASK_STATE_COMPLETED",
      });

      expect(lifecycle.stopSession(cap.body.sessionId, ctx)).toMatchObject({
        statusCode: 200,
        body: { externalInterruptible: true },
      });
      releasePersistence();

      await vi.waitFor(() => expect(reg.getSession(cap.body.sessionId)).toMatchObject({
        status: "idle",
        lastError: null,
      }));
      expect(cancelTask).not.toHaveBeenCalled();
      expect(reg.getMessages(cap.body.sessionId).at(-1)?.content).toContain("Remote task already completed");
    } finally {
      releasePersistence();
      mkdirSpy.mockRestore();
    }
  });

  it("keeps a pre-task send alive long enough to recover its identity and cancel it", async () => {
    const { api, reg, lifecycle } = await setup();
    const cap = makeRes();
    const ctx = makeCtx();
    const baseConfig = ctx.getConfig();
    ctx.getConfig = () => ({
      ...baseConfig,
      a2a: {
        destinations: [{
          id: "slow-peer",
          agentCardUrl: "https://peer.example/.well-known/agent-card.json",
          token: "0123456789abcdef",
          allowedSkills: ["research"],
          services: [{ name: "external-research", description: "Research via an A2A peer", skillId: "research" }],
        }],
      },
    });
    const working = {
      id: "remote-slow-task",
      contextId: "remote-slow-context",
      status: { state: 2, message: undefined, timestamp: new Date().toISOString() },
      artifacts: [],
      history: [],
      metadata: {},
    };
    const canceled = {
      ...working,
      status: { state: 5, message: undefined, timestamp: new Date().toISOString() },
    };
    let finishSend!: (value: typeof working) => void;
    const send = vi.fn(async (_input: { messageId: string; signal: AbortSignal }) => (
      new Promise<typeof working>((resolve) => { finishSend = resolve; })
    ));
    const cancelTask = vi.fn(async () => canceled);
    ctx.a2aOutbound = { send, waitForTask: vi.fn(), cancelTask };

    await api.handleApiRequest(makeJsonReq("POST", "/api/org/cross-request", {
      fromEmployee: "content-writer",
      service: "external-research",
      prompt: "Stop before the peer returns its task ID",
    }), cap.res, ctx);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const sendInput = send.mock.calls[0]![0];
    expect(sendInput.messageId).toEqual(expect.any(String));

    expect(lifecycle.stopSession(cap.body.sessionId, ctx)).toMatchObject({
      statusCode: 200,
      body: { externalInterruptible: true },
    });
    expect(sendInput.signal.aborted).toBe(false);
    expect(cancelTask).not.toHaveBeenCalled();

    finishSend(working);
    await vi.waitFor(() => expect(cancelTask).toHaveBeenCalledWith("slow-peer", "remote-slow-task"));
    await vi.waitFor(() => expect(reg.getSession(cap.body.sessionId)).toMatchObject({
      status: "interrupted",
      lastError: "Remote A2A task was canceled",
    }));
  });

  it("replays a crashed pre-task send with its durable logical message ID", async () => {
    const { externalA2A, reg } = await setup();
    const ctx = makeCtx();
    const agentCardUrl = "https://pre-task-peer.example/.well-known/agent-card.json";
    configureDeduplicatingDestination(ctx, "pre-task-peer", agentCardUrl);
    const session = reg.createSession({
      engine: "a2a",
      source: "web",
      sourceRef: "cross-request:pre-task-recovery",
      connector: "web",
      sessionKey: "cross-request:pre-task-recovery",
      prompt: "Recover request before remote identity",
      transportMeta: {
        a2aOutbound: {
          destinationId: "pre-task-peer",
          skillId: "research",
          requestMessageId: "stable-pre-task-message",
          requestMessage: "Durably checkpointed request",
          messageIdDeduplication: "guaranteed",
          destinationAgentCardUrl: agentCardUrl,
          state: "SUBMITTED",
        },
      },
    });
    reg.updateSession(session.id, { status: "running" });
    const working = {
      id: "remote-pre-task",
      contextId: "remote-pre-task-context",
      status: { state: 2, message: undefined, timestamp: new Date().toISOString() },
      artifacts: [],
      history: [],
      metadata: {},
    };
    const completed = {
      ...working,
      status: { state: 3, message: undefined, timestamp: new Date().toISOString() },
    };
    const send = vi.fn(async () => working);
    const waitForTask = vi.fn(async () => completed);
    ctx.a2aOutbound = { send, waitForTask };

    const preservedAtBoot = externalA2A.recoverableExternalA2ACrossRequestSessionIds();
    expect([...preservedAtBoot]).toEqual([session.id]);
    expect(reg.recoverStaleSessions({ excludeSessionIds: preservedAtBoot })).toBe(0);
    expect(externalA2A.recoverExternalA2ACrossRequests(ctx)).toBe(1);
    expect(externalA2A.recoverExternalA2ACrossRequests(ctx)).toBe(0);

    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
      destinationId: "pre-task-peer",
      skillId: "research",
      messageId: "stable-pre-task-message",
      message: "Durably checkpointed request",
    })));
    await vi.waitFor(() => expect(waitForTask).toHaveBeenCalledWith(
      "pre-task-peer",
      "remote-pre-task",
      expect.any(Object),
    ));
    await vi.waitFor(() => expect(reg.getSession(session.id)).toMatchObject({ status: "idle", lastError: null }));
    expect(reg.getMessages(session.id).filter((entry: { role: string }) => entry.role === "assistant")).toHaveLength(1);

    reg.updateSession(session.id, { status: "running" });
    expect(externalA2A.recoverExternalA2ACrossRequests(ctx)).toBe(1);
    await vi.waitFor(() => expect(waitForTask).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(reg.getSession(session.id)).toMatchObject({ status: "idle", lastError: null }));
    expect(reg.getMessages(session.id).filter((entry: { role: string }) => entry.role === "assistant")).toHaveLength(1);
  });

  it("refuses taskless replay when the current destination removes its deduplication guarantee", async () => {
    const { externalA2A, reg } = await setup();
    const ctx = makeCtx();
    const agentCardUrl = "https://drift-peer.example/.well-known/agent-card.json";
    const baseConfig = ctx.getConfig();
    ctx.getConfig = () => ({
      ...baseConfig,
      a2a: {
        destinations: [{
          id: "drift-peer",
          agentCardUrl,
          token: "0123456789abcdef",
          allowedSkills: ["research"],
          services: [],
        }],
      },
    });
    const session = reg.createSession({
      engine: "a2a",
      source: "web",
      sourceRef: "cross-request:removed-dedupe-guarantee",
      prompt: "Do not replay after guarantee removal",
      transportMeta: {
        a2aOutbound: {
          destinationId: "drift-peer",
          destinationAgentCardUrl: agentCardUrl,
          skillId: "research",
          requestMessageId: "removed-guarantee-message",
          requestMessage: "Sensitive checkpointed request",
          messageIdDeduplication: "guaranteed",
          state: "SUBMITTED",
        },
      },
    });
    reg.updateSession(session.id, { status: "running" });
    const send = vi.fn();
    ctx.a2aOutbound = { send, waitForTask: vi.fn() };

    expect(externalA2A.recoverExternalA2ACrossRequests(ctx)).toBe(1);
    await vi.waitFor(() => expect(reg.getSession(session.id)).toMatchObject({
      status: "error",
      lastError: expect.stringContaining("no longer guarantees message-ID deduplication"),
      transportMeta: { a2aOutbound: { dispatchOutcome: "replay-refused-config-drift" } },
    }));
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses taskless replay when a destination ID is reassigned to a different peer", async () => {
    const { externalA2A, reg } = await setup();
    const ctx = makeCtx();
    configureDeduplicatingDestination(
      ctx,
      "reassigned-peer",
      "https://replacement-peer.example/.well-known/agent-card.json",
    );
    const session = reg.createSession({
      engine: "a2a",
      source: "web",
      sourceRef: "cross-request:reassigned-peer",
      prompt: "Do not send a prior request to a replacement peer",
      transportMeta: {
        a2aOutbound: {
          destinationId: "reassigned-peer",
          destinationAgentCardUrl: "https://original-peer.example/.well-known/agent-card.json",
          skillId: "research",
          requestMessageId: "reassigned-peer-message",
          requestMessage: "Sensitive checkpointed request",
          messageIdDeduplication: "guaranteed",
          state: "SUBMITTED",
        },
      },
    });
    reg.updateSession(session.id, { status: "running" });
    const send = vi.fn();
    ctx.a2aOutbound = { send, waitForTask: vi.fn() };

    expect(externalA2A.recoverExternalA2ACrossRequests(ctx)).toBe(1);
    await vi.waitFor(() => expect(reg.getSession(session.id)).toMatchObject({
      status: "error",
      lastError: expect.stringContaining("no longer matches the checkpointed peer identity"),
      transportMeta: { a2aOutbound: { dispatchOutcome: "replay-refused-config-drift" } },
    }));
    expect(send).not.toHaveBeenCalled();
  });

  it("stops durable reconciliation after the configured attempt ceiling", async () => {
    const { externalA2A, reg } = await setup();
    const ctx = makeCtx();
    const agentCardUrl = "https://offline-deduplicating-peer.example/.well-known/agent-card.json";
    configureDeduplicatingDestination(ctx, "offline-deduplicating-peer", agentCardUrl);
    const session = reg.createSession({
      engine: "a2a",
      source: "web",
      sourceRef: "cross-request:reconciliation-ceiling",
      connector: "web",
      sessionKey: "cross-request:reconciliation-ceiling",
      prompt: "Bound permanent peer failures",
      transportMeta: {
        a2aOutbound: {
          destinationId: "offline-deduplicating-peer",
          skillId: "research",
          requestMessageId: "stable-ceiling-message",
          requestMessage: "Durably checkpointed request",
          messageIdDeduplication: "guaranteed",
          destinationAgentCardUrl: agentCardUrl,
          reconciliationPendingAt: "2026-09-02T00:00:00.000Z",
          reconciliationAttempts: 2,
          state: "SUBMITTED",
        },
      },
    });
    reg.updateSession(session.id, { status: "waiting" });
    const send = vi.fn(async (_input: unknown) => {
      throw new Error("peer remains unavailable");
    });
    ctx.a2aOutbound = { send, waitForTask: vi.fn() };

    expect(externalA2A.recoverExternalA2ACrossRequests(ctx)).toBe(1);
    await vi.waitFor(() => expect(reg.getSession(session.id)).toMatchObject({
      status: "error",
      lastError: expect.stringContaining("failed after 3 attempts"),
      transportMeta: {
        a2aOutbound: {
          reconciliationPendingAt: null,
          reconciliationAttempts: 3,
        },
      },
    }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(externalA2A.recoverableExternalA2ACrossRequestSessionIds().has(session.id)).toBe(false);
  });

  it("terminalizes an exhausted waiting checkpoint found during startup", async () => {
    const { externalA2A, reg } = await setup();
    const ctx = makeCtx();
    const agentCardUrl = "https://offline-deduplicating-peer.example/.well-known/agent-card.json";
    const session = reg.createSession({
      engine: "a2a",
      source: "web",
      sourceRef: "cross-request:torn-reconciliation-ceiling",
      connector: "web",
      sessionKey: "cross-request:torn-reconciliation-ceiling",
      prompt: "Heal a torn exhausted checkpoint",
      transportMeta: {
        a2aOutbound: {
          destinationId: "offline-deduplicating-peer",
          skillId: "research",
          requestMessageId: "stable-torn-ceiling-message",
          requestMessage: "Durably checkpointed request",
          messageIdDeduplication: "guaranteed",
          destinationAgentCardUrl: agentCardUrl,
          reconciliationPendingAt: null,
          reconciliationError: "last ambiguous failure",
          reconciliationAttempts: 3,
          state: "SUBMITTED",
        },
      },
    });
    reg.updateSession(session.id, { status: "waiting" });
    const send = vi.fn();
    ctx.a2aOutbound = { send, waitForTask: vi.fn() };

    expect(externalA2A.recoverableExternalA2ACrossRequestSessionIds().has(session.id)).toBe(true);
    expect(externalA2A.recoverExternalA2ACrossRequests(ctx)).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(reg.getSession(session.id)).toMatchObject({
      status: "error",
      lastError: expect.stringContaining("failed after 3 attempts"),
      transportMeta: {
        a2aOutbound: {
          reconciliationPendingAt: null,
          reconciliationAttempts: 3,
        },
      },
    });
    expect(externalA2A.recoverableExternalA2ACrossRequestSessionIds().has(session.id)).toBe(false);
  });

  it("does not report another session's recovery as a successful target stop", async () => {
    const { externalA2A, reg } = await setup();
    const ctx = makeCtx();
    const target = reg.createSession({
      engine: "a2a",
      source: "web",
      sourceRef: "cross-request:incomplete-stop-target",
      prompt: "Incomplete non-replayable target",
      transportMeta: {
        a2aOutbound: {
          destinationId: "target-peer",
          skillId: "research",
          requestMessageId: "target-message",
          requestMessage: "Target request",
        },
      },
    });
    reg.updateSession(target.id, { status: "running" });
    const other = reg.createSession({
      engine: "a2a",
      source: "web",
      sourceRef: "cross-request:other-recoverable-session",
      prompt: "Other recoverable request",
      transportMeta: {
        a2aOutbound: {
          destinationId: "other-peer",
          taskId: "other-remote-task",
        },
      },
    });
    reg.updateSession(other.id, { status: "running" });
    const completed = {
      id: "other-remote-task",
      contextId: "other-context",
      status: { state: 3, message: undefined, timestamp: new Date().toISOString() },
      artifacts: [],
      history: [],
      metadata: {},
    };
    const waitForTask = vi.fn(async () => completed);
    ctx.a2aOutbound = { send: vi.fn(), waitForTask };

    expect(externalA2A.requestExternalA2ACrossRequestStop(target.id, ctx)).toBe(false);
    expect(waitForTask).toHaveBeenCalledWith("other-peer", "other-remote-task", expect.any(Object));
    expect(reg.getSession(target.id)?.status).toBe("running");
    await vi.waitFor(() => expect(reg.getSession(other.id)?.status).toBe("idle"));
  });

  it("recovers a cancellation requested before restart and before task identity", async () => {
    const { externalA2A, reg, runLedger, runRecovery } = await setup();
    const ctx = makeCtx();
    const agentCardUrl = "https://cancel-recovery-peer.example/.well-known/agent-card.json";
    configureDeduplicatingDestination(ctx, "cancel-recovery-peer", agentCardUrl);
    const session = reg.createSession({
      engine: "a2a",
      source: "web",
      sourceRef: "cross-request:pre-task-cancel-recovery",
      connector: "web",
      sessionKey: "cross-request:pre-task-cancel-recovery",
      prompt: "Cancel checkpointed request",
      transportMeta: {
        a2aOutbound: {
          destinationId: "cancel-recovery-peer",
          skillId: "research",
          requestMessageId: "stable-cancel-message",
          requestMessage: "Durably checkpointed canceled request",
          messageIdDeduplication: "guaranteed",
          destinationAgentCardUrl: agentCardUrl,
          cancellationRequestedAt: "2026-09-02T00:00:00.000Z",
          state: "SUBMITTED",
        },
      },
    });
    const started = reg.beginSessionRun({
      sessionId: session.id,
      prompt: "Cancel checkpointed request",
      transportMeta: session.transportMeta,
    })!;
    const activeRunId = started.transportMeta?.activeRunId as string;
    reg.updateSession(session.id, { status: "running" });
    reg.updateSession(session.id, { status: "waiting" });
    expect(runLedger.getRunLedger().getRun(activeRunId)?.currentState).toBe("blocked");

    const working = {
      id: "remote-cancel-recovery-task",
      contextId: "remote-cancel-recovery-context",
      status: { state: 2, message: undefined, timestamp: new Date().toISOString() },
      artifacts: [],
      history: [],
      metadata: {},
    };
    const canceled = {
      ...working,
      status: { state: 5, message: undefined, timestamp: new Date().toISOString() },
    };
    const send = vi.fn(async (_input: unknown) => working);
    const waitForTask = vi.fn();
    const cancelTask = vi.fn(async () => canceled);
    ctx.a2aOutbound = { send, waitForTask, cancelTask };

    const preservedAtBoot = externalA2A.recoverableExternalA2ACrossRequestSessionIds();
    expect(preservedAtBoot.has(session.id)).toBe(true);
    runRecovery.recoverOrphanedRunsAtStartup(new Set(preservedAtBoot), false);
    expect(runLedger.getRunLedger().getRun(activeRunId)?.currentState).toBe("blocked");
    expect(externalA2A.recoverExternalA2ACrossRequests(ctx)).toBe(1);

    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "stable-cancel-message",
    })));
    await vi.waitFor(() => expect(cancelTask).toHaveBeenCalledWith(
      "cancel-recovery-peer",
      "remote-cancel-recovery-task",
    ));
    expect(waitForTask).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(reg.getSession(session.id)).toMatchObject({
      status: "interrupted",
      lastError: "Remote A2A task was canceled",
    }));
    expect(runLedger.getRunLedger().getRun(activeRunId)?.currentState).toBe("interrupted");
  });

  it("coalesces startup recovery and resumes polling without replaying the remote request", async () => {
    const { externalA2A, reg } = await setup();
    const ctx = makeCtx();
    const oldActivity = "2026-09-01T00:00:00.000Z";
    const session = reg.createSession({
      engine: "a2a",
      source: "web",
      sourceRef: "cross-request:recovery",
      connector: "web",
      sessionKey: "cross-request:recovery",
      prompt: "Recover remote work",
      transportMeta: {
        a2aOutbound: {
          destinationId: "recovery-peer",
          skillId: "research",
          taskId: "remote-recovery-task",
          contextId: "remote-recovery-context",
          state: "TASK_STATE_WORKING",
        },
      },
    });
    reg.updateSession(session.id, { status: "running", lastActivity: oldActivity });
    const working = {
      id: "remote-recovery-task",
      contextId: "remote-recovery-context",
      status: { state: 2, message: undefined, timestamp: new Date().toISOString() },
      artifacts: [],
      history: [],
      metadata: {},
    };
    const completed = {
      ...working,
      status: {
        state: 3,
        message: {
          messageId: "remote-recovery-completed",
          taskId: working.id,
          contextId: working.contextId,
          role: 2,
          parts: [{ content: { $case: "text", value: "Recovered remote completion" }, filename: "", mediaType: "text/plain" }],
          metadata: {},
          extensions: [],
          referenceTaskIds: [],
        },
        timestamp: new Date().toISOString(),
      },
    };
    let finish!: () => void;
    const send = vi.fn();
    let waitCount = 0;
    const waitForTask = vi.fn(async (
      _destinationId: string,
      _taskId: string,
      options: { onUpdate: (value: any) => Promise<void> },
    ) => {
      await options.onUpdate(working);
      waitCount += 1;
      if (waitCount === 1) await new Promise<void>((resolve) => { finish = resolve; });
      await options.onUpdate(completed);
      return completed;
    });
    ctx.a2aOutbound = { send, waitForTask };

    const preservedAtBoot = externalA2A.recoverableExternalA2ACrossRequestSessionIds();
    expect([...preservedAtBoot]).toEqual([session.id]);
    expect(reg.recoverStaleSessions({ excludeSessionIds: preservedAtBoot })).toBe(0);
    expect(reg.getSession(session.id)?.status).toBe("running");
    expect(externalA2A.recoverExternalA2ACrossRequests(ctx)).toBe(1);
    expect(externalA2A.recoverExternalA2ACrossRequests(ctx)).toBe(0);
    await vi.waitFor(() => expect(waitForTask).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(reg.getSession(session.id)).toMatchObject({
      status: "running",
      transportMeta: { a2aOutbound: { recoveryStartedAt: expect.any(String) } },
    }));
    expect(reg.getSession(session.id)?.lastActivity).not.toBe(oldActivity);
    expect(send).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    finish();
    await vi.waitFor(() => expect(reg.getSession(session.id)).toMatchObject({ status: "idle", lastError: null }));
    expect(reg.getMessages(session.id).at(-1)?.content).toContain("Recovered remote completion");
    expect(reg.getMessages(session.id).filter((entry: { role: string }) => entry.role === "assistant")).toHaveLength(1);

    const recoveredSession = reg.getSession(session.id)!;
    const outboundMeta = recoveredSession.transportMeta?.a2aOutbound as Record<string, unknown>;
    const { lastProgressMessageId: _lostCrashMarker, ...metaWithoutMarker } = outboundMeta;
    reg.updateSession(session.id, {
      status: "running",
      transportMeta: {
        ...recoveredSession.transportMeta,
        a2aOutbound: metaWithoutMarker as any,
      },
    });

    expect(externalA2A.recoverExternalA2ACrossRequests(ctx)).toBe(1);
    await vi.waitFor(() => expect(waitForTask).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(reg.getSession(session.id)).toMatchObject({ status: "idle", lastError: null }));
    expect(reg.getMessages(session.id).filter((entry: { role: string }) => entry.role === "assistant")).toHaveLength(1);
  });
});

describe("POST /api/org/cross-request — caller identity and chain bounds", () => {
  /** Attach a session-scoped principal, the way the auth gate does. */
  function withSessionPrincipal(req: any, sessionId: string) {
    req.cuttlefishPrincipal = { kind: "session", sessionId };
    return req;
  }

  it("binds a session-scoped caller to its own employee and its own session", async () => {
    const { api, reg } = await setup();
    const caller = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:content-writer",
      prompt: "write something",
      employee: "content-writer",
    });
    const cap = makeRes();

    await api.handleApiRequest(
      withSessionPrincipal(makeJsonReq("POST", "/api/org/cross-request", {
        fromEmployee: "content-writer",
        service: "code-review",
        prompt: "Review the new blog template component",
      }), caller.id),
      cap.res,
      makeCtx(),
    );

    expect(cap.status).toBe(201);
    const session = reg.getSession(cap.body.sessionId);
    // The chain parent is forced onto the caller's own session, and the
    // originating session is recorded so the request is traceable from the
    // requester's side too.
    expect(session?.parentSessionId).toBe(caller.id);
    expect((session?.transportMeta as any).crossRequest).toMatchObject({
      fromEmployee: "content-writer",
      provider: "platform-dev",
      requesterSessionId: caller.id,
    });
  });

  it("refuses a session-scoped caller that claims a different employee", async () => {
    const { api, reg } = await setup();
    const caller = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:content-writer-impersonation",
      prompt: "write something",
      employee: "content-writer",
    });
    const cap = makeRes();

    await api.handleApiRequest(
      withSessionPrincipal(makeJsonReq("POST", "/api/org/cross-request", {
        fromEmployee: "platform-dev",
        service: "code-review",
        prompt: "Do this as somebody else",
      }), caller.id),
      cap.res,
      makeCtx(),
    );

    expect(cap.status).toBe(403);
    expect(cap.body).toMatchObject({ code: "cross_request_identity_mismatch" });
    expect(hoisted.dispatchEmployeeSessionRun).not.toHaveBeenCalled();
  });

  it("refuses a cross-request that closes a loop already on the chain", async () => {
    const { api, reg } = await setup();
    writeEmployee("content", "content-writer", `
name: content-writer
displayName: Content Writer
department: content
rank: employee
engine: claude
model: sonnet
persona: Write content.
provides:
  - name: copy-edit
    description: Edit copy for tone
`);
    const origin = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:origin",
      prompt: "start",
      employee: "content-writer",
    });
    const first = makeRes();
    await api.handleApiRequest(makeJsonReq("POST", "/api/org/cross-request", {
      fromEmployee: "content-writer",
      service: "code-review",
      prompt: "Review this",
      parentSessionId: origin.id,
    }), first.res, makeCtx());
    expect(first.status).toBe(201);

    // platform-dev now asks content-writer back for copy-edit — fine, new pair.
    const second = makeRes();
    await api.handleApiRequest(makeJsonReq("POST", "/api/org/cross-request", {
      fromEmployee: "platform-dev",
      service: "copy-edit",
      prompt: "Copy-edit my review",
      parentSessionId: first.body.sessionId,
    }), second.res, makeCtx());
    expect(second.status).toBe(201);

    // content-writer asking platform-dev for code-review AGAIN closes the loop.
    const third = makeRes();
    await api.handleApiRequest(makeJsonReq("POST", "/api/org/cross-request", {
      fromEmployee: "content-writer",
      service: "code-review",
      prompt: "Review the edit of the review",
      parentSessionId: second.body.sessionId,
    }), third.res, makeCtx());

    expect(third.status).toBe(409);
    expect(third.body).toMatchObject({ code: "cross_request_cycle" });
    expect(third.body.chain).toContain("content-writer→platform-dev");
  });
});
