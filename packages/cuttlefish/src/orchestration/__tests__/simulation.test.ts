import { describe, expect, it } from "vitest";
import { simulateScenario } from "../simulation.js";
import type { OrchestrationConfig, AllocationRequest } from "../types.js";
const config: OrchestrationConfig = {
  workers: [{ id: "worker", provider: "fixture", family: "fixture", tier: "local", capabilities: ["read"], tools: [], maxConcurrentTasks: 1, costClass: "near_zero", workspacePolicy: "read_only" }],
  roles: [{ id: "reader", requiredCapabilities: ["read"], requiredTools: [] }],
  coordinatorTemplates: [], quotas: { providers: {}, families: {} },
};
const request: AllocationRequest = { taskId: "task", coordinatorId: "coord", requiredRoles: ["reader"], optionalRoles: [], priority: "normal", leaseDurationMs: 1000 };
describe("public simulation clock", () => {
  it("replays identically with no wall-clock timestamps", () => {
    const scenario = { steps: [{ allocate: request }, { release: { taskId: "task" } }] };
    const first = simulateScenario(config, scenario);
    expect(simulateScenario(config, scenario)).toEqual(first);
    expect(first.leases[0].startedAt).toBe("1970-01-01T00:00:00.000Z");
    expect(first.leases[0].state).toBe("released");
  });
  it("advances the clock for expiry, retry and later allocation", () => {
    const result = simulateScenario(config, { startTime: "2026-01-01T00:00:00Z", steps: [
      { allocate: request }, { expire: { now: "2026-01-01T00:00:02Z" } },
      { allocate: { ...request, taskId: "later" } },
    ] });
    expect(result.steps.map((step) => step.step)).toEqual([1, 2, 3]);
    expect(result.leases.find((lease) => lease.taskId === "later")?.startedAt).toBe("2026-01-01T00:00:02.000Z");
  });
  it("rejects backwards time and retains unknown-lease refusals", () => {
    expect(() => simulateScenario(config, { startTime: "2026-01-01T00:00:00Z", steps: [{ expire: { now: "2025-01-01T00:00:00Z" } }] })).toThrow("cannot move backwards");
    expect(() => simulateScenario(config, { steps: [{ heartbeat: { leaseId: "missing" } }] })).toThrow("unknown lease");
  });
});
