import fs from "node:fs";
import { EXECUTION_TIERS, type Employee, type EmployeeExecutionConfig } from "../shared/types.js";
import { isActiveEmployee, RESERVED_ORG_DIRS } from "./org.js";
import { HR_EMPLOYEE_NAME } from "./org-policy.js";

interface ServiceSummary {
  name: string;
  description: string;
}

/**
 * The department list the org UI shows: every department directory under
 * `orgDir` (skipping HR/Org-Steward reserved dirs), unioned with every
 * department name any active employee in `registry` claims — an employee's
 * YAML can carry a `department` field the on-disk directory layout hasn't
 * caught up to yet. Domain logic moved out of the `/api/org` route handler,
 * which previously did the `fs.readdirSync` scan and this dedup inline in
 * violation of this repo's own router-file contract (AGENTS.md) — see ARC-001.
 */
export function listOrgDepartments(orgDir: string, registry: Map<string, Employee>): { directoryDepartments: string[]; departments: string[] } {
  if (!fs.existsSync(orgDir)) return { directoryDepartments: [], departments: [] };
  const entries = fs.readdirSync(orgDir, { withFileTypes: true });
  const directoryDepartments = entries
    .filter((entry) => entry.isDirectory() && !RESERVED_ORG_DIRS.has(entry.name))
    .map((entry) => entry.name);
  const departments = [
    ...new Set([
      ...directoryDepartments,
      ...[...registry.values()]
        .map((employee) => employee.department.trim())
        .filter(Boolean),
    ]),
  ];
  return { directoryDepartments, departments };
}

/** Effective execution config — applies V1 defaults for absent fields. */
export function effectiveExecution(emp: Employee): EmployeeExecutionConfig {
  return emp.execution ?? { tier: "solo" };
}

export interface ExecutionProfileSummary {
  tier: "solo" | "mid_pair";
  label: string;
  reviewerLossPolicy?: string;
  reviewerToolProfile?: string;
  hasCustomRoleOverrides: boolean;
}

export function computeExecutionProfileSummary(emp: Employee): ExecutionProfileSummary {
  const exec = effectiveExecution(emp);
  const tier = (EXECUTION_TIERS as readonly string[]).includes(exec.tier) ? exec.tier : "solo";
  return {
    tier,
    label: tier === "mid_pair" ? "Built-in review" : "Solo",
    reviewerLossPolicy: exec.reviewerLossPolicy,
    reviewerToolProfile: exec.reviewerToolProfile,
    hasCustomRoleOverrides: !!(exec.roles?.implementer || exec.roles?.reviewer),
  };
}

export interface OrgServiceSummary extends ServiceSummary {
  provider: {
    name: string;
    displayName: string;
    department: string;
    rank: Employee["rank"];
  };
}

export const SERVICE_RANK_PRIORITY: Record<Employee["rank"], number> = {
  executive: 0,
  manager: 1,
  senior: 2,
  employee: 3,
};

function employeeProvidesServices(employee: Employee): employee is Employee & { provides: ServiceSummary[] } {
  return employee.name !== HR_EMPLOYEE_NAME && isActiveEmployee(employee) && Array.isArray(employee.provides);
}

function servicePriority(employee: Employee): number {
  return SERVICE_RANK_PRIORITY[employee.rank];
}

function providerWins(candidate: Employee, current: Employee): boolean {
  const candidatePriority = servicePriority(candidate);
  const currentPriority = servicePriority(current);
  return candidatePriority < currentPriority ||
    (candidatePriority === currentPriority && candidate.name.localeCompare(current.name) < 0);
}

export function buildOrgServices(registry: Map<string, Employee>): OrgServiceSummary[] {
  const services = new Map<string, { summary: OrgServiceSummary; employee: Employee }>();
  for (const employee of registry.values()) {
    if (!employeeProvidesServices(employee)) continue;
    for (const service of employee.provides) {
      const key = service.name.trim().toLowerCase();
      if (!key) continue;
      const summary: OrgServiceSummary = {
        name: service.name.trim(),
        description: service.description.trim(),
        provider: {
          name: employee.name,
          displayName: employee.displayName,
          department: employee.department,
          rank: employee.rank,
        },
      };
      const current = services.get(key);
      if (!current || providerWins(employee, current.employee)) {
        services.set(key, { summary, employee });
      }
    }
  }
  return [...services.values()].map((entry) => entry.summary).sort((a, b) => a.name.localeCompare(b.name));
}

export function findServiceProvider(
  registry: Map<string, Employee>,
  serviceName: string,
): { employee: Employee; service: ServiceSummary } | null {
  const key = serviceName.trim().toLowerCase();
  if (!key) return null;
  let best: { employee: Employee; service: ServiceSummary } | null = null;
  for (const employee of registry.values()) {
    if (!employeeProvidesServices(employee)) continue;
    for (const service of employee.provides) {
      if (service.name.trim().toLowerCase() !== key) continue;
      const candidate = { employee, service: { name: service.name.trim(), description: service.description.trim() } };
      if (!best || providerWins(employee, best.employee)) best = candidate;
    }
  }
  return best;
}

export function buildCrossRequestBrief(input: {
  requester: Employee;
  service: ServiceSummary;
  prompt: string;
}): string {
  return [
    "## Cross-service request",
    "",
    `**From**: ${input.requester.displayName} (${input.requester.department})`,
    `**Service**: ${input.service.name} - ${input.service.description}`,
    "",
    "### Request",
    input.prompt,
    "",
    "---",
    "Handle this as a priority request from a colleague.",
  ].join("\n");
}
