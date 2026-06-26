import fs from "node:fs";
import yaml from "js-yaml";
import { z } from "zod";
import { MatrixScheduler } from "./scheduler.js";
import { allocationRequestFileSchema, buildAllocationRequest } from "./schemas.js";
import type {
  AllocationRequest,
  AllocationResult,
  OrchestrationConfig,
  RoleDefinition,
  SchedulerSnapshot,
  Worker,
} from "./types.js";

export const coordinatorModeSchema = z.enum(["matrix", "single_worker", "single_worker_with_review", "architecture", "local_heavy"]);
export type CoordinatorMode = z.infer<typeof coordinatorModeSchema>;

export const coordinatorTaskBriefSchema = allocationRequestFileSchema.extend({
  mode: coordinatorModeSchema.default("matrix"),
});

export interface CoordinatorTaskBrief {
  mode: CoordinatorMode;
  request: AllocationRequest;
}

export interface CoordinatorPlanSummary {
  state: "allocated" | "blocked_resource";
  allocatedRoles: string[];
  missingRoles: string[];
  optionalRolesSkipped: string[];
  resumeOn: Array<"worker_released" | "quota_available" | "lease_expired">;
}

export interface CoordinatorAllocationPlan {
  mode: CoordinatorMode;
  request: AllocationRequest;
  result: AllocationResult;
  summary: CoordinatorPlanSummary;
}

export interface CoordinatorPlanOptions {
  snapshot?: SchedulerSnapshot;
  now?: () => Date;
}

