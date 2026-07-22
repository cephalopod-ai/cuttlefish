import { describe, expect, it } from "vitest";
import { buildCrossRequestBrief, buildOrgServices, findServiceProvider } from "../org-services.js";
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
