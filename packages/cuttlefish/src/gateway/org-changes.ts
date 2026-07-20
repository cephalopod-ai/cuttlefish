/**
 * Org change-request store.
 *
 * OrgChangeRequest bodies live as JSON files under `~/.cuttlefish/org/_changes/`
 * (one file per request). This matches the repo's file-based, watched,
 * audit-logged org grain and gets validate-before-write + the hash-chained audit
 * ledger "for free" via `safeWriteJson`. The human-approval gate is layered on top
 * by reusing the existing generic Approval store (`type: "org-change"`) — see
 * hr-steward.ts. The `_changes/` dir is excluded from `scanOrg` (RESERVED_ORG_DIRS)
 * so these never load as employees.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import yaml from "js-yaml";
import { ORG_CHANGES_DIR } from "../shared/paths.js";
import { safeWriteJson } from "../shared/safe-write.js";
import { logger } from "../shared/logger.js";
import {
  buildEmployeeCreateData,
  mergeEmployeeUpdateData,
  readEmployeeYamlText,
  type EmployeeCreate,
  type EmployeeUpdate,
} from "./org.js";
import type {
  OrgChangeRequest,
  OrgChangeRiskLevel,
  OrgChangeStatus,
  OrgChangeType,
} from "../shared/types.js";

const CHANGE_FILE_SUFFIX = ".json";

function changeFilePath(id: string): string {
  return path.join(ORG_CHANGES_DIR, `${id}${CHANGE_FILE_SUFFIX}`);
}

/**
 * Render the before/after YAML for a proposed change WITHOUT writing anything.
 * Reuses org.ts's pure builders so the previewed "after" matches exactly what the
 * apply step writes.
 */
export function buildBeforeAfterYaml(
  changeType: OrgChangeType,
  employeeName: string,
  proposed: Record<string, unknown>,
): { beforeYaml: string | null; afterYaml: string } {
  if (changeType === "create_agent") {
    const data = buildEmployeeCreateData({ name: employeeName, ...proposed } as EmployeeCreate);
    return { beforeYaml: null, afterYaml: yaml.dump(data, { lineWidth: -1 }) };
  }
  const beforeYaml = readEmployeeYamlText(employeeName);
  const currentData = beforeYaml ? ((yaml.load(beforeYaml) as Record<string, unknown>) ?? {}) : {};
  const merged = mergeEmployeeUpdateData(currentData, proposed as EmployeeUpdate);
  return { beforeYaml, afterYaml: yaml.dump(merged, { lineWidth: -1 }) };
}

export interface CreateChangeRequestInput {
  changeType: OrgChangeType;
  employeeName: string;
  proposed: Record<string, unknown>;
  rationale?: string;
  evidenceRefs?: string[];
  proposedBy?: string;
  originSessionId?: string | null;
  riskLevel?: OrgChangeRiskLevel;
  requiresHumanApproval?: boolean;
  status?: OrgChangeStatus;
}

function writeChangeRequest(request: OrgChangeRequest, op: string): void {
  safeWriteJson(changeFilePath(request.id), request, {
    audit: { actor: request.proposedBy || "gateway", op },
  });
}

export function createChangeRequest(input: CreateChangeRequestInput): OrgChangeRequest {
  const now = new Date().toISOString();
  const id = `change-${randomUUID()}`;
  const { beforeYaml, afterYaml } = buildBeforeAfterYaml(input.changeType, input.employeeName, input.proposed);
  const request: OrgChangeRequest = {
    id,
    changeType: input.changeType,
    status: input.status ?? "draft",
    employeeName: input.employeeName,
    proposedBy: input.proposedBy ?? "user",
    originSessionId: input.originSessionId ?? null,
    proposed: input.proposed,
    rationale: input.rationale ?? "",
    evidenceRefs: input.evidenceRefs ?? [],
    beforeYaml,
    afterYaml,
    riskLevel: input.riskLevel ?? "medium",
    requiresHumanApproval: input.requiresHumanApproval ?? true,
    hrCritique: null,
    approvalId: null,
    createdAt: now,
    updatedAt: now,
    appliedAt: null,
  };
  writeChangeRequest(request, "org.change.create");
  return request;
}

export function getChangeRequest(id: string): OrgChangeRequest | undefined {
  const filePath = changeFilePath(id);
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as OrgChangeRequest;
  } catch (err) {
    logger.warn(`Failed to read org change request ${id}: ${err}`);
    return undefined;
  }
}

export function listChangeRequests(filter?: {
  status?: OrgChangeStatus | OrgChangeStatus[];
}): OrgChangeRequest[] {
  if (!fs.existsSync(ORG_CHANGES_DIR)) return [];
  const statuses = filter?.status
    ? Array.isArray(filter.status)
      ? filter.status
      : [filter.status]
    : null;
  const out: OrgChangeRequest[] = [];
  for (const entry of fs.readdirSync(ORG_CHANGES_DIR)) {
    if (!entry.endsWith(CHANGE_FILE_SUFFIX)) continue;
    try {
      const req = JSON.parse(
        fs.readFileSync(path.join(ORG_CHANGES_DIR, entry), "utf-8"),
      ) as OrgChangeRequest;
      if (statuses && !statuses.includes(req.status)) continue;
      out.push(req);
    } catch (err) {
      logger.warn(`Skipping unreadable org change file ${entry}: ${err}`);
    }
  }
  // Newest first.
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return out;
}

/** Patch a change request, bumping `updatedAt`. `id`/`createdAt` are immutable. */
export function updateChangeRequest(
  id: string,
  patch: Partial<Omit<OrgChangeRequest, "id" | "createdAt">>,
  op = "org.change.update",
): OrgChangeRequest | undefined {
  const current = getChangeRequest(id);
  if (!current) return undefined;
  const updated: OrgChangeRequest = {
    ...current,
    ...patch,
    id: current.id,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
  };
  writeChangeRequest(updated, op);
  return updated;
}

/** Transition a change request to a new status (audited with an `org.change.<status>` op). */
export function updateChangeRequestStatus(
  id: string,
  status: OrgChangeStatus,
  patch: Partial<Omit<OrgChangeRequest, "id" | "createdAt" | "status">> = {},
): OrgChangeRequest | undefined {
  return updateChangeRequest(id, { ...patch, status }, `org.change.${status}`);
}
