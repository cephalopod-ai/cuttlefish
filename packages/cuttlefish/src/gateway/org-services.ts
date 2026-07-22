import type { Employee } from "../shared/types.js";
import { isActiveEmployee } from "./org.js";
import { HR_EMPLOYEE_NAME } from "./org-policy.js";

interface ServiceSummary {
  name: string;
  description: string;
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
