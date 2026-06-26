import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import type { ApiContext } from "../api.js";
import type { OrchestrationConfig } from "../../orchestration/types.js";
import { OrchestrationRuntime } from "../../orchestration/runtime.js";
import { withTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

const testHome = withTempCuttlefishHome("cuttlefish-api-orch-");
let dbPath: string;
let tmpDir: string;

beforeEach(() => {
  tmpDir = testHome.home();
  dbPath = `${tmpDir}/orchestration.sqlite`;
  vi.resetModules();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("handleApiRequest orchestration routing", () => {
  it("routes GET /api/orchestration/status through the public API facade", async () => {
    const { api } = await setup();
    const ctx = makeCtx(config());
    const cap = makeRes();

    await api.handleApiRequest(makeReq("GET", "/api/orchestration/status"), cap.res, ctx);

    expect(cap.status).toBe(200);
    expect(cap.body).toEqual(expect.objectContaining({
      enabled: true,
      runtimeBound: false,
    }));
  });

  it("matches direct pause-task behavior through handleApiRequest", async () => {
    const { api, orch } = await setup();
    const runtime = new OrchestrationRuntime({ config: config(), dbPath, startReaper: false });
    const ctx = makeCtx(config());
    ctx.orchestration = { runtime };

    const viaApi = makeRes();
    await api.handleApiRequest(
      makeJsonReq({ taskId: "task-paused", coordinatorId: "coord-paused", reason: "operator" }, "/api/orchestration/queue/pause-task"),
      viaApi.res,
      ctx,
    );

    const direct = makeRes();
    await orch.handleOrchestrationRoutes(
      "POST",
      "/api/orchestration/queue/pause-task",
      direct.res,
      ctx,
      makeJsonReq({ taskId: "task-paused-2", coordinatorId: "coord-paused-2", reason: "operator" }, "/api/orchestration/queue/pause-task"),
    );

    expect(viaApi.status).toBe(200);
    expect(viaApi.body).toMatchObject({ pause: { taskId: "task-paused", coordinatorId: "coord-paused", pauseReason: "operator" } });
    expect(direct.status).toBe(200);
    expect(direct.body).toMatchObject({ pause: { taskId: "task-paused-2", coordinatorId: "coord-paused-2", pauseReason: "operator" } });
    runtime.close();
  });

  it("matches direct resume-task behavior through handleApiRequest", async () => {
    const { api, orch } = await setup();
    const runtime = new OrchestrationRuntime({ config: config(), dbPath, startReaper: false });
    runtime.pauseTask("task-resume", "coord-resume", { reason: "operator" });
    runtime.pauseTask("task-resume-direct", "coord-resume-direct", { reason: "operator" });
    const ctx = makeCtx(config());
    ctx.orchestration = { runtime };

    const viaApi = makeRes();
    await api.handleApiRequest(
      makeJsonReq({ taskId: "task-resume", coordinatorId: "coord-resume" }, "/api/orchestration/queue/resume-task"),
      viaApi.res,
      ctx,
    );

    const direct = makeRes();
    await orch.handleOrchestrationRoutes(
      "POST",
      "/api/orchestration/queue/resume-task",
      direct.res,
      ctx,
      makeJsonReq({ taskId: "task-resume-direct", coordinatorId: "coord-resume-direct" }, "/api/orchestration/queue/resume-task"),
    );

    expect(viaApi.status).toBe(202);
    expect(viaApi.body).toMatchObject({ resumed: true });
    expect(direct.status).toBe(202);
    expect(direct.body).toMatchObject({ resumed: true });
    runtime.close();
  });

  it("reads continuation retry bodies through the facade instead of failing early", async () => {
    const { api } = await setup();
    const runtime = new OrchestrationRuntime({ config: config(), dbPath, startReaper: false });
    const ctx = makeCtx(config());
    ctx.orchestration = { runtime };
    const cap = makeRes();

    await api.handleApiRequest(
      makeJsonReq({ taskId: "missing-task", coordinatorId: "missing-coord" }, "/api/orchestration/continuations/retry"),
      cap.res,
      ctx,
    );

    expect(cap.status).toBe(404);
    expect(cap.body).toEqual(expect.objectContaining({ error: expect.any(String) }));
    runtime.close();
  });

  it("reads recovery requeue bodies through the facade instead of hanging", async () => {
    const { api } = await setup();
    const runtime = new OrchestrationRuntime({ config: config(), dbPath, startReaper: false });
    const ctx = makeCtx(config());
    ctx.orchestration = { runtime };
    const cap = makeRes();

    await api.handleApiRequest(
      makeJsonReq({
        manifestPath: "/tmp/missing.json",
        taskId: "task-1",
        coordinatorId: "coord-1",
        managerName: "missing-manager",
      }, "/api/orchestration/recovery/requeue"),
      cap.res,
      ctx,
    );

    expect(cap.status).toBe(403);
    expect(cap.body.error).toContain("managerName does not resolve");
    runtime.close();
  });
});

async function setup() {
  const api = await import("../api.js");
  const orch = await import("../api/orchestration-routes.js");
  const reg = await import("../../sessions/registry.js");
  reg.initDb();
  return { api, orch, reg };
}

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
      return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    },
  };
}

function makeReq(method: string, urlPath: string) {
  return {
    method,
    url: urlPath,
    headers: { host: "localhost", authorization: "Bearer test-gateway-token" },
  } as Parameters<Awaited<ReturnType<typeof setup>>["api"]["handleApiRequest"]>[0];
}

function makeJsonReq(body: unknown, urlPath: string) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as Parameters<Awaited<ReturnType<typeof setup>>["api"]["handleApiRequest"]>[0];
  Object.assign(req, {
    method: "POST",
    url: urlPath,
    headers: {
      host: "localhost",
      "content-type": "application/json",
      authorization: "Bearer test-gateway-token",
    },
  });
  return req;
}

function makeCtx(cfg: OrchestrationConfig): ApiContext {
  const liveConfig = {
    gateway: { port: 8888, host: "127.0.0.1" },
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "opus" },
      codex: { bin: "codex", model: "gpt" },
      mock: { bin: "mock", model: "mock" },
    },
    connectors: {},
    logging: { file: false, stdout: false, level: "error" },
    orchestration: { enabled: true },
  };
  return {
    config: liveConfig as never,
    getConfig: () => liveConfig as never,
    connectors: new Map(),
    startTime: Date.now(),
    emit: vi.fn(),
    sessionManager: {
      getQueue: () => ({ getTransportState: (_key: string, status: string) => status, getPendingCount: () => 0 }),
    },
    gatewayAuthToken: "test-gateway-token",
    cuttlefishHome: tmpDir,
    orchestration: { config: cfg, dbPath },
  } as unknown as ApiContext;
}

function config(): OrchestrationConfig {
  return {
    workers: [
      {
        id: "codexSenior",
        provider: "openai",
        family: "openai",
        tier: "frontier",
        capabilities: ["repo_edit", "coding"],
        tools: ["git", "filesystem"],
        maxConcurrentTasks: 1,
        costClass: "high",
        workspacePolicy: "isolated_worktree",
      },
    ],
    roles: [
      {
        id: "seniorImplementer",
        requiredCapabilities: ["repo_edit", "coding"],
        requiredTools: ["git", "filesystem"],
      },
    ],
    coordinatorTemplates: [
      {
        id: "standardImplementation",
        purpose: "feature work",
        requiredRoles: ["seniorImplementer"],
        optionalRoles: [],
      },
    ],
    quotas: { providers: {}, families: {} },
  };
}
