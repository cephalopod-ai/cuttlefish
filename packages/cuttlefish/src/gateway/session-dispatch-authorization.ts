import type { QueueDispatchAuthority } from "@cuttlefish/contracts";
import type { Engine, Session } from "../shared/types.js";
import { getApprovalRecord, getQueueItem, getSession, markQueueItemDenied, retainQueueItemPending, updateSession } from "../sessions/registry.js";
import { isHumanDelegateRole, isHumanDelegationModelAllowed, operatorDelegationPromptHash, readActiveOperatorDelegationGrant } from "../sessions/operator-delegation.js";
import type { ApiContext } from "./api/context.js";
import { isHumanCheckpointPaused } from "../sessions/human-checkpoint-state.js";
import { isAuthorizedHumanDelegatePrincipal } from "./manager-auth.js";
import { approvalMaterialHash } from "./approval-binding.js";
import { parseLeaseTransportMeta } from "../orchestration/lease-meta.js";

export interface DispatchAuthorization {
  queueItemId?: string;
  authority?: QueueDispatchAuthority | null;
  runId?: string | null;
  validateLease?: (workerId: string, leaseId: string, taskId: string, coordinatorId: string) => { ok: boolean };
}

/** Last synchronous gateway check before entering an external engine invocation.
 * A queue allocation or scheduler lease is deliberately not an action grant. */
export function sessionTaskBoundaryDenial(session: Session, expected?: DispatchAuthorization): string | null {
  if (session.executionBoundaryInvalid) return "Execution boundary is corrupt or unsupported";
  if (session.executionBoundary?.cancelled) return "Originating task was cancelled";
  if (expected?.runId && session.transportMeta?.latestRunId !== expected.runId) return "Engine invocation belongs to a superseded attempt";
  const recovery = session.transportMeta?.dispatchRecovery;
  if (recovery && typeof recovery === "object" && !Array.isArray(recovery) && recovery.state === "uncertain") return "Uncertain engine outcome requires operator reconciliation";
  const visited = new Set([session.id]);
  let child = session;
  const allocationDenial = (candidate: Session): string | null => {
    if (candidate.transportMeta?.orchestrationLease === undefined) return null;
    const lease = parseLeaseTransportMeta(candidate.transportMeta);
    if (!lease || !expected?.validateLease) return "Required scheduler allocation cannot be established";
    return expected.validateLease(lease.workerId, lease.leaseId, lease.taskId, lease.coordinatorId).ok ? null : "Scheduler lease is stale, revoked, or outside the assigned task";
  };
  const ownAllocationDenial = allocationDenial(session); if (ownAllocationDenial) return ownAllocationDenial;
  while (child.parentSessionId) {
    if (visited.size >= 32 || visited.has(child.parentSessionId)) return "Session ancestry is corrupt or exceeds the supported depth";
    visited.add(child.parentSessionId);
    const parent = getSession(child.parentSessionId);
    if (!parent || parent.executionBoundaryInvalid) return "Originating session or execution boundary is unavailable";
    const parentAllocationDenial = allocationDenial(parent); if (parentAllocationDenial) return parentAllocationDenial;
    if (parent.executionBoundary?.cancelled || (child.executionBoundary?.parentGeneration && child.executionBoundary.parentGeneration !== parent.executionBoundary?.generation)) return "Originating task generation changed or was cancelled";
    if (parent.executionBoundary?.requirement === "read_only" && session.executionBoundary?.requirement !== "read_only") return "Child execution scope exceeds its originating task";
    child = parent;
  }
  return null;
}