export function loadCoordinatorTaskBrief(filePath: string, config: OrchestrationConfig): CoordinatorTaskBrief {
  let value: unknown;
  try {
    value = yaml.load(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    throw new Error(`failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return buildCoordinatorTaskBrief(value, config);
}

export function buildCoordinatorTaskBrief(value: unknown, config: OrchestrationConfig): CoordinatorTaskBrief {
  const parsed = coordinatorTaskBriefSchema.parse(value);
  const { mode, ...allocationInput } = parsed;
  const request = applyMode(buildAllocationRequest(allocationInput, config), mode, config);
  return { mode, request };
}

export function planCoordinatorAllocation(
  brief: CoordinatorTaskBrief,
  config: OrchestrationConfig,
  opts: CoordinatorPlanOptions = {},
): CoordinatorAllocationPlan {
  const scheduler = new MatrixScheduler(config, { snapshot: opts.snapshot, now: opts.now });
  const result = scheduler.requestAllocation(brief.request);
  return {
    mode: brief.mode,
    request: brief.request,
    result,
    summary: summarizePlan(result),
  };
}

function applyMode(
  request: AllocationRequest,
  mode: CoordinatorMode,
  config: OrchestrationConfig,
): AllocationRequest {
  if (mode === "matrix") return request;

  const roles = config.roles;
  const orderedRoles = [...request.requiredRoles, ...request.optionalRoles];
  const implementer = orderedRoles.find((roleId) => isImplementer(roleId, roleById(roles, roleId))) ?? request.requiredRoles[0];
  if (!implementer) throw new Error(`${mode} requires at least one implementer role`);

  if (mode === "single_worker") {
    return { ...request, requiredRoles: [implementer], optionalRoles: [] };
  }

  if (mode === "single_worker_with_review") {
    const reviewer = orderedRoles.find((roleId) => roleId !== implementer && isReviewer(roleId, roleById(roles, roleId)));
    if (!reviewer) throw new Error("single_worker_with_review requires a reviewer role in the coordinator template");
    return { ...request, requiredRoles: [implementer, reviewer], optionalRoles: [] };
  }

  if (mode === "architecture") return architectureRequest(request, config, implementer);
  return localHeavyRequest(request, config);
}

function summarizePlan(result: AllocationResult): CoordinatorPlanSummary {
  if (!result.ok) {
    return {
      state: "blocked_resource",
      allocatedRoles: [],
      missingRoles: [...result.queueItem.missingRoles],
      optionalRolesSkipped: [],
      resumeOn: [...result.queueItem.resumeOn],
    };
  }
  return {
    state: "allocated",
    allocatedRoles: result.allocation.leases.map((lease) => lease.role),
    missingRoles: [],
    optionalRolesSkipped: [...result.allocation.optionalRolesSkipped],
    resumeOn: [],
  };
}

function roleById(roles: RoleDefinition[], roleId: string): RoleDefinition | undefined {
  return roles.find((role) => role.id === roleId);
}

function isImplementer(roleId: string, role: RoleDefinition | undefined): boolean {
  if (roleId.toLowerCase().includes("implementer")) return true;
  if (!role) return false;
  return role.requiredCapabilities.includes("repo_edit") || role.requiredCapabilities.includes("coding");
}

function isReviewer(roleId: string, role: RoleDefinition | undefined): boolean {
  if (roleId.toLowerCase().includes("review")) return true;
  if (!role) return false;
  return role.requiredCapabilities.includes("code_review") || role.familyConstraint === "opposite_of_implementer";
}

function architectureRequest(
  request: AllocationRequest,
  config: OrchestrationConfig,
  implementer: string,
): AllocationRequest {
  const orderedRoles = [...request.requiredRoles, ...request.optionalRoles];
  const architect = orderedRoles.find((roleId) => isArchitect(roleId, roleById(config.roles, roleId)));
  const independentReviewer = orderedRoles.find((roleId) => (
    roleId !== implementer
    && isIndependentReviewer(roleId, roleById(config.roles, roleId))
  ));
  const adversarialReviewer = orderedRoles.find((roleId) => (
    roleId !== implementer
    && roleId !== independentReviewer
    && isAdversarialReviewer(roleId, roleById(config.roles, roleId))
  ));
  const qa = orderedRoles.find((roleId) => isQa(roleId, roleById(config.roles, roleId)));
  if (!architect || !implementer || !independentReviewer || !adversarialReviewer || !qa) {
    throw new Error("architecture mode requires architect, implementer, independent reviewer, adversarial reviewer, and QA roles");
  }
  return {
    ...request,
    requiredRoles: [architect, implementer, independentReviewer, adversarialReviewer, qa],
    optionalRoles: [],
  };
}

function localHeavyRequest(request: AllocationRequest, config: OrchestrationConfig): AllocationRequest {
  const selectedRoles: string[] = [];
  const allowedWorkerIds = new Set<string>();
  for (const roleId of [...request.requiredRoles, ...request.optionalRoles]) {
    const role = roleById(config.roles, roleId);
    if (!role) throw new Error(`local_heavy mode references unknown role ${roleId}`);
    if (isEditingRole(role)) throw new Error(`local_heavy mode cannot allocate editing role ${roleId}`);
    const workers = config.workers.filter((worker) => isLocalHeavyWorker(worker, role));
    if (workers.length === 0) throw new Error(`local_heavy mode has no local/low-cost worker for role ${roleId}`);
    selectedRoles.push(roleId);
    workers.forEach((worker) => allowedWorkerIds.add(worker.id));
  }
  if (selectedRoles.length === 0) throw new Error("local_heavy mode requires at least one non-editing local/low-cost role");
  return {
    ...request,
    requiredRoles: selectedRoles,
    optionalRoles: [],
    allowedWorkerIds: [...allowedWorkerIds].sort(),
  };
}

function isArchitect(roleId: string, role: RoleDefinition | undefined): boolean {
  const lower = roleId.toLowerCase();
  if (lower.includes("architect")) return true;
  return Boolean(role?.requiredCapabilities.some((capability) => capability === "architecture" || capability === "system_design"));
}

function isIndependentReviewer(roleId: string, role: RoleDefinition | undefined): boolean {
  const lower = roleId.toLowerCase();
  if (lower.includes("adversarial")) return false;
  if (lower.includes("independent") && lower.includes("review")) return true;
  return isReviewer(roleId, role);
}

function isAdversarialReviewer(roleId: string, role: RoleDefinition | undefined): boolean {
  const lower = roleId.toLowerCase();
  if (lower.includes("adversarial")) return true;
  return Boolean(role?.requiredCapabilities.some((capability) => capability === "adversarial_review" || capability === "bug_hunt"));
}

function isQa(roleId: string, role: RoleDefinition | undefined): boolean {
  const lower = roleId.toLowerCase();
  if (lower === "qa" || lower.includes("qa")) return true;
  return Boolean(role?.requiredCapabilities.some((capability) => capability === "validation" || capability === "test_log_triage"));
}

function isEditingRole(role: RoleDefinition): boolean {
  return role.requiredCapabilities.includes("repo_edit") || role.requiredCapabilities.includes("coding");
}

function isLocalHeavyWorker(worker: Worker, role: RoleDefinition): boolean {
  const costOk = worker.family === "local" || worker.costClass === "near_zero" || worker.costClass === "low";
  if (!costOk) return false;
  if (role.allowedFamilies && !role.allowedFamilies.includes(worker.family)) return false;
  if (role.requiredCapabilities.some((capability) => !worker.capabilities.includes(capability))) return false;
  if (role.requiredTools.some((tool) => !worker.tools.includes(tool))) return false;
  return true;
}
