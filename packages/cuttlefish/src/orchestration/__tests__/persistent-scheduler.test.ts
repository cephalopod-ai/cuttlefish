import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PersistentMatrixScheduler } from "../persistent-scheduler.js";
import { OrchestrationStore } from "../store.js";
import type { AllocationRequest, OrchestrationConfig, RoleDefinition, Worker } from "../types.js";

const fixedNow = new Date("2026-06-23T12:00:00.000Z");
const afterExpiry = new Date("2026-06-23T12:00:01.000Z");

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-orch-persistent-"));
  dbPath = path.join(tmpDir, "orchestration.db");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("PersistentMatrixScheduler", () => {
  it("persists allocations and hydrates running leases across restart", () => {
    const first = PersistentMatrixScheduler.open(config(), { dbPath, now: () => fixedNow });
    const result = first.requestAllocation(request({ taskId: "task-1" }));
    expect(result.ok).toBe(true);
    first.close();

    const reopened = PersistentMatrixScheduler.open(config(), { dbPath, now: () => fixedNow });

    expect(reopened.listLeases()).toHaveLength(1);
    expect(reopened.listLeases()[0]).toMatchObject({ taskId: "task-1", state: "running" });
    expect(reopened.listAllocations()).toHaveLength(1);
    expect(reopened.listAllocations()[0]).toMatchObject({ state: "allocated", updatedAt: fixedNow.toISOString() });
    expect(reopened.validateLeaseForWorker("codexSenior", reopened.listLeases()[0].leaseId, "task-1", "coord-1")).toEqual({ ok: true });
    reopened.close();
  });

  it("serializes independently opened schedulers from the latest persisted snapshot", () => {
    const first = PersistentMatrixScheduler.open(config(), { dbPath, now: () => fixedNow, expireOnHydrate: false });
    const second = PersistentMatrixScheduler.open(config(), { dbPath, now: () => fixedNow, expireOnHydrate: false });

    expect(first.requestAllocation(request({ taskId: "task-first" })).ok).toBe(true);
    const blocked = second.requestAllocation(request({ taskId: "task-second", coordinatorId: "coord-second" }));

    expect(blocked.ok).toBe(false);
    expect(second.listLeases().filter((lease) => lease.state === "running")).toMatchObject([
      { taskId: "task-first", workerId: "codexSenior" },
    ]);
    expect(first.listQueue()).toMatchObject([{ taskId: "task-second", coordinatorId: "coord-second" }]);
    first.close();
    second.close();
  });

  // Residual-risk finding (2026-07-23 playtest, orchestration/persistent-scheduler.ts:98-112):
  // commitMutation() re-hydrates from the store on every call, inside a BEGIN
  // IMMEDIATE transaction, so its snapshot-delta write can never be computed
  // from state that's already stale relative to another writer on the same DB
  // file. This proves the round trip end to end: two independently opened
  // schedulers (simulating a second writer process) both mutate the same DB,
  // and a third, freshly opened scheduler sees BOTH mutations reconciled —
  // neither writer's delta clobbers the other's.
  it("does not lose one writer's mutation to another writer's snapshot-delta commit", () => {
    const first = PersistentMatrixScheduler.open(config(), { dbPath, now: () => fixedNow, expireOnHydrate: false });
    const second = PersistentMatrixScheduler.open(config(), { dbPath, now: () => fixedNow, expireOnHydrate: false });

    const firstAllocation = first.requestAllocation(request({ taskId: "task-first" }));
    expect(firstAllocation.ok).toBe(true);
    const queued = second.requestAllocation(request({ taskId: "task-second", coordinatorId: "coord-second" }));
    expect(queued.ok).toBe(false);

    // "second" releases the lease it never held the in-memory record for at
    // request time — it must re-hydrate "first"'s committed lease before it
    // can act on it, not operate on its own stale pre-request snapshot.
    const leaseId = firstAllocation.ok ? firstAllocation.allocation.leases[0]?.leaseId : undefined;
    expect(leaseId).toBeDefined();
    second.releaseLease(leaseId!, "coord-1");
    const retried = second.retryQueued();
    expect(retried).toHaveLength(1);
    expect(retried[0].ok).toBe(true);

    first.close();
    second.close();

    // A third writer, opened only after both prior writers closed, must see
    // both mutations reconciled: the original lease released, task-second
    // running, and nothing silently reverted or duplicated.
    const third = PersistentMatrixScheduler.open(config(), { dbPath, now: () => fixedNow, expireOnHydrate: false });
    const runningLeases = third.listLeases().filter((lease) => lease.state === "running");
    expect(runningLeases).toHaveLength(1);
    expect(runningLeases[0]).toMatchObject({ taskId: "task-second", coordinatorId: "coord-second" });
    expect(third.listQueue()).toHaveLength(0);
    third.close();
  });

  it("persists queued work and resumes it after a release across restart", () => {
    const first = PersistentMatrixScheduler.open(config(), { dbPath, now: () => fixedNow });
    const running = first.requestAllocation(request({ taskId: "task-1" }));
    expect(running.ok).toBe(true);
    first.requestAllocation(request({ taskId: "task-2", coordinatorId: "coord-2" }));
    first.close();

    const reopened = PersistentMatrixScheduler.open(config(), { dbPath, now: () => fixedNow });
    expect(reopened.listQueue()).toHaveLength(1);
    const runningLease = reopened.resolveLease({ taskId: "task-1", role: "seniorImplementer" });

    reopened.releaseLease(runningLease.leaseId, "coord-1");
    const retried = reopened.retryQueued();

    expect(retried).toHaveLength(1);
    expect(retried[0].ok).toBe(true);
    if (retried[0].ok) expect(retried[0].allocation.taskId).toBe("task-2");
    expect(reopened.listQueue()).toHaveLength(0);
    reopened.close();

    const final = PersistentMatrixScheduler.open(config(), { dbPath, now: () => fixedNow });
    expect(final.listLeases().filter((lease) => lease.state === "running").map((lease) => lease.taskId)).toEqual(["task-2"]);
    final.close();
  });

  it("expires stale leases on hydrate and frees capacity for later allocation", () => {
    const first = PersistentMatrixScheduler.open(config(), { dbPath, now: () => fixedNow });
    const result = first.requestAllocation(request({ taskId: "short", leaseDurationMs: 1_000 }));
    expect(result.ok).toBe(true);
    first.close();

    const reopened = PersistentMatrixScheduler.open(config(), { dbPath, now: () => afterExpiry });

    expect(reopened.listLeases()[0]).toMatchObject({ taskId: "short", state: "expired" });
    expect(reopened.listAllocations()[0]).toMatchObject({ taskId: "short", state: "expired" });
    const next = reopened.requestAllocation(request({ taskId: "next", coordinatorId: "coord-next" }));
    expect(next.ok).toBe(true);
    expect(reopened.listLeases().filter((lease) => lease.state === "running").map((lease) => lease.taskId)).toEqual(["next"]);
    reopened.close();
  });

  it("persists heartbeat, release, and explicit expiry mutations", () => {
    const first = PersistentMatrixScheduler.open(config(), { dbPath, now: () => fixedNow });
    const result = first.requestAllocation(request({ taskId: "task-1", leaseDurationMs: 1_000 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const leaseId = result.allocation.leases[0].leaseId;

    first.heartbeatLease(leaseId, "coord-1");
    first.expireLeases(afterExpiry);
    expect(() => first.releaseLease(leaseId, "coord-1")).toThrow(/expired/);
    first.close();

    const reopened = PersistentMatrixScheduler.open(config(), { dbPath, now: () => afterExpiry });
    expect(reopened.listLeases()[0]).toMatchObject({ leaseId, state: "expired" });
    expect(reopened.listTelemetry().map((event) => event.type)).toContain("lease_heartbeat");
    expect(reopened.listTelemetry().map((event) => event.type)).toContain("lease_expired");
    reopened.close();
  });

  it("persists terminal allocation pruning across reopen", () => {
    let now = fixedNow;
    const first = PersistentMatrixScheduler.open(config(), {
      dbPath,
      now: () => now,
      retention: { terminalAllocationRetentionMs: 500, terminalAllocationLimit: 10 },
    });
    const terminal = first.requestAllocation(request({ taskId: "terminal" }));
    expect(terminal.ok).toBe(true);
    if (!terminal.ok) return;
    first.releaseLease(terminal.allocation.leases[0].leaseId, "coord-1");

    now = new Date(fixedNow.getTime() + 1_000);
    const running = first.requestAllocation(request({ taskId: "running", coordinatorId: "coord-running" }));
    expect(running.ok).toBe(true);
    first.close();

    const reopened = PersistentMatrixScheduler.open(config(), {
      dbPath,
      now: () => now,
      retention: { terminalAllocationRetentionMs: 500, terminalAllocationLimit: 10 },
    });
    expect(reopened.listAllocations().map((allocation) => allocation.taskId)).toEqual(["running"]);
    reopened.close();
  });

  it("persists terminal lease pruning across reopen, removing orphaned lease rows", () => {
    let now = fixedNow;
    const first = PersistentMatrixScheduler.open(config(), {
      dbPath,
      now: () => now,
      retention: { terminalAllocationRetentionMs: 500, terminalAllocationLimit: 10 },
    });
    const terminal = first.requestAllocation(request({ taskId: "terminal" }));
    expect(terminal.ok).toBe(true);
    if (!terminal.ok) return;
    first.releaseLease(terminal.allocation.leases[0].leaseId, "coord-1");

    now = new Date(fixedNow.getTime() + 1_000);
    const running = first.requestAllocation(request({ taskId: "running", coordinatorId: "coord-running" }));
    expect(running.ok).toBe(true);
    expect(first.listLeases().map((lease) => lease.taskId)).toEqual(["running"]);
    first.close();

    const reopened = PersistentMatrixScheduler.open(config(), {
      dbPath,
      now: () => now,
      retention: { terminalAllocationRetentionMs: 500, terminalAllocationLimit: 10 },
    });
    expect(reopened.listAllocations().map((allocation) => allocation.taskId)).toEqual(["running"]);
    expect(reopened.listLeases().map((lease) => lease.taskId)).toEqual(["running"]);
    reopened.close();
  });

  it("rehydrates the in-memory scheduler when applySnapshotDelta throws", () => {
    const store = OrchestrationStore.open(dbPath);
    // Inject a failing applySnapshotDelta via the stored object to simulate disk failure
    const applyOrig = store.applySnapshotDelta.bind(store);
    let failCount = 0;
    store.applySnapshotDelta = (...args) => {
      if (++failCount === 2) throw new Error("simulated disk full");
      return applyOrig(...args);
    };

    const scheduler = new PersistentMatrixScheduler(config(), store, { now: () => fixedNow, expireOnHydrate: false });
    // First mutation succeeds (failCount=1)
    const first = scheduler.requestAllocation(request({ taskId: "task-ok" }));
    expect(first.ok).toBe(true);

    // Second mutation (failCount=2) triggers the throw → rehydrate branch
    expect(() => scheduler.requestAllocation(request({ taskId: "task-fail", coordinatorId: "coord-fail" }))).toThrow("simulated disk full");

    // Scheduler should still be valid and reflect persisted state (rehydrated from DB)
    expect(scheduler.listLeases().filter((l) => l.state === "running")).toHaveLength(1);
    expect(scheduler.listLeases()[0]).toMatchObject({ taskId: "task-ok", state: "running" });
    store.close();
  });

  it("does not expire leases when expireOnHydrate is false", () => {
    const first = PersistentMatrixScheduler.open(config(), { dbPath, now: () => fixedNow });
    const result = first.requestAllocation(request({ taskId: "short", leaseDurationMs: 1_000 }));
    expect(result.ok).toBe(true);
    first.close();

    // Reopen after lease would have expired, but with expireOnHydrate: false
    const reopened = PersistentMatrixScheduler.open(config(), { dbPath, now: () => afterExpiry, expireOnHydrate: false });
    // Lease is still running (not expired)
    expect(reopened.listLeases()[0]).toMatchObject({ taskId: "short", state: "running" });
    reopened.close();
  });
});

function worker(overrides: Partial<Worker> & Pick<Worker, "id" | "provider" | "family">): Worker {
  return {
    tier: "frontier",
    capabilities: ["repo_edit", "coding", "code_review", "validation"],
    tools: ["git", "filesystem", "shell"],
    maxConcurrentTasks: 1,
    costClass: "medium",
    workspacePolicy: "isolated_worktree",
    ...overrides,
  };
}

const roles: RoleDefinition[] = [
  {
    id: "seniorImplementer",
    requiredCapabilities: ["repo_edit", "coding"],
    requiredTools: ["git", "filesystem"],
    preferredTiers: ["frontier"],
  },
];

function config(): OrchestrationConfig {
  return {
    workers: [worker({ id: "codexSenior", provider: "openai", family: "openai" })],
    roles,
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
