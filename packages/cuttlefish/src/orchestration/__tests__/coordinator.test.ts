import { describe, expect, it } from "vitest";
import { buildCoordinatorTaskBrief, planCoordinatorAllocation } from "../coordinator.js";
import type { OrchestrationConfig } from "../types.js";

describe("coordinator allocation planning", () => {
  it("expands a coordinator template into a matrix allocation request", () => {
    const brief = buildCoordinatorTaskBrief({
      taskId: "task-1",
      coordinatorId: "coord-1",
      coordinatorTemplate: "standardImplementation",
    }, config());

    expect(brief.mode).toBe("matrix");
    expect(brief.request.requiredRoles).toEqual(["seniorImplementer", "independentReviewer"]);
    expect(brief.request.optionalRoles).toEqual(["qaGate"]);
  });

  it("plans single_worker with only the implementer role", () => {
    const brief = buildCoordinatorTaskBrief({
      taskId: "task-1",
      coordinatorId: "coord-1",
      coordinatorTemplate: "standardImplementation",
      mode: "single_worker",
    }, config());
    const plan = planCoordinatorAllocation(brief, config());

    expect(brief.request.requiredRoles).toEqual(["seniorImplementer"]);
    expect(plan.summary).toMatchObject({ state: "allocated", allocatedRoles: ["seniorImplementer"] });
  });

  it("plans single_worker_with_review with implementer and reviewer roles only", () => {
    const brief = buildCoordinatorTaskBrief({
      taskId: "task-1",
      coordinatorId: "coord-1",
      coordinatorTemplate: "standardImplementation",
      mode: "single_worker_with_review",
    }, config());
    const plan = planCoordinatorAllocation(brief, config());

    expect(brief.request.requiredRoles).toEqual(["seniorImplementer", "independentReviewer"]);
    expect(plan.summary).toMatchObject({
      state: "allocated",
      allocatedRoles: ["seniorImplementer", "independentReviewer"],
    });
  });

  it("explains blocked plans without executing providers", () => {
    const cfg = config({ reviewerFamily: "openai" });
    const brief = buildCoordinatorTaskBrief({
      taskId: "task-1",
      coordinatorId: "coord-1",
      coordinatorTemplate: "standardImplementation",
      mode: "single_worker_with_review",
    }, cfg);
    const plan = planCoordinatorAllocation(brief, cfg);

    expect(plan.result.ok).toBe(false);
    expect(plan.summary).toMatchObject({
      state: "blocked_resource",
      missingRoles: ["independentReviewer"],
      resumeOn: ["worker_released", "quota_available", "lease_expired"],
    });
  });

  it("plans architecture mode with all required semantic roles", () => {
    const brief = buildCoordinatorTaskBrief({
      taskId: "task-arch",
      coordinatorId: "coord-arch",
      coordinatorTemplate: "architectureChange",
      mode: "architecture",
    }, config());

    expect(brief.request.requiredRoles).toEqual([
      "architect",
      "seniorImplementer",
      "independentReviewer",
      "adversarialReviewer",
      "qaGate",
    ]);
    expect(brief.request.optionalRoles).toEqual([]);
  });

  it("rejects architecture mode when a semantic role is missing", () => {
    expect(() => buildCoordinatorTaskBrief({
      taskId: "task-arch",
      coordinatorId: "coord-arch",
      coordinatorTemplate: "standardImplementation",
      mode: "architecture",
    }, config())).toThrow("architecture mode requires architect, implementer, independent reviewer, adversarial reviewer, and QA roles");
  });

  it("restricts local_heavy mode to low-cost non-editing workers", () => {
    const brief = buildCoordinatorTaskBrief({
      taskId: "task-local",
      coordinatorId: "coord-local",
      coordinatorTemplate: "localTriage",
      mode: "local_heavy",
    }, config());
    const plan = planCoordinatorAllocation(brief, config());

    expect(brief.request.requiredRoles).toEqual(["triage", "qaGate"]);
    expect(brief.request.allowedWorkerIds).toEqual(["localQa", "localTriage"]);
    expect(plan.summary).toMatchObject({ state: "allocated", allocatedRoles: ["triage", "qaGate"] });
    expect(plan.result.ok && plan.result.allocation.leases.map((lease) => lease.workerId).sort()).toEqual(["localQa", "localTriage"]);
  });

  it("rejects editing roles in local_heavy mode", () => {
    expect(() => buildCoordinatorTaskBrief({
      taskId: "task-local",
      coordinatorId: "coord-local",
      coordinatorTemplate: "standardImplementation",
      mode: "local_heavy",
    }, config())).toThrow("local_heavy mode cannot allocate editing role seniorImplementer");
  });
});

function config(opts: { reviewerFamily?: string } = {}): OrchestrationConfig {
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
      {
        id: "reviewer",
        provider: opts.reviewerFamily === "openai" ? "openai" : "anthropic",
        family: opts.reviewerFamily ?? "anthropic",
        tier: "small",
        capabilities: ["code_review"],
        tools: ["filesystem"],
        maxConcurrentTasks: 1,
        costClass: "low",
        workspacePolicy: "read_only",
      },
      {
        id: "localQa",
        provider: "ollama",
        family: "local",
        tier: "local",
        capabilities: ["validation"],
        tools: ["shell"],
        maxConcurrentTasks: 1,
        costClass: "near_zero",
        workspacePolicy: "shared",
      },
      {
        id: "localTriage",
        provider: "ollama",
        family: "local",
        tier: "local",
        capabilities: ["triage"],
        tools: ["filesystem"],
        maxConcurrentTasks: 1,
        costClass: "near_zero",
        workspacePolicy: "read_only",
      },
    ],
    roles: [
      {
        id: "architect",
        requiredCapabilities: ["architecture"],
        requiredTools: ["filesystem"],
      },
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
      {
        id: "qaGate",
        requiredCapabilities: ["validation"],
        requiredTools: ["shell"],
      },
      {
        id: "adversarialReviewer",
        requiredCapabilities: ["adversarial_review"],
        requiredTools: ["filesystem"],
      },
      {
        id: "triage",
        requiredCapabilities: ["triage"],
        requiredTools: ["filesystem"],
      },
    ],
    coordinatorTemplates: [
      {
        id: "standardImplementation",
        purpose: "feature work",
        requiredRoles: ["seniorImplementer", "independentReviewer"],
        optionalRoles: ["qaGate"],
      },
      {
        id: "architectureChange",
        purpose: "self-referential architecture work",
        requiredRoles: ["architect", "seniorImplementer", "independentReviewer", "adversarialReviewer", "qaGate"],
        optionalRoles: [],
      },
      {
        id: "localTriage",
        purpose: "local heavy triage",
        requiredRoles: ["triage"],
        optionalRoles: ["qaGate"],
      },
    ],
    quotas: { providers: {}, families: {} },
  };
}
