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

async function setup() {
  vi.resetModules();
  const api = await import("../api.js");
  const reg = await import("../../sessions/registry.js");
  const lifecycle = await import("../session-lifecycle-service.js");
  const runLedger = await import("../../run-ledger/index.js");
  reg.initDb();
  return { api, reg, lifecycle, runLedger };
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
    })));
    await vi.waitFor(() => expect(reg.getSession(cap.body.sessionId)).toMatchObject({
      engine: "a2a",
      status: "idle",
    }));
    expect(reg.getMessages(cap.body.sessionId).at(-1)?.content).toContain("Remote research completed");
    expect(hoisted.dispatchEmployeeSessionRun).not.toHaveBeenCalled();
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
