import { z } from "zod";
import type {
  AllocationRequest,
  CoordinatorTemplate,
  OrchestrationConfig,
  QuotaPolicy,
  RoleDefinition,
  Worker,
} from "./types.js";

const costClassSchema = z.enum(["near_zero", "low", "medium", "high"]);
const prioritySchema = z.enum(["low", "normal", "high"]);
const familyConstraintSchema = z.enum(["opposite_of_implementer", "same_as_implementer"]);
const workspacePolicySchema = z.enum(["shared", "read_only", "isolated_worktree"]);

const stringList = z.array(z.string().min(1)).default([]);

const workerBodySchema = z.object({
  provider: z.string().min(1),
  family: z.string().min(1),
  tier: z.string().min(1),
  capabilities: z.array(z.string().min(1)).min(1),
  tools: stringList,
  maxConcurrentTasks: z.number().int().positive().default(1),
  costClass: costClassSchema.default("medium"),
  workspacePolicy: workspacePolicySchema.default("shared"),
}).strict();

const roleBodySchema = z.object({
  requiredCapabilities: z.array(z.string().min(1)).min(1),
  requiredTools: stringList,
  allowedFamilies: z.array(z.string().min(1)).optional(),
  preferredTiers: z.array(z.string().min(1)).optional(),
  preferredCostClasses: z.array(costClassSchema).optional(),
  familyConstraint: familyConstraintSchema.optional(),
  deterministicPreferred: z.boolean().optional(),
}).strict();

const coordinatorBodySchema = z.object({
  purpose: z.string().min(1),
  requiredRoles: z.array(z.string().min(1)).min(1),
  optionalRoles: stringList,
}).strict();

const quotaLimitSchema = z.object({
  maxActiveLeases: z.number().int().nonnegative(),
}).strict();

export const workersFileSchema = z.object({
  workers: z.record(z.string().min(1), workerBodySchema),
}).strict();

export const rolesFileSchema = z.object({
  roles: z.record(z.string().min(1), roleBodySchema),
}).strict();

export const coordinatorsFileSchema = z.object({
  coordinatorTemplates: z.record(z.string().min(1), coordinatorBodySchema),
}).strict();

export const quotasFileSchema = z.object({
  quotas: z.object({
    providers: z.record(z.string().min(1), quotaLimitSchema).default({}),
    families: z.record(z.string().min(1), quotaLimitSchema).default({}),
  }).default({ providers: {}, families: {} }),
}).strict();

export const allocationRequestFileSchema = z.object({
  taskId: z.string().min(1),
  coordinatorId: z.string().min(1),
  coordinatorTemplate: z.string().min(1).optional(),
  template: z.string().min(1).optional(),
  requiredRoles: z.array(z.string().min(1)).optional(),
  optionalRoles: z.array(z.string().min(1)).optional(),
  allowedWorkerIds: z.array(z.string().min(1)).optional(),
  priority: prioritySchema.default("normal"),
  leaseDurationMs: z.number().int().positive().default(60 * 60 * 1000),
}).strict();

export const simulationScenarioSchema = z.object({
  name: z.string().min(1).optional(),
  steps: z.array(z.union([
    z.object({ allocate: allocationRequestFileSchema }).strict(),
    z.object({
      release: z.object({
        leaseId: z.string().min(1).optional(),
        taskId: z.string().min(1).optional(),
        role: z.string().min(1).optional(),
        workerId: z.string().min(1).optional(),
      }).strict(),
    }).strict(),
    z.object({
      heartbeat: z.object({
        leaseId: z.string().min(1),
      }).strict(),
    }).strict(),
    z.object({
      expire: z.object({
        now: z.string().datetime(),
      }).strict(),
    }).strict(),
  ])).min(1),
}).strict();

export function parseWorkers(value: unknown): Worker[] {
  const parsed = workersFileSchema.parse(value);
  return Object.entries(parsed.workers).map(([id, worker]) => ({ id, ...worker }));
}

export function parseRoles(value: unknown): RoleDefinition[] {
  const parsed = rolesFileSchema.parse(value);
  return Object.entries(parsed.roles).map(([id, role]) => ({ id, ...role }));
}

export function parseCoordinatorTemplates(value: unknown): CoordinatorTemplate[] {
  const parsed = coordinatorsFileSchema.parse(value);
  return Object.entries(parsed.coordinatorTemplates).map(([id, template]) => ({ id, ...template }));
}

export function parseQuotaPolicy(value: unknown): QuotaPolicy {
  return quotasFileSchema.parse(value).quotas;
}

export function emptyQuotaPolicy(): QuotaPolicy {
  return { providers: {}, families: {} };
}

export function buildAllocationRequest(
  value: unknown,
  config: Pick<OrchestrationConfig, "coordinatorTemplates">,
): AllocationRequest {
  const parsed = allocationRequestFileSchema.parse(value);
  const coordinatorTemplate = parsed.coordinatorTemplate ?? parsed.template;
  const template = coordinatorTemplate
    ? config.coordinatorTemplates.find((candidate) => candidate.id === coordinatorTemplate)
    : undefined;
  const requiredRoles = parsed.requiredRoles ?? template?.requiredRoles;
  if (!requiredRoles || requiredRoles.length === 0) {
    throw new Error("allocation request must provide requiredRoles or a known coordinatorTemplate");
  }
  return {
    taskId: parsed.taskId,
    coordinatorId: parsed.coordinatorId,
    coordinatorTemplate,
    requiredRoles,
    optionalRoles: parsed.optionalRoles ?? template?.optionalRoles ?? [],
    allowedWorkerIds: parsed.allowedWorkerIds,
    priority: parsed.priority,
    leaseDurationMs: parsed.leaseDurationMs,
  };
}

export function formatZodError(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues.map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`).join("; ");
  }
  return err instanceof Error ? err.message : String(err);
}
