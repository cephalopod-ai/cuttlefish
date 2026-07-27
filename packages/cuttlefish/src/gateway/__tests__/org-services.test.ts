import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCrossRequestBrief, buildOrgServices, computeExecutionProfileSummary, findServiceProvider, listOrgDepartments } from "../org-services.js";
import type { Employee } from "../../shared/types.js";

function employee(overrides: Partial<Employee>): Employee {
  return {
    name: "worker",
    displayName: "Worker",
    department: "engineering",
    rank: "employee",
    engine: "claude",
    model: "opus",
    persona: "Work.",
    ...overrides,
  } as Employee;
}

describe("org service discovery", () => {
  it("chooses the highest-rank active provider with a deterministic tie-break", () => {
    const registry = new Map<string, Employee>([
      ["z-senior", employee({ name: "z-senior", displayName: "Z Senior", rank: "senior", provides: [{ name: "Security", description: "Senior security" }] })],
      ["a-manager", employee({ name: "a-manager", displayName: "A Manager", rank: "manager", provides: [{ name: "Security", description: "Manager security" }] })],
      ["b-manager", employee({ name: "b-manager", displayName: "B Manager", rank: "manager", provides: [{ name: "Security", description: "Other manager" }] })],
      ["inactive-exec", employee({ name: "inactive-exec", rank: "executive", lifecycle: "disabled", provides: [{ name: "Security", description: "Inactive" }] })],
    ]);

    expect(buildOrgServices(registry)).toEqual([
      expect.objectContaining({
        name: "Security",
        description: "Manager security",
        provider: expect.objectContaining({ name: "a-manager", rank: "manager" }),
      }),
    ]);
    expect(findServiceProvider(registry, "security")?.employee.name).toBe("a-manager");
  });

  it("builds a source-grounded cross-service brief", () => {
    expect(buildCrossRequestBrief({
      requester: employee({ name: "requester", displayName: "Requester", department: "ops" }),
      service: { name: "Security", description: "Threat review" },
      prompt: "Review auth.",
    })).toContain("**From**: Requester (ops)\n**Service**: Security - Threat review");
  });
});

// Moved out of gateway/api/routes/org.ts (ARC-001): a router file must not
// host business rules or raw fs directory scans, per this repo's own AGENTS.md
// router contract.
describe("listOrgDepartments", () => {
  it("unions on-disk department directories with department fields the registry claims, skipping reserved dirs", () => {
    const orgDir = fs.mkdtempSync(path.join(os.tmpdir(), "org-services-departments-"));
    try {
      fs.mkdirSync(path.join(orgDir, "engineering"));
      fs.mkdirSync(path.join(orgDir, "_drafts"));
      const registry = new Map<string, Employee>([
        ["a", employee({ name: "a", department: "engineering" })],
        // An employee whose explicit `department` field names a department
        // the directory layout hasn't caught up to yet (e.g. mid-rename).
        ["b", employee({ name: "b", department: "sales" })],
      ]);

      const { directoryDepartments, departments } = listOrgDepartments(orgDir, registry);

      expect(directoryDepartments).toEqual(["engineering"]);
      expect(departments.sort()).toEqual(["engineering", "sales"]);
    } finally {
      fs.rmSync(orgDir, { recursive: true, force: true });
    }
  });

  it("returns empty lists when orgDir does not exist", () => {
    expect(listOrgDepartments(path.join(os.tmpdir(), "does-not-exist-org-dir"), new Map())).toEqual({
      directoryDepartments: [],
      departments: [],
    });
  });
});

describe("computeExecutionProfileSummary", () => {
  it("defaults to solo when execution is absent", () => {
    expect(computeExecutionProfileSummary(employee({}))).toMatchObject({
      tier: "solo",
      label: "Solo",
      hasCustomRoleOverrides: false,
    });
  });

  it("reflects a configured mid_pair tier and custom role overrides", () => {
    const summary = computeExecutionProfileSummary(employee({
      execution: { tier: "mid_pair", roles: { reviewer: { override: { engine: "codex" } } } },
    }));
    expect(summary).toMatchObject({ tier: "mid_pair", label: "Built-in review", hasCustomRoleOverrides: true });
  });
});
