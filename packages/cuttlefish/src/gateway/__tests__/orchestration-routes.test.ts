import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { handleApiRequest, type ApiContext } from "../api.js";
import { handleOrchestrationRoutes } from "../api/orchestration-routes.js";
import { interruptExpiredOrchestrationLeaseSessions } from "../api/session-dispatch.js";
import { OrchestrationRuntime } from "../../orchestration/runtime.js";
import { PersistentMatrixScheduler } from "../../orchestration/persistent-scheduler.js";
import type { OrchestrationConfig } from "../../orchestration/types.js";
import { createSession, getSession, updateSession } from "../../sessions/registry.js";
import { appendOrchestrationTelemetry } from "../../orchestration/telemetry.js";
import { WORKTREE_MARKER, type WorktreeHandle } from "../../orchestration/worktree.js";
import { withTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

let tmpDir: string;
let dbPath: string;
const testHome = withTempCuttlefishHome("cuttlefish-orch-api-");

beforeEach(() => {
  tmpDir = testHome.home();
  dbPath = path.join(tmpDir, "orchestration.db");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/orchestration/*", () => {
  it("observes workers, leases, queue, and allocations without executing work", async () => {
    const cfg = config();
    const scheduler = PersistentMatrixScheduler.open(cfg, { dbPath });
    scheduler.requestAllocation(request("task-one", "coord-one"));
    scheduler.requestAllocation(request("task-two", "coord-two"));
    scheduler.close();

    const ctx = makeCtx(cfg);

    const workers = await get("/api/orchestration/workers", ctx);
    const leases = await get("/api/orchestration/leases", ctx);
    const queue = await get("/api/orchestration/queue", ctx);
    const allocations = await get("/api/orchestration/allocations", ctx);
    const continuations = await get("/api/orchestration/continuations", ctx);

    expect(workers.body).toMatchObject({ workers: [{ id: "codexSenior" }] });
    expect(leases.body).toMatchObject({ leases: [{ taskId: "task-one", state: "running" }] });
    expect(queue.body).toMatchObject({ queue: [{ taskId: "task-two", missingRoles: ["seniorImplementer"] }] });
    expect(allocations.body).toMatchObject({ allocations: [{ taskId: "task-one", state: "allocated" }] });
    expect(continuations.body).toEqual({ continuations: [] });
  });

  it("rejects mutating methods on observe-only routes", async () => {
    let cap = makeRes();
    await handleOrchestrationRoutes("POST", "/api/orchestration/leases", cap.res, makeCtx(config()), makeReq("POST", "/api/orchestration/leases"));

    expect(cap.status).toBe(405);
    expect(cap.body).toEqual({ error: "Method not allowed" });
  });

  it("reads observe state from the shared runtime when one is present", async () => {
    const ctx = makeCtx(config());
    ctx.orchestration = {
      runtime: {
        listWorkers: () => [{ id: "runtimeWorker" }],
        listLeases: () => [{ taskId: "runtime-task", state: "running" }],
        listQueue: () => [],
        listAllocations: () => [{ taskId: "runtime-task", state: "allocated" }],
        listLiveContinuations: () => [{ taskId: "runtime-task", coordinatorId: "runtime-coord", state: "failed" }],
      } as any,
    };

    const workers = await get("/api/orchestration/workers", ctx);
    const leases = await get("/api/orchestration/leases", ctx);
    const continuations = await get("/api/orchestration/continuations", ctx);

    expect(workers.body).toMatchObject({ workers: [{ id: "runtimeWorker" }] });
    expect(leases.body).toMatchObject({ leases: [{ taskId: "runtime-task" }] });
    expect(continuations.body).toMatchObject({ continuations: [{ taskId: "runtime-task", state: "failed" }] });
  });

  it("returns dashboard status without executing work", async () => {
    const runtime = new OrchestrationRuntime({
      config: config(),
      dbPath,
      startReaper: false,
    });
    const ctx = makeCtx(config());
    const recoveryDir = path.join(tmpDir, "orchestration-recovery");
    fs.mkdirSync(recoveryDir, { recursive: true });
    fs.writeFileSync(path.join(recoveryDir, "2026-06-24T12-00-00-000Z-orchestration-db-recovery.json"), JSON.stringify({
      recoveredAt: "2026-06-24T12:00:00.000Z",
      originalDbPath: dbPath,
      corruptDbPath: `${dbPath}.corrupt-20260624T120000000Z`,
      message: "orchestration state could not be trusted",
      operatorGuidance: "Inspect the quarantined database manually.",
    }));
    ctx.orchestration = { runtime, recoveryDir };
    const allocated = runtime.requestAllocation(request("status-task", "status-coord"));
    expect(allocated.ok).toBe(true);

    const status = await get("/api/orchestration/status", ctx);

    expect(status.body).toMatchObject({
      enabled: true,
      runtimeBound: true,
      degraded: false,
      queuePaused: false,
      counts: {
        workers: 1,
        runningLeases: 1,
        activeWork: true,
      },
      recoveryNotices: [{
        recoveredAt: "2026-06-24T12:00:00.000Z",
        originalDbPath: dbPath,
        corruptDbPath: `${dbPath}.corrupt-20260624T120000000Z`,
      }],
    });
    runtime.close();
  });

  it("pauses and resumes the global orchestration queue through control routes", async () => {
    const runtime = new OrchestrationRuntime({ config: config(), dbPath, startReaper: false });
    const ctx = makeCtx(config());
    ctx.orchestration = { runtime };

    const pause = makeRes();
    await handleOrchestrationRoutes(
      "POST",
      "/api/orchestration/queue/pause",
      pause.res,
      ctx,
      makeJsonReq({ reason: "operator hold" }, "/api/orchestration/queue/pause"),
    );
    expect(pause.status).toBe(200);
    expect(pause.body.controlState).toMatchObject({ queuePaused: true, pauseReason: "operator hold" });

    const status = await get("/api/orchestration/status", ctx);
    expect(status.body).toMatchObject({ queuePaused: true, pauseReason: "operator hold" });

    const resume = makeRes();
    await handleOrchestrationRoutes(
      "POST",
      "/api/orchestration/queue/resume",
      resume.res,
      ctx,
      makeJsonReq({}, "/api/orchestration/queue/resume"),
    );
    expect(resume.status).toBe(202);
    expect(resume.body.controlState).toMatchObject({ queuePaused: false });
    runtime.close();
  });

  it("returns bounded telemetry summaries without raw records", async () => {
    const telemetryLogPath = path.join(tmpDir, "telemetry.jsonl");
    appendOrchestrationTelemetry({
      task_id: "telemetry-task",
      coordinator_id: "telemetry-coord",
      session_id: "session-1",
      lease_id: "lease-1",
      worker_id: "codexSenior",
      provider: "openai",
      family: "openai",
      model: "gpt",
      role: "seniorImplementer",
      mode: "single_worker",
      source: "orchestration",
      cost: 0.25,
      latency_ms: 1200,
      tokens: 2000,
      files_changed: 2,
      tests_added: 1,
      tests_passed: true,
      review_blockers: 0,
      human_edits: 0,
      regressions: 0,
      disposition: "completed",
      timestamp: "2026-06-24T10:00:00.000Z",
    }, { logPath: telemetryLogPath, fsync: false });
    const ctx = makeCtx(config());
    ctx.orchestration = { ...ctx.orchestration, telemetryLogPath };

    const telemetry = await get("/api/orchestration/telemetry/summary", ctx);

    expect(telemetry.body).toMatchObject({
      maxRecords: 5000,
      summary: {
        totals: { count: 1, totalCost: 0.25 },
        byWorker: { codexSenior: { count: 1 } },
      },
    });
    expect(telemetry.body.records).toBeUndefined();
  });

  it("lists managed worktrees without diffs or prompt content", async () => {
    const worktreeRoot = path.join(tmpDir, "worktrees");
    const worktreePath = path.join(worktreeRoot, "cuttlefish-worktree-task-openai");
    const handle: WorktreeHandle = {
      taskId: "worktree-task",
      lane: "openai",
      path: worktreePath,
      baseCwd: tmpDir,
      gitRoot: tmpDir,
      branch: "cuttlefish/worktree-task/openai/1",
      createdAt: "2026-06-24T10:00:00.000Z",
    };
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.writeFileSync(path.join(worktreePath, WORKTREE_MARKER), JSON.stringify(handle));
    const ctx = makeCtx(config());
    ctx.orchestration = { ...ctx.orchestration, worktreeRoot };

    const worktrees = await get("/api/orchestration/worktrees", ctx);

    expect(worktrees.body).toEqual({
      root: worktreeRoot,
      worktrees: [handle],
    });
    expect(JSON.stringify(worktrees.body)).not.toContain("diff --git");
  });

  it("lists dual-lane manifests without prompt hashes or raw diffs", async () => {
    const dualLaneStateDir = path.join(tmpDir, "dual-lane");
    const taskDir = path.join(dualLaneStateDir, "dual-task", "dual-coord");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "manifest.json"), JSON.stringify(dualLaneManifest(), null, 2));
    const ctx = makeCtx(config());
    ctx.orchestration = { ...ctx.orchestration, dualLaneStateDir };

    const dualLane = await get("/api/orchestration/dual-lane", ctx);

    expect(dualLane.body.manifests).toMatchObject([{
      taskId: "dual-task",
      state: "selection_required",
      selectedLane: null,
      lanes: [{ id: "openai", sessionStatus: "completed" }, { id: "anthropic", sessionStatus: "completed" }],
      comparisonReport: {
        laneSummaries: [{ laneId: "openai", changedFiles: ["src/a.ts"] }, { laneId: "anthropic", changedFiles: ["src/b.ts"] }],
      },
    }]);
    const raw = JSON.stringify(dualLane.body);
    expect(raw).not.toContain("promptHash");
    expect(raw).not.toContain("diff --git");
  });

  it("returns review-policy explanations for blocked run requests", async () => {
    const runtime = new OrchestrationRuntime({
      config: sameFamilyReviewConfig(),
      dbPath: ":memory:",
      startReaper: false,
    });
    const ctx = makeCtx(sameFamilyReviewConfig());
    ctx.orchestration = { runtime };
    let cap = makeRes();

    await handleOrchestrationRoutes(
      "POST",
      "/api/orchestration/run",
      cap.res,
      ctx,
      makeJsonReq({
        mode: "single_worker_with_review",
        task: {
          taskId: "api-blocked",
          coordinatorId: "api-coord",
          coordinatorTemplate: "withReview",
          mode: "single_worker_with_review",
          prompt: "Implement and review",
        },
      }),
    );

    expect(cap.status).toBe(409);
    expect(cap.body).toMatchObject({
      ok: false,
      state: "blocked_resource",
      reviewPolicy: {
        explanations: [{
          decision: "same_family_fallback_forbidden",
          role: "independentReviewer",
        }],
      },
    });
    runtime.close();
  });

  it("rejects new live run requests when orchestration is disabled in config", async () => {
    const cap = makeRes();
    await handleOrchestrationRoutes(
      "POST",
      "/api/orchestration/run",
      cap.res,
      makeCtx(config(), { enabled: false }),
      makeJsonReq({
        mode: "single_worker",
        task: {
          taskId: "api-disabled",
          coordinatorId: "api-disabled",
          requiredRoles: ["seniorImplementer"],
          prompt: "Do not run",
        },
      }),
    );

    expect(cap.status).toBe(409);
    expect(cap.body).toEqual({ error: "orchestration is disabled" });
  });

  it("rejects unauthenticated high-risk orchestration mutations on loopback", async () => {
    const cap = makeRes();
    await handleOrchestrationRoutes(
      "POST",
      "/api/orchestration/run",
      cap.res,
      makeCtx(config()),
      makeJsonReq({
        mode: "single_worker",
        task: {
          taskId: "api-unauth",
          coordinatorId: "api-unauth",
          requiredRoles: ["seniorImplementer"],
          prompt: "Do not run without auth",
        },
      }, "/api/orchestration/run", false),
    );

    expect(cap.status).toBe(401);
    expect(cap.body.error).toContain("Missing or invalid gateway auth token");
  });

  it("retries failed continuations through the live runtime", async () => {
    const ctx = makeCtx(config());
    ctx.orchestration = {
      runtime: {
        retryFailedLiveContinuation: () => ({
          ok: true,
          state: "dispatching",
          continuation: { taskId: "task-retry", coordinatorId: "coord-retry", state: "dispatching" },
          allocation: { allocationId: "alloc-retry" },
          reviewPolicy: { explanations: [] },
        }),
      } as any,
    };
    const cap = makeRes();

    await handleOrchestrationRoutes(
      "POST",
      "/api/orchestration/continuations/retry",
      cap.res,
      ctx,
      makeJsonReq({ taskId: "task-retry", coordinatorId: "coord-retry" }, "/api/orchestration/continuations/retry"),
    );

    expect(cap.status).toBe(202);
    expect(cap.body).toMatchObject({
      ok: true,
      state: "dispatching",
      allocation: { allocationId: "alloc-retry" },
    });
  });

  it("stops leases only through safe mapped-session semantics", async () => {
    const runtime = new OrchestrationRuntime({ config: config(), dbPath, startReaper: false });
    const allocation = runtime.requestAllocation(request("stop-task", "stop-coord"));
    expect(allocation.ok).toBe(true);
    if (!allocation.ok) return;
    const lease = allocation.allocation.leases[0];
    const session = createSession({
      engine: "mock",
      source: "web",
      sourceRef: "web:stop",
      transportMeta: {
        orchestrationLease: {
          leaseId: lease.leaseId,
          taskId: lease.taskId,
          coordinatorId: lease.coordinatorId,
          workerId: lease.workerId,
          role: lease.role,
          mode: "single_worker",
        },
      },
    });
    updateSession(session.id, { status: "running" });
    const kill = vi.fn();
    const clearQueue = vi.fn();
    const ctx = makeCtx(config());
    ctx.orchestration = { runtime };
    ctx.sessionManager = {
      getEngine: () => ({ name: "mock", run: vi.fn(), kill, isAlive: () => true, killAll: vi.fn(), killIdle: vi.fn() }),
      getQueue: () => ({ clearQueue, getTransportState: (_key: string, status: string) => status, getPendingCount: () => 0 }),
    } as any;
    let cap = makeRes();

    await handleOrchestrationRoutes(
      "POST",
      "/api/orchestration/leases/stop",
      cap.res,
      ctx,
      makeJsonReq({ leaseId: lease.leaseId, reason: "operator stop" }, "/api/orchestration/leases/stop"),
    );

    expect(cap.status).toBe(202);
    expect(cap.body).toMatchObject({ status: "stop_requested", released: false, sessionId: session.id });
    expect(kill).toHaveBeenCalledWith(session.id, "operator stop");
    expect(clearQueue).toHaveBeenCalledWith(session.sessionKey);
    expect(getSession(session.id)).toMatchObject({ status: "interrupted", lastError: "operator stop" });
    expect(runtime.listLeases()).toMatchObject([{ leaseId: lease.leaseId, state: "running" }]);
    runtime.releaseLease(lease.leaseId, lease.coordinatorId);

    const terminalAllocation = runtime.requestAllocation(request("terminal-stop-task", "terminal-stop-coord"));
    expect(terminalAllocation.ok).toBe(true);
    if (!terminalAllocation.ok) return;
    const terminalLease = terminalAllocation.allocation.leases[0];
    createSession({
      engine: "mock",
      source: "web",
      sourceRef: "web:terminal-stop",
      transportMeta: {
        orchestrationLease: {
          leaseId: terminalLease.leaseId,
          taskId: terminalLease.taskId,
          coordinatorId: terminalLease.coordinatorId,
          workerId: terminalLease.workerId,
          role: terminalLease.role,
          mode: "single_worker",
        },
      },
    });
    cap = makeRes();

    await handleOrchestrationRoutes(
      "POST",
      "/api/orchestration/leases/stop",
      cap.res,
      ctx,
      makeJsonReq({ leaseId: terminalLease.leaseId }, "/api/orchestration/leases/stop"),
    );

    expect(cap.status).toBe(200);
    expect(cap.body).toMatchObject({ status: "released_terminal_session", sessionId: expect.any(String) });
    expect(runtime.listLeases().find((candidate) => candidate.leaseId === terminalLease.leaseId)).toMatchObject({ state: "released" });

    const missingAllocation = runtime.requestAllocation(request("missing-stop-task", "missing-stop-coord"));
    expect(missingAllocation.ok).toBe(true);
    if (!missingAllocation.ok) return;
    const missingLease = missingAllocation.allocation.leases[0];
    cap = makeRes();

    await handleOrchestrationRoutes(
      "POST",
      "/api/orchestration/leases/stop",
      cap.res,
      ctx,
      makeJsonReq({ leaseId: missingLease.leaseId }, "/api/orchestration/leases/stop"),
    );
    expect(cap.status).toBe(409);
    expect(runtime.listLeases().find((candidate) => candidate.leaseId === missingLease.leaseId)).toMatchObject({ state: "running" });

    const nonInterruptibleSession = createSession({
      engine: "mock",
      source: "web",
      sourceRef: "web:non-interruptible",
      transportMeta: {
        orchestrationLease: {
          leaseId: missingLease.leaseId,
          taskId: missingLease.taskId,
          coordinatorId: missingLease.coordinatorId,
          workerId: missingLease.workerId,
          role: missingLease.role,
          mode: "single_worker",
        },
      },
    });
    updateSession(nonInterruptibleSession.id, { status: "running" });
    ctx.sessionManager = {
      getEngine: () => ({ name: "mock", run: vi.fn() }),
      getQueue: () => ({ clearQueue: vi.fn(), getTransportState: (_key: string, status: string) => status, getPendingCount: () => 0 }),
    } as any;
    cap = makeRes();

    await handleOrchestrationRoutes(
      "POST",
      "/api/orchestration/leases/stop",
      cap.res,
      ctx,
      makeJsonReq({ leaseId: missingLease.leaseId }, "/api/orchestration/leases/stop"),
    );
    expect(cap.status).toBe(409);
    expect(runtime.listLeases().find((candidate) => candidate.leaseId === missingLease.leaseId)).toMatchObject({ state: "running" });
    runtime.close();
  });

  it("interrupts mapped running sessions when runtime lease expiry fires", async () => {
    const runtime = new OrchestrationRuntime({ config: config(), dbPath, startReaper: false });
    const allocation = runtime.requestAllocation({ ...request("expired-task", "expired-coord"), leaseDurationMs: 1 });
    expect(allocation.ok).toBe(true);
    if (!allocation.ok) return;
    const lease = allocation.allocation.leases[0];
    const session = createSession({
      engine: "mock",
      source: "web",
      sourceRef: "web:expired",
      transportMeta: {
        orchestrationLease: {
          leaseId: lease.leaseId,
          taskId: lease.taskId,
          coordinatorId: lease.coordinatorId,
          workerId: lease.workerId,
          role: lease.role,
          mode: "single_worker",
        },
      },
    });
    updateSession(session.id, { status: "running" });
    const kill = vi.fn();
    const clearQueue = vi.fn();
    const ctx = makeCtx(config());
    ctx.orchestration = { runtime };
    ctx.sessionManager = {
      getEngine: () => ({ name: "mock", run: vi.fn(), kill, isAlive: () => true, killAll: vi.fn(), killIdle: vi.fn() }),
      getQueue: () => ({ clearQueue, getTransportState: (_key: string, status: string) => status, getPendingCount: () => 0 }),
    } as any;
    runtime.setExpiredLeaseHandler((leases) => interruptExpiredOrchestrationLeaseSessions(ctx, leases));

    runtime.expireLeases(new Date(Date.parse(lease.leaseExpiresAt) + 1));
    const status = await get("/api/orchestration/status", ctx);

    expect(kill).toHaveBeenCalledWith(session.id, "Interrupted: orchestration lease expired");
    expect(clearQueue).toHaveBeenCalledWith(session.sessionKey);
    expect(getSession(session.id)).toMatchObject({ status: "interrupted", lastError: "Interrupted: orchestration lease expired" });
    expect(status.body.expiredLeaseHandling).toEqual([{
      leaseId: lease.leaseId,
      sessionId: session.id,
      status: "interrupted",
      interruptible: true,
    }]);
    runtime.close();
  });

  it("routes explicit dual-lane selection requests", async () => {
    const cap = makeRes();

    await handleOrchestrationRoutes(
      "POST",
      "/api/orchestration/dual-lane/select",
      cap.res,
      makeCtx(config()),
      makeJsonReq({ taskId: "missing-dual", coordinatorId: "missing-coord", winnerLane: "openai" }, "/api/orchestration/dual-lane/select"),
    );

    expect(cap.status).toBe(404);
    expect(cap.body).toEqual({ error: "no dual-lane run found for task missing-dual" });
  });

  it("routes per-task queue pause through the live runtime", async () => {
    const runtime = new OrchestrationRuntime({ config: config(), dbPath, startReaper: false });
    const ctx = makeCtx(config());
    ctx.orchestration = { runtime };
    const cap = makeRes();

    await handleOrchestrationRoutes(
      "POST",
      "/api/orchestration/queue/pause-task",
      cap.res,
      ctx,
      makeJsonReq({ taskId: "task-paused", coordinatorId: "coord-paused", reason: "operator" }, "/api/orchestration/queue/pause-task"),
    );

    expect(cap.status).toBe(200);
    expect(cap.body).toMatchObject({ pause: { taskId: "task-paused", coordinatorId: "coord-paused", pauseReason: "operator" } });
    expect(runtime.listTaskPauses()).toMatchObject([{ taskId: "task-paused", coordinatorId: "coord-paused" }]);
    runtime.close();
  });

  it("rejects holds when managerName does not resolve to a manager or executive", async () => {
    const runtime = new OrchestrationRuntime({ config: config(), dbPath, startReaper: false });
    const ctx = makeCtx(config());
    ctx.orchestration = { runtime };
    const cap = makeRes();

    await handleOrchestrationRoutes(
      "POST",
      "/api/orchestration/holds",
      cap.res,
      ctx,
      makeJsonReq({ managerName: "missing-manager", workerIds: ["codexSenior"], ttlMs: 60_000 }, "/api/orchestration/holds"),
    );

    expect(cap.status).toBe(403);
    expect(cap.body.error).toContain("managerName does not resolve");
    expect(runtime.listHolds({ includeInactive: true })).toEqual([]);
    runtime.close();
  });
});

async function get(pathname: string, ctx: ApiContext) {
  const cap = makeRes();
  await handleOrchestrationRoutes("GET", pathname, cap.res, ctx, makeReq("GET", pathname));
  expect(cap.status).toBe(200);
  return cap;
}

function makeReq(method: string, urlPath: string) {
  return {
    method,
    url: urlPath,
    headers: { host: "localhost", authorization: "Bearer test-gateway-token" },
  } as Parameters<typeof handleApiRequest>[0];
}

function makeJsonReq(body: unknown, url = "/api/orchestration/run", auth = true) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as NonNullable<Parameters<typeof handleOrchestrationRoutes>[4]>;
  Object.assign(req, {
    method: "POST",
    url,
    headers: {
      host: "localhost",
      "content-type": "application/json",
      ...(auth ? { authorization: "Bearer test-gateway-token" } : {}),
    },
  });
  return req;
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

function makeCtx(cfg: OrchestrationConfig, orchestrationCfg: { enabled?: boolean } = { enabled: true }): ApiContext {
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
    orchestration: orchestrationCfg,
  };
  return {
    config: liveConfig as any,
    getConfig: () => liveConfig as any,
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

function request(taskId: string, coordinatorId: string) {
  return {
    taskId,
    coordinatorId,
    requiredRoles: ["seniorImplementer"],
    optionalRoles: [],
    priority: "normal" as const,
    leaseDurationMs: 60_000,
  };
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

function sameFamilyReviewConfig(): OrchestrationConfig {
  return {
    workers: [
      {
        id: "mockImplementer",
        provider: "mock",
        family: "local",
        tier: "frontier",
        capabilities: ["repo_edit", "coding"],
        tools: ["git", "filesystem"],
        maxConcurrentTasks: 1,
        costClass: "low",
        workspacePolicy: "shared",
      },
      {
        id: "mockReviewer",
        provider: "mock",
        family: "local",
        tier: "frontier",
        capabilities: ["code_review"],
        tools: ["filesystem"],
        maxConcurrentTasks: 1,
        costClass: "low",
        workspacePolicy: "read_only",
      },
    ],
    roles: [
      {
        id: "seniorImplementer",
        requiredCapabilities: ["repo_edit", "coding"],
        requiredTools: ["git", "filesystem"],
      },
      {
        id: "independentReviewer",
        requiredCapabilities: ["code_review"],
        requiredTools: ["filesystem"],
        familyConstraint: "opposite_of_implementer",
      },
    ],
    coordinatorTemplates: [
      {
        id: "withReview",
        purpose: "implementation with review",
        requiredRoles: ["seniorImplementer", "independentReviewer"],
        optionalRoles: [],
      },
    ],
    quotas: { providers: {}, families: {} },
  };
}

function dualLaneManifest() {
  const worktree = (lane: "openai" | "anthropic"): WorktreeHandle => ({
    taskId: "dual-task",
    lane,
    path: path.join(tmpDir, "worktrees", lane),
    baseCwd: tmpDir,
    gitRoot: tmpDir,
    branch: `cuttlefish/dual-task/${lane}/1`,
    createdAt: "2026-06-24T10:00:00.000Z",
  });
  const session = (lane: "openai" | "anthropic") => ({
    sessionId: `${lane}-session`,
    leaseId: `${lane}-lease`,
    workerId: `${lane}-worker`,
    provider: lane,
    family: lane,
    model: null,
    role: `${lane}Implementer`,
    status: "completed",
    error: null,
    cwd: path.join(tmpDir, "worktrees", lane),
    workspaceMode: "implementation_worktree",
  });
  return {
    taskId: "dual-task",
    coordinatorId: "dual-coord",
    state: "selection_required",
    createdAt: "2026-06-24T10:00:00.000Z",
    updatedAt: "2026-06-24T10:01:00.000Z",
    baseCwd: tmpDir,
    promptHash: "do-not-expose",
    lanes: [
      {
        id: "openai",
        role: "openaiImplementer",
        family: "openai",
        workerId: "openai-worker",
        leaseId: "openai-lease",
        session: session("openai"),
        worktree: worktree("openai"),
      },
      {
        id: "anthropic",
        role: "anthropicImplementer",
        family: "anthropic",
        workerId: "anthropic-worker",
        leaseId: "anthropic-lease",
        session: session("anthropic"),
        worktree: worktree("anthropic"),
      },
    ],
    comparisonReport: {
      taskId: "dual-task",
      generatedAt: "2026-06-24T10:02:00.000Z",
      laneSummaries: [
        { laneId: "openai", changedFiles: ["src/a.ts"], addedLines: 2, removedLines: 0, status: "completed", error: null },
        { laneId: "anthropic", changedFiles: ["src/b.ts"], addedLines: 1, removedLines: 1, status: "completed", error: null },
      ],
      commonFiles: [],
      uniqueFiles: { openai: ["src/a.ts"], anthropic: ["src/b.ts"] },
      majorDifferences: ["Different files changed"],
    },
  };
}
