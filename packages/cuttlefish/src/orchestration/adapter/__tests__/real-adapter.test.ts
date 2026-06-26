import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Engine, EngineResult, EngineRunOpts, InterruptibleEngine, CuttlefishConfig, StreamDelta } from "../../../shared/types.js";
import { PersistentMatrixScheduler } from "../../persistent-scheduler.js";
import { MatrixScheduler } from "../../scheduler.js";
import type { AllocationRequest, Lease, OrchestrationConfig, RoleDefinition, Worker } from "../../types.js";
import { RealProviderAdapter, createLiveProviderAdapterRegistry, runIdFor } from "../index.js";
import type { LeaseValidator, ProviderStartTaskRequest } from "../types.js";

const fixedNow = new Date("2026-06-23T14:00:00.000Z");
const cuttlefishConfig = {} as CuttlefishConfig;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-real-adapter-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("RealProviderAdapter lease and engine contract", () => {
  it("rejects invalid leases before calling the engine", async () => {
    const scheduler = new MatrixScheduler(config("codex"), { now: () => fixedNow });
    const lease = allocatedLease(scheduler);
    scheduler.releaseLease(lease.leaseId, "coord-1");
    const engine = new CompletingEngine();
    const adapter = makeAdapter("codex", engine);

    const result = await adapter.startTask(startRequest({
      worker: worker({ provider: "codex" }),
      lease,
      validateLease: matrixValidator(scheduler),
    }));

    expect(result).toMatchObject({ ok: false, error: { code: "lease_invalid", reason: "lease_released" } });
    expect(engine.run).not.toHaveBeenCalled();
  });

  it("runs with a MatrixScheduler validator and preserves the run session id for cancellation", async () => {
    const scheduler = new MatrixScheduler(config("codex"), { now: () => fixedNow });
    const lease = allocatedLease(scheduler);
    const stream: string[] = [];
    const engine = new CompletingEngine("matrix ok");
    const adapter = new RealProviderAdapter({
      id: "codex",
      engines: new Map([["codex", engine]]),
      getConfig: () => cuttlefishConfig,
      isEngineAvailable: () => true,
      now: () => fixedNow,
    });

    const result = await adapter.startTask(startRequest({
      worker: worker({ provider: "codex" }),
      lease,
      validateLease: matrixValidator(scheduler),
      run: { prompt: "hello", cwd: tmpDir, sessionId: "session-matrix", onStream: (delta) => stream.push(delta.content) },
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      runId: runIdFor("codex", lease.leaseId),
      adapterId: "codex",
      status: "completed",
      engineSessionId: "session-matrix",
    });
    expect(result.value.result?.result).toBe("matrix ok");
    expect(stream).toEqual(["matrix ok"]);
    expect(await adapter.collectArtifacts(result.value.runId)).toMatchObject({
      ok: true,
      value: [{ kind: "metadata", content: "matrix ok" }],
    });
  });

  it("runs with a PersistentMatrixScheduler validator", async () => {
    const scheduler = PersistentMatrixScheduler.open(config("grok"), {
      dbPath: path.join(tmpDir, "orchestration.db"),
      now: () => fixedNow,
    });
    const result = scheduler.requestAllocation(request());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const engine = new CompletingEngine("persistent ok");
    const adapter = makeAdapter("grok", engine);

    const start = await adapter.startTask(startRequest({
      worker: worker({ provider: "grok" }),
      lease: result.allocation.leases[0],
      validateLease: persistentValidator(scheduler),
      run: { prompt: "hello", cwd: tmpDir, sessionId: "session-persistent" },
    }));

    expect(start.ok).toBe(true);
    if (start.ok) expect(start.value.result?.result).toBe("persistent ok");
    scheduler.close();
  });

  it("rejects missing session ids and unavailable engines without calling run", async () => {
    const scheduler = new MatrixScheduler(config("pi"), { now: () => fixedNow });
    const lease = allocatedLease(scheduler);
    const engine = new CompletingEngine();
    const missingSession = await makeAdapter("pi", engine).startTask(startRequest({
      worker: worker({ provider: "pi" }),
      lease,
      validateLease: matrixValidator(scheduler),
      run: { prompt: "hello", cwd: tmpDir },
    }));
    expect(missingSession).toMatchObject({ ok: false, error: { code: "invalid_request", reason: "missing_session_id" } });

    const unavailable = new RealProviderAdapter({
      id: "pi",
      engines: new Map([["pi", engine]]),
      getConfig: () => cuttlefishConfig,
      isEngineAvailable: () => false,
    });
    const unavailableResult = await unavailable.startTask(startRequest({
      worker: worker({ provider: "pi" }),
      lease,
      validateLease: matrixValidator(scheduler),
    }));
    expect(unavailableResult).toMatchObject({ ok: false, error: { code: "engine_unavailable" } });
    expect(engine.run).not.toHaveBeenCalled();
  });

  it("maps engine result errors and thrown errors to structured engine_failed results", async () => {
    const scheduler = new MatrixScheduler(config("hermes"), { now: () => fixedNow });
    const lease = allocatedLease(scheduler);
    const failing = new CompletingEngine("ignored", "rate limit reached");
    const failed = await makeAdapter("hermes", failing).startTask(startRequest({
      worker: worker({ provider: "hermes" }),
      lease,
      validateLease: matrixValidator(scheduler),
    }));
    expect(failed).toMatchObject({
      ok: false,
      error: { code: "engine_failed", engineFailureReason: "rate_limit" },
    });

    const throwing = new ThrowingEngine("auth required");
    const thrown = await makeAdapter("hermes", throwing).startTask(startRequest({
      worker: worker({ provider: "hermes" }),
      lease,
      validateLease: matrixValidator(scheduler),
    }));
    expect(thrown).toMatchObject({
      ok: false,
      error: { code: "engine_failed", engineFailureReason: "auth_failure" },
    });
  });
});

describe("RealProviderAdapter streaming, cancellation, retention, and registry", () => {
  it("subscribes to live stream output while preserving the original onStream callback", async () => {
    const scheduler = new MatrixScheduler(config("codex"), { now: () => fixedNow });
    const lease = allocatedLease(scheduler);
    const engine = new DeferredEngine();
    const adapter = makeAdapter("codex", engine);
    const original: string[] = [];
    const subscribed: string[] = [];
    const start = adapter.startTask(startRequest({
      worker: worker({ provider: "codex" }),
      lease,
      validateLease: matrixValidator(scheduler),
      run: { prompt: "hello", cwd: tmpDir, sessionId: "stream-session", onStream: (delta) => original.push(delta.content) },
    }));
    await waitFor(() => engine.run.mock.calls.length === 1);

    const runId = runIdFor("codex", lease.leaseId);
    await expect(adapter.streamOutput(runId, (delta) => subscribed.push(delta.content))).resolves.toEqual({ ok: true, value: undefined });
    engine.emit({ type: "text", content: "live delta" });
    engine.complete({ sessionId: "native", result: "done" });
    await start;

    expect(original).toEqual(["live delta"]);
    expect(subscribed).toEqual(["live delta"]);
  });

  it("kills interruptible engines by captured session id and keeps cancelled status after late completion", async () => {
    const scheduler = new MatrixScheduler(config("claude"), { now: () => fixedNow });
    const lease = allocatedLease(scheduler);
    const engine = new DeferredEngine();
    const adapter = makeAdapter("claude", engine);
    const start = adapter.startTask(startRequest({
      worker: worker({ provider: "claude" }),
      lease,
      validateLease: matrixValidator(scheduler),
      run: { prompt: "hello", cwd: tmpDir, sessionId: "claude-session" },
    }));
    await waitFor(() => engine.run.mock.calls.length === 1);

    const runId = runIdFor("claude", lease.leaseId);
    expect(await adapter.cancel(runId, "operator-stop")).toEqual({ ok: true, value: undefined });
    expect(engine.kill).toHaveBeenCalledWith("claude-session", "operator-stop");
    engine.complete({ sessionId: "native", result: "late success" });

    const result = await start;
    expect(result).toMatchObject({ ok: true, value: { status: "cancelled", engineSessionId: "claude-session" } });
    expect(await adapter.getStatus(runId)).toEqual({ ok: true, value: "cancelled" });
  });

  it("rejects claude headless bypass flags before starting the injected engine", async () => {
    const scheduler = new MatrixScheduler(config("claude"), { now: () => fixedNow });
    const lease = allocatedLease(scheduler);
    const engine = new CompletingEngine();
    const result = await makeAdapter("claude", engine).startTask(startRequest({
      worker: worker({ provider: "claude" }),
      lease,
      validateLease: matrixValidator(scheduler),
      run: { prompt: "hello", cwd: tmpDir, sessionId: "claude-session", cliFlags: ["--print"] },
    }));

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_request", reason: "claude_headless_bypass" } });
    expect(engine.run).not.toHaveBeenCalled();
  });

  it("bounds terminal run retention without pruning active runs", async () => {
    const scheduler = new MatrixScheduler(config("codex", 2), { now: () => fixedNow });
    const engine = new CompletingEngine();
    const bounded = new RealProviderAdapter({
      id: "codex",
      engines: new Map([["codex", engine]]),
      getConfig: () => cuttlefishConfig,
      isEngineAvailable: () => true,
      maxRuns: 1,
    });
    const first = allocatedLease(scheduler, request({ taskId: "task-1" }));
    const second = allocatedLease(scheduler, request({ taskId: "task-2" }));

    const firstRun = await bounded.startTask(startRequest({ worker: worker({ provider: "codex" }), lease: first, validateLease: matrixValidator(scheduler) }));
    const secondRun = await bounded.startTask(startRequest({ worker: worker({ provider: "codex" }), lease: second, validateLease: matrixValidator(scheduler) }));
    expect(firstRun.ok && secondRun.ok).toBe(true);
    if (!firstRun.ok || !secondRun.ok) return;

    expect(await bounded.getStatus(firstRun.value.runId)).toMatchObject({ ok: false, error: { code: "unsupported_operation" } });
    expect(await bounded.getStatus(secondRun.value.runId)).toEqual({ ok: true, value: "completed" });
  });

  it("keeps the default registry inert and registers live providers only through the live factory", () => {
    const engines = new Map<string, Engine>([
      ["claude", new CompletingEngine()],
      ["codex", new CompletingEngine()],
    ]);
    const live = createLiveProviderAdapterRegistry({
      engines,
      getConfig: () => cuttlefishConfig,
      isEngineAvailable: () => true,
    });

    expect(live.listIds()).toEqual(["claude", "codex", "local_echo", "manual", "mock", "stub"]);
    expect(live.resolve("claude")).toMatchObject({ ok: true, value: { id: "claude" } });
    expect(live.resolve("openai")).toMatchObject({ ok: false, error: { code: "adapter_not_found" } });
  });
});

class CompletingEngine implements Engine {
  name = "completing";
  run = vi.fn(async (opts: EngineRunOpts): Promise<EngineResult> => {
    opts.onStream?.({ type: "text", content: this.result });
    return {
      sessionId: opts.sessionId ?? "missing-session",
      result: this.error ? "" : this.result,
      error: this.error,
      cost: 0.001,
      durationMs: 1,
      numTurns: 1,
    };
  });

  constructor(private readonly result = "real ok", private readonly error?: string) {}
}

class ThrowingEngine implements Engine {
  name = "throwing";
  run = vi.fn(async (): Promise<EngineResult> => {
    throw new Error(this.message);
  });

  constructor(private readonly message: string) {}
}

class DeferredEngine implements InterruptibleEngine {
  name = "deferred";
  lastOpts?: EngineRunOpts;
  private resolveRun?: (value: EngineResult) => void;
  run = vi.fn(async (opts: EngineRunOpts): Promise<EngineResult> => {
    this.lastOpts = opts;
    return new Promise<EngineResult>((resolve) => {
      this.resolveRun = resolve;
    });
  });
  kill = vi.fn();
  isAlive = vi.fn(() => true);
  killAll = vi.fn();
  killIdle = vi.fn();

  emit(delta: StreamDelta): void {
    this.lastOpts?.onStream?.(delta);
  }

  complete(result: EngineResult): void {
    this.resolveRun?.(result);
  }
}

function makeAdapter(id: "claude" | "codex" | "grok" | "hermes" | "pi", engine: Engine): RealProviderAdapter {
  return new RealProviderAdapter({
    id,
    engines: new Map([[id, engine]]),
    getConfig: () => cuttlefishConfig,
    isEngineAvailable: () => true,
    now: () => fixedNow,
  });
}

function worker(overrides: Partial<Worker> & Pick<Worker, "provider">): Worker {
  const { provider, ...rest } = overrides;
  return {
    id: "realWorker",
    provider,
    family: "openai",
    tier: "frontier",
    capabilities: ["repo_edit", "coding"],
    tools: ["git", "filesystem"],
    maxConcurrentTasks: 1,
    costClass: "low",
    workspacePolicy: "isolated_worktree",
    ...rest,
  };
}

const roles: RoleDefinition[] = [
  { id: "seniorImplementer", requiredCapabilities: ["repo_edit", "coding"], requiredTools: ["git", "filesystem"] },
];

function config(provider: Worker["provider"], maxConcurrentTasks = 1): OrchestrationConfig {
  return {
    workers: [worker({ provider, maxConcurrentTasks })],
    roles,
    coordinatorTemplates: [],
    quotas: { providers: {}, families: {} },
  };
}

function request(overrides: Partial<AllocationRequest> = {}): AllocationRequest {
  return {
    taskId: "task-1",
    coordinatorId: "coord-1",
    requiredRoles: ["seniorImplementer"],
    optionalRoles: [],
    priority: "normal",
    leaseDurationMs: 60 * 60 * 1000,
    ...overrides,
  };
}

function allocatedLease(scheduler: MatrixScheduler, allocationRequest = request()): Lease {
  const result = scheduler.requestAllocation(allocationRequest);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("allocation failed");
  return result.allocation.leases[0];
}

function matrixValidator(scheduler: MatrixScheduler): LeaseValidator {
  return ({ workerId, leaseId, taskId, coordinatorId }) =>
    scheduler.validateLeaseForWorker(workerId, leaseId, taskId, coordinatorId);
}

function persistentValidator(scheduler: PersistentMatrixScheduler): LeaseValidator {
  return ({ workerId, leaseId, taskId, coordinatorId }) =>
    scheduler.validateLeaseForWorker(workerId, leaseId, taskId, coordinatorId);
}

function startRequest(overrides: Partial<ProviderStartTaskRequest> & Pick<ProviderStartTaskRequest, "worker" | "lease" | "validateLease">): ProviderStartTaskRequest {
  return {
    run: { prompt: "hello", cwd: tmpDir, sessionId: "session-1" },
    ...overrides,
  };
}

async function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