export function sessionDispatchDenial(session: Session, prompt: string, engine: Engine, expected?: DispatchAuthorization): string | null {
  const taskDenial = sessionTaskBoundaryDenial(session, expected);
  if (taskDenial) return taskDenial;
  if (session.executionBoundary?.requirement === "read_only" && engine.executionCapabilities?.readOnly !== true) return `Engine "${engine.name}" does not support required read-only execution`;
  let authority = expected?.authority;
  if (expected?.queueItemId) {
    const item = getQueueItem(expected.queueItemId);
    if (!item || item.sessionId !== session.id || item.sessionKey !== (session.sessionKey || session.sourceRef || session.id) || item.prompt !== prompt) return "Queue operation target or payload changed";
    if (item.dispatchAuthorityInvalid) return "Queue authority is corrupt or unsupported";
    authority = item.dispatchAuthority;
  }
  if (authority && authority.generation !== session.executionBoundary?.generation) return "Queued task generation is no longer current";
  if (authority && authority.payloadHash !== operatorDelegationPromptHash(prompt)) return "Queue operation payload revision changed";
  if (!authority && session.executionBoundary && expected?.queueItemId) return "Required queue execution boundary is missing";
  if (authority?.delegationId) {
    const grant = readActiveOperatorDelegationGrant(session);
    if (!grant || grant.id !== authority.delegationId || !isHumanDelegateRole(session.employee, session.source) || !isHumanDelegationModelAllowed(session.engine, session.model)) return "Operator delegation expired, revoked, superseded, or no longer eligible";
  }
  if (authority?.sourceSessionId) {
    const source = getSession(authority.sourceSessionId);
    if (!source || source.parentSessionId !== session.id || source.transportMeta?.latestRunId !== authority.sourceRunId || source.executionBoundary?.cancelled) return "Callback does not match the current child attempt";
  }
  if (authority?.decision) {
    const decision = authority.decision;
    const approval = getApprovalRecord(decision.approvalId);
    const binding = approval?.payload.reviewBinding;
    if (!approval || approval.sessionId !== session.id || !["approved", "revised"].includes(approval.state)
      || approval.resultingAction !== "resume_session" || !binding || typeof binding !== "object" || Array.isArray(binding)
      || binding.revision !== decision.revision || binding.materialHash !== decision.materialHash
      || approvalMaterialHash(approval.payload) !== decision.materialHash || session.engine !== decision.engine
      || (session.model ?? null) !== decision.model) return "Queued approval no longer matches its reviewed decision";
    if (decision.delegateSessionId && !isAuthorizedHumanDelegatePrincipal({ kind: "session", sessionId: decision.delegateSessionId,
      operatorDelegationId: decision.delegationId!, delegatedScopes: approval.state === "approved" ? ["approve", "decide"] : ["decide"] },
      approval.state === "approved" ? ["approve", "decide"] : ["decide"], undefined, session.id)) return "Delegated approval authority expired or was revoked before resume";
  }
  return null;
}

/** Completion can retain evidence, but cannot settle another run or a cancelled generation. */
export function currentSessionAttempt(snapshot: Session): Session | undefined {
  const live = getSession(snapshot.id);
  return live && !live.executionBoundaryInvalid && !live.executionBoundary?.cancelled
    && live.executionBoundary?.generation === snapshot.executionBoundary?.generation
    && live.transportMeta?.latestRunId === snapshot.transportMeta?.latestRunId ? live : undefined;
}

/** A pause retains undispatched work; a denial records no successful execution. */
export function admitSessionDispatch(session: Session, prompt: string, engine: Engine, context: ApiContext, expected?: DispatchAuthorization): boolean {
  const runtime = context.orchestration?.runtime;
  const denial = sessionDispatchDenial(session, prompt, engine, { ...expected, validateLease: runtime?.validateLeaseForWorker?.bind(runtime) ?? expected?.validateLease });
  if (denial) {
    if (expected?.queueItemId) markQueueItemDenied(expected.queueItemId);
    updateSession(session.id, { status: session.status === "waiting" ? "waiting" : "error", lastError: denial, lastActivity: new Date().toISOString() });
    context.emit("session:updated", { sessionId: session.id, code: "execution_authority_denied", reason: denial });
    return false;
  }
  if (session.status === "waiting" || isHumanCheckpointPaused(session)) {
    if (expected?.queueItemId) retainQueueItemPending(expected.queueItemId);
    return false;
  }
  return true;
}
