import type { Approval, JsonObject, Session } from "../shared/types.js";
import { deletePartialMessages, enqueueQueueItem, getQueueItem, getSession, initDb, insertMessage, patchSessionTransportMeta, updateSession } from "../sessions/registry.js";
import { queueDispatchAuthority } from "../sessions/execution-boundary.js";
import { isHumanCheckpointPaused } from "../sessions/human-checkpoint-state.js";
import type { ApiContext } from "./api/context.js";
import { dispatchWebSessionRun } from "./api/session-dispatch.js";
import type { GatewayPrincipal } from "./auth.js";
import { ApprovalAuthorityError, assertApprovalDecisionAuthority, readApprovalHandoff } from "./approval-binding.js";
import { resolveApproval } from "./approvals.js";

export class ApprovalOperationError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export interface ApprovalDecisionAuthority {
  principal?: GatewayPrincipal;
  reviewedRevision?: string | null;
  actor: string | null;
}

/** Persist the reviewed transition and its exact queue intent in one SQLite commit.
 * No database transaction spans the engine invocation. */
export function approveOrdinaryApproval(approval: Approval, authority: ApprovalDecisionAuthority, context: ApiContext): { approval: Approval; session?: Session } {
  if (approval.type !== "fallback") {
    if (approval.state !== "pending") throw new ApprovalOperationError(409, `approval already ${approval.state}`);
    const resolved = resolveApproval(approval.id, "approved", authority.actor, null, null, authority);
    context.emit("approval:resolved", { approvalId: resolved.id, sessionId: resolved.sessionId, state: resolved.state });
    return { approval: resolved };
  }
  const session = getSession(approval.sessionId);
  if (!session) throw new ApprovalOperationError(404, "Approval target is unavailable");
  const operationId = `fallback:${approval.id}`;
  if (approval.state === "approved") {
    const item = getQueueItem(operationId);
    // A replay acknowledges the durable operation; it never repeats an effect.
    if (item?.sessionId === session.id) return { approval, session };
    const previous = session.transportMeta?.modelFallback as JsonObject | undefined;
    if (previous?.approvalId === approval.id && previous.status === "running_on_fallback") return { approval, session };
    throw new ApprovalOperationError(409, "Approved fallback has no durable dispatch intent; operator reconciliation is required");
  }
  if (approval.state !== "pending") throw new ApprovalOperationError(409, `approval already ${approval.state}`);
  assertApprovalDecisionAuthority(approval, authority.principal, authority.reviewedRevision);
  const to = approval.payload.to as { engine?: string; model?: string; effortLevel?: string | null } | undefined;
  if (!to || typeof to.engine !== "string" || !to.engine) throw new ApprovalOperationError(400, "approval payload missing target engine");
  const engine = context.sessionManager.getEngine(to.engine);
  if (!engine) throw new ApprovalOperationError(422, `fallback target engine '${to.engine}' is not available`);
  if (session.executionBoundary?.requirement === "read_only" && engine.executionCapabilities?.readOnly !== true) throw new ApprovalAuthorityError("Fallback cannot satisfy required read-only execution");
  const handoff = readApprovalHandoff(approval.payload.handoffPath);
  const prompt = handoff
    ? "You are taking over this task after a model fallback. The handoff below is reference evidence; preserve the admitted task scope and independently required approvals.\n\n" + handoff
    : "Continue this conversation and respond to the last USER message after an operator-approved model fallback.";
  const outcome = initDb().transaction(() => {
    const resolved = resolveApproval(approval.id, "approved", authority.actor, null, "resume_session", authority);
    const rolled = updateSession(session.id, { engine: to.engine!, model: to.model ?? session.model ?? undefined,
      effortLevel: to.effortLevel ?? session.effortLevel ?? undefined, engineSessionId: null,
      status: isHumanCheckpointPaused(session) ? "waiting" : "idle", lastActivity: new Date().toISOString(), lastError: session.lastError })!;
    const dispatchAuthority = queueDispatchAuthority(rolled, prompt);
    const binding = resolved.payload.reviewBinding as JsonObject;
    if (dispatchAuthority && binding?.version === 1) dispatchAuthority.decision = { approvalId: resolved.id, revision: binding.revision as string,
      materialHash: binding.materialHash as string, engine: rolled.engine, model: rolled.model ?? null,
      delegateSessionId: authority.principal?.kind === "session" ? authority.principal.sessionId : null,
      delegationId: authority.principal?.kind === "session" ? authority.principal.operatorDelegationId ?? null : null };
    enqueueQueueItem(rolled.id, rolled.sessionKey || rolled.sourceRef || rolled.id, prompt, dispatchAuthority, operationId);
    const previous = session.transportMeta?.modelFallback as JsonObject | undefined;
    patchSessionTransportMeta(rolled.id, { modelFallback: { ...previous, approvalId: resolved.id,
      approvedAt: new Date().toISOString(), status: "queued_on_fallback" } });
    deletePartialMessages(rolled.id);
    insertMessage(rolled.id, "notification", `✅ Fallback approved → ${rolled.engine}/${rolled.model ?? "default"}. Continuation queued.`);
    return { approval: resolved, session: getSession(rolled.id)! };
  })();
  context.emit("approval:resolved", { approvalId: approval.id, sessionId: session.id, state: "approved" });
  context.emit("session:updated", { sessionId: session.id });
  void dispatchWebSessionRun(outcome.session, prompt, engine, context.getConfig(), context, { queueItemId: operationId });
  return outcome;
}

