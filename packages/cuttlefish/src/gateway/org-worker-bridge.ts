import { createHash } from "node:crypto";
import type { Employee } from "../shared/types.js";
import type { CostClass, OrchestrationConfig, RoleDefinition, Worker } from "../orchestration/types.js";

export const BOARD_DISPATCH_CAPABILITY = "board_dispatch";

export interface OrgWorkerBridgeIssue {
  name: string;
  reason: "missing-name" | "missing-engine" | "duplicate-worker" | "duplicate-role";
  detail: string;
}

export interface OrgWorkerBridgeResult {
  workers: Worker[];
  roles: RoleDefinition[];
  skipped: OrgWorkerBridgeIssue[];
}

export function synthesizeOrgWorkers(registry: ReadonlyMap<string, Partial<Employee>>): OrgWorkerBridgeResult {
  const workers: Worker[] = [];
  const roles: RoleDefinition[] = [];
  const skipped: OrgWorkerBridgeIssue[] = [];
  const seenWorkerIds = new Set<string>();
  const seenRoleIds = new Set<string>();

  for (const [key, entry] of [...registry.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const name = stringValue(entry.name) ?? stringValue(key);
    if (!name) {
      skipped.push({ name: key, reason: "missing-name", detail: "skipped org record without a stable name" });
      continue;
    }
    const engine = stringValue(entry.engine);
    if (!engine) {
      skipped.push({ name, reason: "missing-engine", detail: "skipped org record without an engine" });
      continue;
    }

    const workerId = orgWorkerIdForName(name);
    const roleId = orgWorkerRoleForName(name);
    if (seenWorkerIds.has(workerId)) {
      skipped.push({ name, reason: "duplicate-worker", detail: `duplicate synthesized worker id ${workerId}` });
      continue;
    }
    if (seenRoleIds.has(roleId)) {
      skipped.push({ name, reason: "duplicate-role", detail: `duplicate synthesized role id ${roleId}` });
      continue;
    }

    seenWorkerIds.add(workerId);
    seenRoleIds.add(roleId);
    const capabilities = [
      BOARD_DISPATCH_CAPABILITY,
      exactWorkerCapability(name),
      `org_rank:${slug(entry.rank ?? "employee")}`,
      ...providedCapabilities(entry),
    ];
    workers.push({
      id: workerId,
      provider: engine,
      family: familyForEngine(engine),
      tier: stringValue(entry.rank) ?? "employee",
      capabilities: [...new Set(capabilities)],
      tools: mcpTools(entry.mcp),
      maxConcurrentTasks: 1,
      costClass: costClassForEngine(engine),
      workspacePolicy: "shared",
    });
    roles.push({
      id: roleId,
      requiredCapabilities: [BOARD_DISPATCH_CAPABILITY, exactWorkerCapability(name)],
      requiredTools: [],
      deterministicPreferred: true,
    });
  }

  return { workers, roles, skipped };
}

export function augmentOrchestrationConfigWithOrgWorkers(
  config: OrchestrationConfig,
  registry: ReadonlyMap<string, Partial<Employee>>,
): { config: OrchestrationConfig; skipped: OrgWorkerBridgeIssue[] } {
  const synthesized = synthesizeOrgWorkers(registry);
  const workerIds = new Set(config.workers.map((worker) => worker.id));
  const roleIds = new Set(config.roles.map((role) => role.id));
  const skipped = [...synthesized.skipped];
  const workers = [...config.workers];
  const roles = [...config.roles];

  for (const worker of synthesized.workers) {
    if (workerIds.has(worker.id)) {
      skipped.push({ name: worker.id, reason: "duplicate-worker", detail: `base orchestration config already defines ${worker.id}` });
      continue;
    }
    workerIds.add(worker.id);
    workers.push(worker);
  }
  for (const role of synthesized.roles) {
    if (roleIds.has(role.id)) {
      skipped.push({ name: role.id, reason: "duplicate-role", detail: `base orchestration config already defines ${role.id}` });
      continue;
    }
    roleIds.add(role.id);
    roles.push(role);
  }

  return {
    config: {
      ...config,
      workers,
      roles,
      coordinatorTemplates: [...config.coordinatorTemplates],
      quotas: {
        providers: { ...config.quotas.providers },
        families: { ...config.quotas.families },
      },
    },
    skipped,
  };
}

export function orgWorkerIdForName(name: string): string {
  return `org_worker_${identitySuffix(name)}`;
}

export function orgWorkerRoleForName(name: string): string {
  return `org_worker_role_${identitySuffix(name)}`;
}

function exactWorkerCapability(name: string): string {
  return `org_worker_exact:${identitySuffix(name)}`;
}

function identitySuffix(name: string): string {
  const normalized = name.trim();
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 10);
  return `${slug(normalized).slice(0, 40)}_${hash}`;
}

function slug(value: string): string {
  const slugged = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slugged || "unnamed";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function providedCapabilities(entry: Partial<Employee>): string[] {
  return Array.isArray(entry.provides)
    ? entry.provides
      .map((service) => stringValue(service?.name))
      .filter((name): name is string => Boolean(name))
      .map((name) => `provides:${slug(name)}`)
    : [];
}

function mcpTools(mcp: Employee["mcp"]): string[] {
  return Array.isArray(mcp) ? mcp.map((name) => `mcp:${name}`).sort() : [];
}

function familyForEngine(engine: string): string {
  switch (engine) {
    case "claude":
      return "anthropic";
    case "codex":
      return "openai";
    case "grok":
      return "xai";
    case "mock":
    case "pi":
      return "local";
    case "hermes":
      return "open";
    default:
      return engine;
  }
}

function costClassForEngine(engine: string): CostClass {
  return engine === "mock" || engine === "pi" ? "near_zero" : "medium";
}
