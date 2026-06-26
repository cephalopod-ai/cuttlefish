import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Engine, EngineRunOpts, EngineResult } from "../../../shared/types.js";
import { PersistentMatrixScheduler } from "../../persistent-scheduler.js";
import { MatrixScheduler } from "../../scheduler.js";
import type { AllocationRequest, Lease, OrchestrationConfig, RoleDefinition, Worker } from "../../types.js";
import {
  LocalEchoProviderAdapter,
  ManualProviderAdapter,
  StubProviderAdapter,
  createProviderAdapterRegistry,
  runIdFor,
} from "../index.js";
import type { LeaseValidator, ProviderStartTaskRequest } from "../types.js";

const fixedNow = new Date("2026-06-23T12:00:00.000Z");
const afterExpiry = new Date("2026-06-23T12:00:01.000Z");

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-orch-adapter-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("ProviderAdapter lease validation", () => {
  it.each([
    ["missing", "lease_not_found"],
    ["released", "lease_released"],
    ["expired", "lease_expired"],
    ["wrong worker", "worker_mismatch"],
    ["wrong task", "task_mismatch"],
    ["wrong coordinator", "coordinator_mismatch"],
  ])("rejects %s leases through the injected validator", async (_label, expectedReason) => {
    const scheduler = new MatrixScheduler(config(), { now: () => fixedNow });
    const lease = allocatedLease(scheduler, request({ leaseDurationMs: 1_000 }));
    if (expectedReason === "lease_released") scheduler.releaseLease(lease.leaseId, "coord-1");
    if (expectedReason === "lease_expired") scheduler.expireLeases(afterExpiry);

    const engine = new RecordingEngine();
    const adapter = new LocalEchoProviderAdapter({ engine });
    const start = startRequest({
      lease: mutateLeaseForReason(lease, expectedReason),
      worker: workerForReason(expectedReason),
      validateLease: matrixValidator(scheduler),
    });

    const result = await adapter.startTask(start);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: "lease_invalid", reason: expectedReason });
    expect(engine.run).not.toHaveBeenCalled();
  });

  it("runs local_echo with a MatrixScheduler validator", async () => {
    const scheduler = new MatrixScheduler(config(), { now: () => fixedNow });
    const lease = allocatedLease(scheduler);
    const stream: string[] = [];
    const adapter = new LocalEchoProviderAdapter({
      engine: new RecordingEngine("matrix ok"),
      now: () => fixedNow,
    });

    const result = await adapter.startTask(startRequest({
      lease,
      validateLease: matrixValidator(scheduler),
      run: { prompt: "hello", cwd: tmpDir, sessionId: "session-matrix", onStream: (delta) => stream.push(delta.content) },
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      runId: runIdFor("local_echo", lease.leaseId),
      status: "completed",
      engineSessionId: "session-matrix",
    });
    expect(result.value.result?.result).toBe("matrix ok");
    expect(stream).toEqual(["matrix ok"]);
    expect(await adapter.getStatus(result.value.runId)).toEqual({ ok: true, value: "completed" });
    expect(await adapter.collectArtifacts(result.value.runId)).toEqual({ ok: true, value: [] });
  });

  it("runs local_echo with a PersistentMatrixScheduler validator", async () => {
    const scheduler = PersistentMatrixScheduler.open(config(), {
      dbPath: path.join(tmpDir, "orchestration.db"),
      now: () => fixedNow,
    });
    const allocation = scheduler.requestAllocation(request());
    expect(allocation.ok).toBe(true);
    if (!allocation.ok) return;
    const lease = allocation.allocation.leases[0];
    const adapter = new LocalEchoProviderAdapter({ engine: new RecordingEngine("persistent ok") });

    const result = await adapter.startTask(startRequest({
      lease,
      validateLease: persistentValidator(scheduler),
      run: { prompt: "hello", cwd: tmpDir, sessionId: "session-persistent" },
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result?.result).toBe("persistent ok");
    scheduler.close();
  });
});

describe("inert provider adapters", () => {
  it("returns manual_required for a valid manual lease", async () => {
    const scheduler = new MatrixScheduler(config(), { now: () => fixedNow });
    const lease = allocatedLease(scheduler);
    const result = await new ManualProviderAdapter().startTask(startRequest({
      lease,
      validateLease: matrixValidator(scheduler),
    }));

    expect(result).toMatchObject({
      ok: false,
      error: { code: "manual_required", reason: "manual_required" },
    });
  });

  it("returns unsupported_operation for a valid stub lease", async () => {
    const scheduler = new MatrixScheduler(config(), { now: () => fixedNow });
    const lease = allocatedLease(scheduler);
    const result = await new StubProviderAdapter().startTask(startRequest({
      lease,
      validateLease: matrixValidator(scheduler),
    }));

    expect(result).toMatchObject({
      ok: false,
      error: { code: "unsupported_operation" },
    });
  });

  it("resolves only inert M2 adapters and fails closed for unknown providers", () => {
    const registry = createProviderAdapterRegistry();

    expect(registry.listIds()).toEqual(["local_echo", "manual", "mock", "stub"]);
    for (const id of registry.listIds()) {
      expect(registry.resolve(id)).toMatchObject({ ok: true, value: { id } });
    }
    expect(registry.resolve("openai")).toMatchObject({
      ok: false,
      error: { code: "adapter_not_found", reason: "openai" },
    });
  });
});

describe("orchestration import boundaries", () => {
  it("keeps scheduler core free of adapter and engine imports", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/orchestration/scheduler.ts"), "utf-8");
    const imports = source.split("\n").filter((line) => line.startsWith("import")).join("\n");

    expect(imports).not.toMatch(/adapter|engines|shared\/types|usage-status|routing-headroom|Engine/);
  });

  it("keeps adapter code free of store and persistent scheduler imports", () => {
    const adapterDir = path.join(process.cwd(), "src/orchestration/adapter");
    const source = collectSourceFiles(adapterDir)
      .map((file) => fs.readFileSync(file, "utf-8"))
      .join("\n");

    expect(source).not.toMatch(/store\.js|persistent-scheduler\.js|\.\.\/store|\.\.\/persistent-scheduler/);
  });

  it("keeps the real adapter free of concrete engine imports", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/orchestration/adapter/real-adapter.ts"), "utf-8");
    expect(source).not.toMatch(/engines\//);
    expect(source).not.toMatch(/ClaudeEngine|InteractiveClaudeEngine|CodexEngine|GrokEngine|KiroEngine|PiEngine|Hermes/);
  });

  it("keeps production runtime construction independent from opt-in live adapters", () => {
    const runtimeEntrypoints = [
      "src/orchestration/runtime.ts",
      "src/orchestration/run-mode.ts",
      "src/gateway/server.ts",
      "src/gateway/orchestration-runtime-factory.ts",
    ];
    const imports = runtimeEntrypoints
      .flatMap((entrypoint) => fs.readFileSync(path.join(process.cwd(), entrypoint), "utf-8").split("\n"))
      .filter((line) => line.startsWith("import"))
      .join("\n");

    expect(imports).not.toMatch(/createLiveProviderAdapterRegistry|RealProviderAdapter|orchestration\/adapter|\.\.?\/adapter/);
  });
});