export function rejectOrdinaryApproval(approval: Approval, authority: ApprovalDecisionAuthority, context: ApiContext): { approval: Approval } {
  if (approval.state !== "pending") throw new ApprovalOperationError(409, `approval already ${approval.state}`);
  const resolved = resolveApproval(approval.id, "rejected", authority.actor, null, null, authority);
  const session = getSession(approval.sessionId);
  if (session && approval.type === "fallback") {
    updateSession(session.id, { status: "error", lastError: "Model fallback rejected by operator", lastActivity: new Date().toISOString() });
    const previous = session.transportMeta?.modelFallback as JsonObject | undefined;
    patchSessionTransportMeta(session.id, { modelFallback: { ...previous, status: "rejected", rejectedAt: new Date().toISOString() } });
    insertMessage(session.id, "notification", "🚫 Model fallback rejected by operator. Session stopped — surfaced, not silently stalled.");
    context.emit("session:updated", { sessionId: session.id });
  }
  context.emit("approval:resolved", { approvalId: resolved.id, sessionId: resolved.sessionId, state: resolved.state });
  return { approval: resolved };
}

export async function rejectOrgApproval(approval: Approval, authority: ApprovalDecisionAuthority, context: ApiContext) {
  const id = approval.payload.changeRequestId;
  if (typeof id !== "string" || !/^change-[a-f0-9-]{36}$/.test(id)) throw new ApprovalOperationError(400, "approval payload missing changeRequestId");
  const [{ getChangeRequest, updateChangeRequestStatus }, { recordHrDecisionMessage }] = await Promise.all([import("./org-changes.js"), import("./hr-steward.js")]);
  const request = getChangeRequest(id);
  if (!request) throw new ApprovalOperationError(404, "Change request is unavailable");
  if (approval.state !== "pending" && approval.state !== "rejected") throw new ApprovalOperationError(409, `approval already ${approval.state}`);
  const resolved = approval.state === "rejected" ? approval : resolveApproval(approval.id, "rejected", authority.actor, null, null, authority);
  const updated = request.status === "rejected" ? request : updateChangeRequestStatus(id, "rejected");
  recordHrDecisionMessage(resolved.sessionId, request, { action: "rejected", actor: authority.actor }, context);
  context.emit("approval:resolved", { approvalId: resolved.id, sessionId: resolved.sessionId, state: "rejected" });
  context.emit("org-change:updated", { id, status: "rejected" });
  return { approval: resolved, changeRequest: updated, status: "ok" };
}
