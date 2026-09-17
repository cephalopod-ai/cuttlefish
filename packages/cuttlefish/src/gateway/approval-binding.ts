import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Approval, JsonObject, Session } from "../shared/types.js";
import type { GatewayPrincipal } from "./auth.js";
import { isAuthorizedHumanDelegatePrincipal } from "./manager-auth.js";
import { getSession } from "../sessions/registry.js";
import type { OperatorDelegationScope } from "../sessions/operator-delegation.js";
import { CUTTLEFISH_HOME } from "../shared/paths.js";
import { getChangeRequest } from "./org-changes.js";

import { canonicalJsonStringify as canonicalJson } from "../shared/canonical-json.js";

export class ApprovalAuthorityError extends Error {}

/** The same bounded read supplies both the reviewed digest and dispatch text. */
export function readApprovalHandoff(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const root = fs.realpathSync(CUTTLEFISH_HOME);
  const candidate = path.resolve(root, value);
  if (!candidate.startsWith(root + path.sep)) throw new ApprovalAuthorityError("Handoff is outside gateway storage");
  if (!fs.existsSync(candidate)) return null;
  const real = fs.realpathSync(candidate);
  if (!real.startsWith(root + path.sep)) throw new ApprovalAuthorityError("Handoff is outside gateway storage");
  const stat = fs.statSync(real);
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new ApprovalAuthorityError("Handoff is unavailable or exceeds the review limit");
  return fs.readFileSync(real, "utf8");
}

export function approvalMaterialHash(payload: JsonObject): string {
  const material = { ...payload }; delete material.reviewBinding;
  const references: Record<string, unknown> = {};
  if (material.handoffPath !== undefined) {
    const text = readApprovalHandoff(material.handoffPath);
    references.handoff = text === null ? null : createHash("sha256").update(text).digest("hex");
  }
  if (material.changeRequestId !== undefined) {
    const id = material.changeRequestId;
    const request = typeof id === "string" && /^change-[a-f0-9-]{36}$/.test(id) ? getChangeRequest(id) : undefined;
    references.orgChange = request ? { changeType: request.changeType, employeeName: request.employeeName,
      proposed: request.proposed, beforeYaml: request.beforeYaml, afterYaml: request.afterYaml,
      originSessionId: request.originSessionId, proposedBy: request.proposedBy,
      riskLevel: request.riskLevel, requiresHumanApproval: request.requiresHumanApproval } : null;
  }
  return createHash("sha256").update(canonicalJson({ material, references })).digest("hex");
}

export function bindApprovalPayload(payload: JsonObject, session: Session | undefined): JsonObject {
  const material = { ...payload }; delete material.reviewBinding;
  const policy = { sessionId: session?.id ?? null, generation: session?.executionBoundary?.generation ?? null,
    requirement: session?.executionBoundary?.requirement ?? null, engine: session?.engine ?? null,
    model: session?.model ?? null, employee: session?.employee ?? null };
  const materialHash = approvalMaterialHash(material);
  const revision = createHash("sha256").update(canonicalJson({ materialHash, policy })).digest("hex");
  return { ...material, reviewBinding: { version: 1, revision, materialHash, policy } };
}

/** A decision authorizes the material reviewed, never arbitrary replacement arguments. */
export function assertApprovalDecisionAuthority(approval: Approval, principal?: GatewayPrincipal, reviewedRevision?: string | null, scopes: OperatorDelegationScope[] = ["approve", "decide"]): void {
  if (principal?.kind === "session" && !isAuthorizedHumanDelegatePrincipal(principal, scopes, undefined, approval.sessionId)) {
    throw new ApprovalAuthorityError("Delegated decision authority expired, revoked, or outside the target scope");
  }
  const session = getSession(approval.sessionId);
  if (session?.executionBoundaryInvalid || session?.executionBoundary?.cancelled) throw new ApprovalAuthorityError("Approval target is cancelled or its execution boundary is unavailable");
  const binding = approval.payload.reviewBinding;
  if (binding === undefined) {
    if (principal?.kind === "session") throw new ApprovalAuthorityError("Legacy approval has no material binding; an operator must review it");
    return;
  }
  if (!binding || typeof binding !== "object" || Array.isArray(binding) || binding.version !== 1 || typeof binding.revision !== "string") throw new ApprovalAuthorityError("Approval binding is corrupt or unsupported");
  const current = bindApprovalPayload(approval.payload, session).reviewBinding as JsonObject;
  if (current.revision !== binding.revision || (reviewedRevision != null && reviewedRevision !== binding.revision)) throw new ApprovalAuthorityError("Reviewed approval material or target policy changed");
  if (principal?.kind === "session" && reviewedRevision !== binding.revision) throw new ApprovalAuthorityError("A delegated decision requires the reviewed revision");
}
