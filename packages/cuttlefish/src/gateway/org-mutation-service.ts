import fs from "node:fs";
import path from "node:path";
import { ORG_DIR } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import { listSessions } from "../sessions/registry.js";
import type { GatewayPrincipal } from "./auth.js";
import type { ApiContext } from "./api/context.js";
import {
  BoardConflictError,
  readBoardState,
  validateBoardAssigneesForDepartment,
  writeMergedBoardPartial,
} from "./board-service.js";
import { deleteEmployeeWithBoardCleanup } from "./lifecycle-delete.js";
import {
  authorizeManagerScope,
  disallowedManagerScopedFields,
  isManagerNameAuthorizedForPrincipal,
  MANAGER_MUTABLE_EMPLOYEE_FIELDS,
} from "./manager-auth.js";
import { scanOrg } from "./org.js";
import { parseChangeInput } from "./org-validation.js";

export interface OrgMutationResult {
  statusCode: number;
  body: Record<string, unknown>;
}

const notFound = (): OrgMutationResult => ({ statusCode: 404, body: { error: "Not found" } });

export async function createOrgEmployee(
  body: Record<string, unknown>,
  context: ApiContext,
): Promise<OrgMutationResult> {
  const { createEmployeeYaml, validateEmployeeCreate } = await import("./org.js");
  const registry = scanOrg();
  const result = validateEmployeeCreate(context.getConfig(), body, registry.keys());
  if (!result.ok || !result.employee) {
    return { statusCode: 400, body: { error: result.error || "invalid employee" } };
  }
  if (!createEmployeeYaml(result.employee)) {
    return { statusCode: 400, body: { error: `employee "${result.employee.name}" already exists` } };
  }
  context.reloadOrg?.();
  context.emit("org:updated", { employee: result.employee.name, action: "created" });
  const created = scanOrg().get(result.employee.name);
  return { statusCode: 201, body: { status: "ok", employee: created ?? null } };
}

export async function updateOrgEmployee(
  name: string,
  body: Record<string, unknown>,
  principal: GatewayPrincipal | undefined,
  context: ApiContext,
): Promise<OrgMutationResult> {
  const { updateEmployeeYaml, validateEmployeeUpdate } = await import("./org.js");
  const registry = scanOrg();
  const current = registry.get(name);
  if (!current) return notFound();

  const managerName = typeof body.managerName === "string" ? body.managerName.trim() : "";
  if (managerName) {
    if (!isManagerNameAuthorizedForPrincipal(managerName, principal)) {
      return {
        statusCode: 403,
        body: { error: "Session-scoped callers may only act as their own bound manager identity" },
      };
    }
    const config = context.getConfig();
    const auth = authorizeManagerScope(registry, managerName, [name], config.portal?.portalName, config);
    if (!auth.ok) return { statusCode: 403, body: { error: auth.error } };
    const disallowedFields = disallowedManagerScopedFields(body);
    if (disallowedFields.length > 0) {
      return {
        statusCode: 403,
        body: {
          error: `manager-scoped employee updates may only modify ${[...MANAGER_MUTABLE_EMPLOYEE_FIELDS].join(", ")} (received: ${disallowedFields.join(", ")})`,
        },
      };
    }
  }

  const employeeUpdate = { ...body };
  delete employeeUpdate.managerName;
  const result = validateEmployeeUpdate(context.getConfig(), current, employeeUpdate, registry.keys());
  if (!result.ok) return { statusCode: 400, body: { error: result.error || "invalid update" } };
  if (!updateEmployeeYaml(name, result.updates!)) return notFound();

  context.reloadOrg?.();
  context.emit("org:updated", { employee: name });
  return { statusCode: 200, body: { status: "ok", employee: scanOrg().get(name) ?? null } };
}