class RecordingEngine implements Engine {
  name = "recording";
  run = vi.fn(async (opts: EngineRunOpts): Promise<EngineResult> => {
    const result = this.result;
    opts.onStream?.({ type: "text", content: result });
    return {
      sessionId: opts.sessionId ?? "recording-session",
      result,
      cost: 0.001,
      durationMs: 1,
      numTurns: 1,
    };
  });

  constructor(private readonly result = "echo ok") {}
}

function worker(overrides: Partial<Worker> & Pick<Worker, "id" | "provider" | "family">): Worker {
  return {
    tier: "frontier",
    capabilities: ["repo_edit", "coding"],
    tools: ["git", "filesystem"],
    maxConcurrentTasks: 1,
    costClass: "near_zero",
    workspacePolicy: "isolated_worktree",
    ...overrides,
  };
}

const roles: RoleDefinition[] = [
  {
    id: "seniorImplementer",
    requiredCapabilities: ["repo_edit", "coding"],
    requiredTools: ["git", "filesystem"],
  },
];

function config(): OrchestrationConfig {
  return {
    workers: [
      worker({ id: "echoWorker", provider: "local_echo", family: "local" }),
      worker({ id: "otherWorker", provider: "local_echo", family: "local" }),
    ],
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

function startRequest(overrides: Partial<ProviderStartTaskRequest> & Pick<ProviderStartTaskRequest, "lease" | "validateLease">): ProviderStartTaskRequest {
  return {
    worker: worker({ id: "echoWorker", provider: "local_echo", family: "local" }),
    run: { prompt: "hello", cwd: tmpDir, sessionId: "session-1" },
    ...overrides,
  };
}

function mutateLeaseForReason(lease: Lease, reason: string): Lease {
  if (reason === "lease_not_found") return { ...lease, leaseId: "missing-lease" };
  if (reason === "task_mismatch") return { ...lease, taskId: "other-task" };
  if (reason === "coordinator_mismatch") return { ...lease, coordinatorId: "other-coord" };
  return lease;
}

function workerForReason(reason: string): Worker {
  if (reason === "worker_mismatch") return worker({ id: "otherWorker", provider: "local_echo", family: "local" });
  return worker({ id: "echoWorker", provider: "local_echo", family: "local" });
}

function collectSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : collectSourceFiles(fullPath);
    return entry.name.endsWith(".ts") ? [fullPath] : [];
  });
}
