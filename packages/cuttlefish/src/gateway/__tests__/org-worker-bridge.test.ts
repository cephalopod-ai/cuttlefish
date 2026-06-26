import { describe, expect, it } from "vitest";
import type { Employee } from "../../shared/types.js";
import {
  BOARD_DISPATCH_CAPABILITY,
  augmentOrchestrationConfigWithOrgWorkers,
  orgWorkerIdForName,
  orgWorkerRoleForName,
  synthesizeOrgWorkers,
} from "../org-worker-bridge.js";
import type { OrchestrationConfig } from "../../orchestration/types.js";

describe("org worker bridge", () => {
  it("synthesizes deterministic exact workers and roles from org records", () => {
    const registry = new Map<string, Employee>([
      ["app-lead", employee({ name: "app-lead", rank: "manager", engine: "claude" })],
      ["builder", employee({ name: "builder", rank: "employee", engine: "codex", provides: [{ name: "typescript", description: "TS work" }] })],
    ]);

    const first = synthesizeOrgWorkers(registry);
    const second = synthesizeOrgWorkers(registry);

    expect(first).toEqual(second);
    expect(first.skipped).toEqual([]);
    expect(first.workers.map((worker) => worker.id)).toEqual([
      orgWorkerIdForName("app-lead"),
      orgWorkerIdForName("builder"),
    ]);
    expect(first.roles.map((role) => role.id)).toEqual([
      orgWorkerRoleForName("app-lead"),
      orgWorkerRoleForName("builder"),
    ]);
    expect(first.workers[0]).toMatchObject({
      provider: "claude",
      family: "anthropic",
      maxConcurrentTasks: 1,
      capabilities: expect.arrayContaining([BOARD_DISPATCH_CAPABILITY]),
    });
    expect(first.roles[0].requiredCapabilities).toEqual([
      BOARD_DISPATCH_CAPABILITY,
      expect.stringContaining("org_worker_exact:"),
    ]);
  });

  it("augments orchestration config without mutating the base config", () => {
    const base = baseConfig();
    const augmented = augmentOrchestrationConfigWithOrgWorkers(base, new Map([
      ["app-lead", employee({ name: "app-lead", engine: "mock" })],
    ]));

    expect(base.workers).toHaveLength(0);
    expect(base.roles).toHaveLength(0);
    expect(augmented.skipped).toEqual([]);
    expect(augmented.config.workers).toHaveLength(1);
    expect(augmented.config.roles[0].id).toBe(orgWorkerRoleForName("app-lead"));
  });

  it("skips unusable records with a visible reason", () => {
    const result = synthesizeOrgWorkers(new Map<string, Partial<Employee>>([
      ["missing-engine", { name: "missing-engine", persona: "x" }],
      ["blank-name", { name: "", engine: "mock", persona: "x" }],
    ]));

    expect(result.workers).toHaveLength(1);
    expect(result.skipped).toEqual([
      expect.objectContaining({ name: "missing-engine", reason: "missing-engine" }),
    ]);
  });
});

function employee(overrides: Partial<Employee> = {}): Employee {
  return {
    name: "worker",
    displayName: "Worker",
    department: "software-delivery",
    rank: "employee",
    engine: "mock",
    model: "mock",
    persona: "worker",
    ...overrides,
  };
}

function baseConfig(): OrchestrationConfig {
  return {
    workers: [],
    roles: [],
    coordinatorTemplates: [],
    quotas: { providers: {}, families: {} },
  };
}