export async function deleteOrgEmployee(name: string, context: ApiContext): Promise<OrgMutationResult> {
  const { getAllParents } = await import("./org-hierarchy.js");
  const registry = scanOrg();
  if (!registry.has(name)) return notFound();
  const reports = [...registry.values()]
    .filter((employee) => getAllParents(employee.reportsTo).includes(name))
    .map((employee) => employee.name);
  if (reports.length > 0) {
    return {
      statusCode: 409,
      body: {
        error: `Cannot delete "${name}" while ${reports.length} employee${reports.length === 1 ? "" : "s"} still report${reports.length === 1 ? "s" : ""} to them. Reassign or remove them first.`,
        reports,
      },
    };
  }

  const deletion = deleteEmployeeWithBoardCleanup(ORG_DIR, name);
  if (!deletion.ok) {
    logger.error(`Employee ${name} was not deleted safely: ${deletion.error}`);
    return { statusCode: 500, body: { error: `Employee was not deleted: ${deletion.error}` } };
  }
  for (const department of deletion.archived.departments) context.emit("board:updated", { department });
  context.reloadOrg?.();
  context.emit("org:updated", { employee: name, action: "deleted" });
  return { statusCode: 200, body: { status: "ok" } };
}

export async function submitOrgChangeRequest(
  body: Record<string, unknown>,
  principal: GatewayPrincipal | undefined,
  context: ApiContext,
): Promise<OrgMutationResult> {
  const input = parseChangeInput(body);
  if (!input.ok) return { statusCode: 400, body: { error: input.error } };
  const { validateOrgChange } = await import("./org.js");
  const validation = validateOrgChange(context.getConfig(), input.value);
  if (!validation.ok) {
    return { statusCode: 400, body: { error: validation.error || "invalid org change" } };
  }
  const { submitOrgChange } = await import("./hr-steward.js");
  const result = await submitOrgChange({
    changeType: input.value.changeType,
    employeeName: input.value.employeeName,
    proposed: input.value.proposed,
    rationale: typeof body.rationale === "string" ? body.rationale : "",
    evidenceRefs: Array.isArray(body.evidenceRefs)
      ? body.evidenceRefs.filter((entry): entry is string => typeof entry === "string")
      : [],
    proposedBy: typeof body.proposedBy === "string" && body.proposedBy.trim() ? body.proposedBy.trim() : "user",
    originSessionId: principal?.kind === "session" ? principal.sessionId : null,
  }, context);
  if (result.blocked) {
    return {
      statusCode: 409,
      body: { status: "blocked", error: result.reason, changeRequest: result.request },
    };
  }
  return { statusCode: 202, body: { status: "ok", changeRequest: result.request } };
}

async function resolveChangeApproval(
  id: string,
  actor: string | null | undefined,
  context: ApiContext,
  mode: "approve" | "apply",
): Promise<OrgMutationResult> {
  const { getChangeRequest, updateChangeRequestStatus } = await import("./org-changes.js");
  const { applyOrgChange, recordHrDecisionMessage } = await import("./hr-steward.js");
  const { getApproval, resolveApproval } = await import("./approvals.js");
  const request = getChangeRequest(id);
  if (!request) return notFound();
  if (request.status !== "pending_approval" && request.status !== "approved") {
    const error = mode === "approve"
      ? `change is ${request.status}, not awaiting approval`
      : `Change request is '${request.status}' and cannot be applied`;
    return { statusCode: 409, body: { error } };
  }

  const approvalSessionId = request.approvalId ? (getApproval(request.approvalId)?.sessionId ?? null) : null;
  if (request.approvalId) {
    try {
      const resolved = resolveApproval(request.approvalId, "approved", actor);
      context.emit("approval:resolved", {
        approvalId: resolved.id,
        sessionId: resolved.sessionId,
        state: "approved",
      });
    } catch {
      // Already resolved: application remains idempotent.
    }
  }
  recordHrDecisionMessage(approvalSessionId, request, { action: "approved", actor }, context);
  if (mode === "approve" || request.status === "pending_approval") updateChangeRequestStatus(id, "approved");
  const applied = await applyOrgChange(request, context);
  if (!applied.ok) {
    recordHrDecisionMessage(approvalSessionId, request, {
      action: "failed",
      actor,
      error: applied.error ?? null,
    }, context);
    return {
      statusCode: 400,
      body: { status: "error", error: applied.error, changeRequest: getChangeRequest(id) },
    };
  }
  recordHrDecisionMessage(approvalSessionId, request, { action: "applied", actor }, context);
  return { statusCode: 200, body: { status: "ok", changeRequest: getChangeRequest(id) } };
}

export function approveOrgChange(
  id: string,
  actor: string | null | undefined,
  context: ApiContext,
): Promise<OrgMutationResult> {
  return resolveChangeApproval(id, actor, context, "approve");
}

export function applyApprovedOrgChange(
  id: string,
  actor: string | null | undefined,
  context: ApiContext,
): Promise<OrgMutationResult> {
  return resolveChangeApproval(id, actor, context, "apply");
}

export async function rejectOrgChange(
  id: string,
  actor: string | null | undefined,
  context: ApiContext,
): Promise<OrgMutationResult> {
  const { getChangeRequest, updateChangeRequestStatus } = await import("./org-changes.js");
  const { recordHrDecisionMessage } = await import("./hr-steward.js");
  const { getApproval, resolveApproval } = await import("./approvals.js");
  const request = getChangeRequest(id);
  if (!request) return notFound();
  if (!['pending_approval', 'approved'].includes(request.status)) {
    return { statusCode: 409, body: { error: `change is ${request.status}, not awaiting approval` } };
  }
  const approvalSessionId = request.approvalId ? (getApproval(request.approvalId)?.sessionId ?? null) : null;
  if (request.approvalId) {
    try {
      const resolved = resolveApproval(request.approvalId, "rejected", actor);
      context.emit("approval:resolved", {
        approvalId: resolved.id,
        sessionId: resolved.sessionId,
        state: "rejected",
      });
    } catch {
      // Already resolved.
    }
  }
  const updated = updateChangeRequestStatus(id, "rejected");
  recordHrDecisionMessage(approvalSessionId, request, { action: "rejected", actor }, context);
  context.emit("org-change:updated", { id, status: "rejected" });
  return { statusCode: 200, body: { status: "ok", changeRequest: updated } };
}

export async function renameOrgDepartment(
  name: string,
  nextName: string,
  context: ApiContext,
): Promise<OrgMutationResult> {
  const { renameDepartment } = await import("./department-rename.js");
  const result = renameDepartment(name, nextName);
  if (!result.ok) return { statusCode: result.status, body: { error: result.error } };
  context.reloadOrg?.();
  context.emit("org:updated", {
    action: "department-renamed",
    previousDepartment: result.previousDepartment,
    department: result.department,
    employees: result.employees,
  });
  if (result.movedDirectory) {
    context.emit("board:updated", {
      department: result.department,
      previousDepartment: result.previousDepartment,
    });
  }
  return { statusCode: 200, body: { status: "ok", ...result } };
}

export function updateDepartmentBoard(
  department: string,
  payload: unknown,
  context: ApiContext,
): OrgMutationResult {
  if (!fs.existsSync(path.join(ORG_DIR, department))) return notFound();
  try {
    const currentTickets = readBoardState(ORG_DIR, department)?.tickets ?? [];
    const assigneeError = validateBoardAssigneesForDepartment(department, payload, currentTickets);
    if (assigneeError) return { statusCode: 400, body: { error: assigneeError } };
    const activeSessionIds = new Set(listSessions().map((session) => session.id));
    const { rejected } = writeMergedBoardPartial(ORG_DIR, department, payload, { activeSessionIds });
    if (rejected.length > 0) {
      logger.warn(
        `PUT /api/org/departments/${department}/board: accepted valid tickets, rejected ${rejected.length} invalid: `
        + rejected.map((entry) => `[${entry.index}] ${entry.error}`).join("; "),
      );
    }
    context.emit("board:updated", { department });
    return {
      statusCode: 200,
      body: rejected.length > 0 ? { status: "partial", rejectedTickets: rejected } : { status: "ok" },
    };
  } catch (err) {
    logger.warn(`PUT /api/org/departments/${department}/board failed: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof BoardConflictError) {
      return {
        statusCode: 409,
        body: { reason: "board-conflict", error: err.message, ticketIds: err.ticketIds },
      };
    }
    return {
      statusCode: 400,
      body: { error: err instanceof Error ? err.message : "Invalid board payload" },
    };
  }
}
