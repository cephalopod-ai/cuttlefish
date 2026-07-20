/**
 * HR / Org Steward service — the always-on critique pipeline + the apply path.
 *
 * Every org mutation funnels through `submitOrgChange`, which:
 *   1. runs the hard guards (no self-edit, no cycle) — blocked changes are
 *      persisted as `rejected` with the reason, never applied;
 *   2. classifies the change into a risk tier (org-policy.ts);
 *   3. persists it `pending_critique` and fires an HR critique turn in the
 *      BACKGROUND (the route returns 202 immediately — the critique is an LLM
 *      turn and must not block the response);
 *   4. when the critique completes, advances to `pending_approval` (creating the
 *      reused Approval gate) or, for low-risk auto-appliable changes, applies it.
 *
 * `applyOrgChange` re-checks the guards + validation against the live roster and
 * dispatches to the existing org writers. The critique itself (`defaultRunCritique`)
 * spawns the `hr-manager` employee in-process; it is injectable so the pipeline
 * is testable without a live engine.
 */
import {
  scanOrg,
  validateOrgChange,
  validateEmployeeCreate,
  validateEmployeeUpdate,
  createEmployeeYaml,
  updateEmployeeYaml,
  retireEmployeeYaml,
} from "./org.js";
import {
  createChangeRequest,
  getChangeRequest,
  updateChangeRequest,
  updateChangeRequestStatus,
} from "./org-changes.js";
import {
  classifyChange,
  assertNotSelfModification,
  assertAcyclic,
  OrgChangeBlockedError,
} from "./org-policy.js";
import { createApproval, getApproval, resolveApproval, resolveApprovalAsAutonomous } from "./approvals.js";
import { logger } from "../shared/logger.js";
import {
  getSession,
  insertMessage,
  updateSession,
} from "../sessions/registry.js";
import type { ApiContext } from "./api/context.js";
import type { Approval, OrgChangeRequest, OrgChangeType } from "../shared/types.js";
import { type CritiqueResult, defaultRunCritique } from "./hr-critique-dispatch.js";
import { KeyedMutex } from "../shared/async-lock.js";
import {
  AUTONOMOUS_ACTOR_SENTINEL,
  isAutonomousVerdictSession,
  recordAutonomousAuthorization,
  resolveAutonomousProject,
} from "./autonomous-mode.js";
import { requestDualModelVerdict, type DualModelVerdictResult } from "./dual-model-verdict.js";

export type { CritiqueResult } from "./hr-critique-dispatch.js";

export interface SubmitOrgChangeInput {
  changeType: OrgChangeType;
  employeeName: string;
  proposed: Record<string, unknown>;
  rationale?: string;
  evidenceRefs?: string[];
  proposedBy?: string;
  /** Securely inferred from a scoped chat token by the HTTP route. */
  originSessionId?: string | null;
}

export interface SubmitOrgChangeResult {
  request: OrgChangeRequest;
  blocked: boolean;
  reason?: string;
}

export interface HrStewardDeps {
  /** Injectable critique runner. Defaults to spawning the hr-manager employee. */
  runCritique?: (request: OrgChangeRequest, context: ApiContext) => Promise<CritiqueResult>;
}

/**
 * Submit a proposed org change. Runs guards synchronously, then kicks off the HR
 * critique in the background. Returns as soon as the change is persisted —
 * callers (the route) should return 202 with the returned request.
 */
export async function submitOrgChange(
  input: SubmitOrgChangeInput,
  context: ApiContext,
  deps: HrStewardDeps = {},
): Promise<SubmitOrgChangeResult> {
  const registry = scanOrg();
  const guardInput = {
    changeType: input.changeType,
    employeeName: input.employeeName,
    proposed: input.proposed,
    proposedBy: input.proposedBy,
  };

  // 1. Hard guards. A blocked change is persisted as rejected (for the audit
  //    trail + operator visibility) but never critiqued or applied.
  try {
    assertNotSelfModification(guardInput);
    assertAcyclic(guardInput, registry);
  } catch (err) {
    if (err instanceof OrgChangeBlockedError) {
      const rejected = createChangeRequest({
        ...input,
        riskLevel: "high",
        requiresHumanApproval: true,
        status: "rejected",
      });
      updateChangeRequest(rejected.id, { hrCritique: `Blocked: ${err.message}` }, "org.change.rejected");
      context.emit("org-change:created", { id: rejected.id, status: "rejected", changeType: rejected.changeType, employee: rejected.employeeName });
      return { request: getChangeRequest(rejected.id) ?? rejected, blocked: true, reason: err.message };
    }
    throw err;
  }

  // 2. Classify + persist pending_critique.
  const tier = classifyChange(guardInput);
  const request = createChangeRequest({
    ...input,
    riskLevel: tier.riskLevel,
    requiresHumanApproval: tier.requiresHumanApproval,
    status: "pending_critique",
  });
  context.emit("org-change:created", {
    id: request.id,
    status: request.status,
    changeType: request.changeType,
    employee: request.employeeName,
  });

  // 3. Fire the critique in the background — do NOT await (it's an LLM turn).
  const runCritique = deps.runCritique ?? defaultRunCritique;
  void runCritique(request, context)
    .then((result) => finishCritique(request.id, result, tier.requiresHumanApproval, context))
    .catch((err) => {
      logger.warn(`HR critique failed for ${request.id}: ${err instanceof Error ? err.message : String(err)}`);
      updateChangeRequest(request.id, {
        status: "error",
        hrCritique: `critique failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      context.emit("org-change:updated", { id: request.id, status: "error" });
    });

  return { request, blocked: false };
}

function buildOrgChangeVerdictPrompt(request: OrgChangeRequest): string {
  return [
    `Change type: ${request.changeType}`,
    `Target employee: ${request.employeeName}`,
    `Risk level: ${request.riskLevel}`,
    `Proposed by: ${request.proposedBy}`,
    `\nRationale:\n${request.rationale || "(none given)"}`,
    request.hrCritique ? `\nHR critique:\n${request.hrCritique}` : null,
    request.beforeYaml ? `\nCurrent state (YAML):\n${request.beforeYaml}` : "\n(no current state — this creates a new employee)",
    request.afterYaml ? `\nProposed state (YAML):\n${request.afterYaml}` : null,
  ].filter((line): line is string => line !== null).join("\n");
}

/**
 * ⚠️ INTENTIONAL SAFETY OVERRIDE — NOT A BUG. See gateway/autonomous-mode.ts's
 * module docblock. Delegates to resolveOrgChangeApproval — the SAME funnel the
 * human HTTP route uses (see api/routes/approvals.ts) — but with an
 * `autonomous` decision, which resolves via resolveApprovalAsAutonomous (a
 * distinct, non-spoofable resolvedByKind) instead of the human resolver, and
 * is only ever reached after BOTH models in a dual-model verdict agree. The
 * guards here are the verdict-side gating (fail-closed, strictly
 * pending-only); the shared funnel below owns the resolve/apply choreography.
 */
async function resolveAutonomousOrgChange(
  approval: Approval,
  verdict: DualModelVerdictResult,
  context: ApiContext,
): Promise<void> {
  if (!verdict.authorized) {
    logger.info(
      `[autonomous] deferred to human approval=${approval.id} claude=${verdict.claude.outcome} codex=${verdict.codex.outcome}`,
    );
    return;
  }
  const changeRequestId =
    typeof approval.payload.changeRequestId === "string" ? approval.payload.changeRequestId.trim() : "";
  if (!changeRequestId) {
    logger.warn(`[autonomous] org-change approval ${approval.id} missing changeRequestId — cannot auto-resolve`);
    return;
  }
  const request = getChangeRequest(changeRequestId);
  if (!request || !["pending_approval", "approved"].includes(request.status)) {
    logger.info(`[autonomous] org-change ${changeRequestId} no longer awaiting approval — skipping auto-resolve`);
    return;
  }
  const current = getApproval(approval.id)?.state;
  if (current !== "pending") {
    logger.info(`[autonomous] approval ${approval.id} already ${current} — skipping auto-resolve`);
    return;
  }

  const notes = JSON.stringify({ claude: verdict.claude, codex: verdict.codex });
  const outcome = await resolveOrgChangeApproval(approval, { kind: "autonomous", notes }, context);
  if (outcome.status === "applied" || outcome.status === "apply_failed" || outcome.status === "already_applied") {
    logger.info(`[autonomous] AUTO-AUTHORIZED org-change approval=${approval.id} claude=approved codex=approved`);
    recordAutonomousAuthorization();
  } else {
    logger.info(`[autonomous] org-change approval ${approval.id} not auto-resolved: ${outcome.status}`);
  }
}

/** Move a critiqued change to pending_approval (gate) or auto-apply it. */
async function finishCritique(
  id: string,
  result: CritiqueResult,
  requiresHumanApproval: boolean,
  context: ApiContext,
): Promise<void> {
  const updated = updateChangeRequestStatus(id, "pending_approval", { hrCritique: result.critique ?? null });
  if (!updated) return;
  context.emit("org-change:updated", { id, status: "pending_approval" });

  if (requiresHumanApproval) {
    const approval = createApproval({
      // HR's critique session is an implementation detail. Keep the approval
      // with the chat that proposed the change so its human-review card is
      // visible where the operator made the request.
      sessionId: updated.originSessionId ?? result.sessionId ?? `org-change:${id}`,
      type: "org-change",
      payload: {
        changeRequestId: id,
        changeType: updated.changeType,
        employeeName: updated.employeeName,
        riskLevel: updated.riskLevel,
      },
    });
    updateChangeRequest(id, { approvalId: approval.id });
    context.emit("approval:created", {
      approvalId: approval.id,
      sessionId: approval.sessionId,
      type: "org-change",
      changeRequestId: id,
    });

    // ⚠️ INTENTIONAL SAFETY OVERRIDE — NOT A BUG. When autonomous mode's
    // orgChangeOverride is on, a passing dual-model verdict resolves this
    // org-change approval WITHOUT a human. HR has no per-project concept, so
    // (per explicit operator sign-off) this is gateway-wide once enabled, not
    // confined to the autonomous project's cwd — see autonomous-mode.ts's
    // module docblock. Do not remove this branch or gate it on a cwd match
    // "to make it consistent" with the tool-checkpoint path; that would be
    // incorrect for the reason stated above, not a bug fix.
    const project = resolveAutonomousProject(context.getConfig());
    if (project?.orgChangeOverride) {
      const critiqueSession = result.sessionId ? getSession(result.sessionId) : undefined;
      if (!critiqueSession || !isAutonomousVerdictSession(critiqueSession.transportMeta)) {
        void requestDualModelVerdict(
          {
            parentSessionId: approval.sessionId,
            cwd: project.cwd,
            decisionKind: "org_change",
            contextPrompt: buildOrgChangeVerdictPrompt(updated),
          },
          context,
        )
          .then((verdict) => resolveAutonomousOrgChange(approval, verdict, context))
          .catch((err) => {
            logger.warn(`[autonomous] org-change verdict request failed for approval ${approval.id}: ${err instanceof Error ? err.message : String(err)}`);
          });
      }
    }
    return;
  }

  // Low-risk + auto-appliable → apply immediately.
  const fresh = getChangeRequest(id);
  if (fresh) {
    await applyOrgChange(fresh, context);
  }
}

export interface ApplyResult {
  ok: boolean;
  error?: string;
}

/** How an org-change approval is being resolved: by a human actor (HTTP
 *  route) or by the autonomous dual-model verdict path (with the raw verdicts
 *  as decision notes). The choice of resolver — and therefore the code-owned
 *  `resolvedByKind` audit column — is derived from this here, never from a
 *  caller-supplied string. */
export type OrgChangeApprovalDecision =
  | { kind: "human"; actor: string | null }
  | { kind: "autonomous"; notes: string };

export type OrgChangeApprovalOutcome =
  | { status: "missing_change_request_id" }
  | { status: "change_not_found" }
  | { status: "conflict"; message: string }
  | { status: "already_applied"; approval: Approval; request: OrgChangeRequest }
  | { status: "applied"; approval: Approval; request: OrgChangeRequest | undefined }
  | { status: "apply_failed"; approval: Approval; request: OrgChangeRequest | undefined; error: string | null };

/**
 * The ONE org-change approve funnel (planned in the autonomous-mode design as
 * the shared, correctly-locked entry point): resolve the Approval, emit,
 * record the decision message, advance the change request, and apply via the
 * mutex-protected applyOrgChange (see the CON-001 comment on
 * orgChangeApplyLock below). Both the human HTTP route
 * (api/routes/approvals.ts) and the autonomous dual-model path
 * (resolveAutonomousOrgChange above) delegate here, so the choreography can
 * never drift between them. The route stays a thin validate-and-delegate
 * adapter per the orchestrator/router contract.
 */
export async function resolveOrgChangeApproval(
  approval: Approval,
  decision: OrgChangeApprovalDecision,
  context: ApiContext,
): Promise<OrgChangeApprovalOutcome> {
  const changeRequestId =
    typeof approval.payload.changeRequestId === "string" && approval.payload.changeRequestId.trim()
      ? approval.payload.changeRequestId.trim()
      : null;
  if (!changeRequestId) return { status: "missing_change_request_id" };
  const request = getChangeRequest(changeRequestId);
  if (!request) return { status: "change_not_found" };

  const actor = decision.kind === "human" ? decision.actor : AUTONOMOUS_ACTOR_SENTINEL;
  const resolvePending = (): Approval =>
    decision.kind === "human"
      ? resolveApproval(approval.id, "approved", actor)
      : resolveApprovalAsAutonomous(approval.id, "approved", actor, decision.notes);

  if (request.status === "applied") {
    // Idempotent re-approve of an already-applied change: resolve the
    // approval record if still needed, but never re-run the apply.
    const resolved = approval.state === "approved" ? approval : resolvePending();
    context.emit("approval:resolved", { approvalId: resolved.id, sessionId: resolved.sessionId, state: "approved" });
    return { status: "already_applied", approval: resolved, request };
  }
  if (!["pending_approval", "approved"].includes(request.status)) {
    return { status: "conflict", message: `change is ${request.status}, not awaiting approval` };
  }
  if (approval.state !== "pending" && approval.state !== "approved") {
    return { status: "conflict", message: `approval already ${approval.state}` };
  }

  const resolved = approval.state === "approved" ? approval : resolvePending();
  context.emit("approval:resolved", { approvalId: resolved.id, sessionId: resolved.sessionId, state: "approved" });
  recordHrDecisionMessage(
    resolved.sessionId,
    request,
    { action: "approved", actor, autonomous: decision.kind === "autonomous" },
    context,
  );
  updateChangeRequestStatus(changeRequestId, "approved");
  const applied = await applyOrgChange(request, context);
  if (!applied.ok) {
    recordHrDecisionMessage(
      resolved.sessionId,
      request,
      { action: "failed", actor, error: applied.error ?? null, autonomous: decision.kind === "autonomous" },
      context,
    );
    return { status: "apply_failed", approval: resolved, request: getChangeRequest(changeRequestId), error: applied.error ?? null };
  }
  recordHrDecisionMessage(
    resolved.sessionId,
    request,
    { action: "applied", actor, autonomous: decision.kind === "autonomous" },
    context,
  );
  return { status: "applied", approval: resolved, request: getChangeRequest(changeRequestId) };
}

export function recordHrDecisionMessage(
  sessionId: string | null | undefined,
  request: OrgChangeRequest,
  opts: { action: "approved" | "rejected" | "applied" | "failed"; actor?: string | null; error?: string | null; autonomous?: boolean },
  context?: Pick<ApiContext, "emit">,
): void {
  if (!sessionId) return;
  const actor = opts.actor?.trim() ? opts.actor.trim() : "operator";
  const changeLabel = `${request.changeType} for "${request.employeeName}"`;
  // The transcript must never claim human sign-off that didn't happen — an
  // autonomous dual-model resolution is attributed to the two AI reviewers,
  // mirroring security-review.ts's buildAutonomousResumePrompt.
  const approvedLine = opts.autonomous
    ? `Autonomous approval: two independent AI reviewers (claude-fable-5, gpt-5.6-sol) both approved ${changeLabel}. Applying the approved change now.`
    : `Human approval received from ${actor} for ${changeLabel}. Applying the approved change now.`;
  const content =
    opts.action === "approved"
      ? approvedLine
      : opts.action === "rejected"
        ? `Human approval rejected by ${actor} for ${changeLabel}. No org changes were applied.`
        : opts.action === "applied"
          ? `The approved ${changeLabel} has been applied successfully.`
          : `The approved ${changeLabel} could not be applied: ${opts.error ?? "unknown error"}.`;
  insertMessage(sessionId, "assistant", content);
  updateSession(sessionId, {
    lastActivity: new Date().toISOString(),
    ...(opts.action === "failed" ? { lastError: opts.error ?? "org change apply failed" } : {}),
  });
  context?.emit?.("session:updated", { sessionId });
}

// CON-001: org-change apply has 4 independent entry points (approvals.ts's
// org-change branch, org.ts's :id/approve and :id/apply routes, and
// finishCritique's auto-apply branch above) that each do their own
// get -> check-status -> apply sequence with no shared lock. Two
// near-simultaneous calls for the same change request could both pass their
// status check and both run the org-writer side effect. Since all four
// funnel through this one function, keying a mutex on the change-request id
// here — plus a fresh disk re-read of status taken *inside* the lock —
// serializes them and makes the loser's re-read see "applied" and bail
// cleanly, with no code changes needed at any of the four call sites.
const orgChangeApplyLock = new KeyedMutex();

/**
 * Apply an approved (or auto-appliable) change to the org. Re-checks the guards +
 * validation against the LIVE roster (it may have shifted since submission), then
 * dispatches to the existing org writers, hot-reloads, and records `applied`.
 */
export async function applyOrgChange(requestInput: OrgChangeRequest, context: ApiContext): Promise<ApplyResult> {
  return orgChangeApplyLock.withLock(requestInput.id, () => applyOrgChangeLocked(requestInput, context));
}

async function applyOrgChangeLocked(requestInput: OrgChangeRequest, context: ApiContext): Promise<ApplyResult> {
  // Re-read fresh from disk now that we hold the lock — the caller's `request`
  // snapshot may predate another racer's apply that just completed.
  const request = getChangeRequest(requestInput.id) ?? requestInput;
  if (!["pending_approval", "approved"].includes(request.status)) {
    return { ok: false, error: `Change request is '${request.status}' and cannot be applied` };
  }
  const config = context.getConfig();
  const registry = scanOrg();
  const guardInput = {
    changeType: request.changeType,
    employeeName: request.employeeName,
    proposed: request.proposed,
    proposedBy: request.proposedBy,
  };

  try {
    assertNotSelfModification(guardInput);
    assertAcyclic(guardInput, registry);
  } catch (err) {
    if (err instanceof OrgChangeBlockedError) {
      updateChangeRequestStatus(request.id, "rejected", { hrCritique: `Blocked at apply: ${err.message}` });
      context.emit("org-change:updated", { id: request.id, status: "rejected" });
      return { ok: false, error: err.message };
    }
    throw err;
  }

  const validation = validateOrgChange(config, guardInput);
  if (!validation.ok) {
    updateChangeRequestStatus(request.id, "rejected", { hrCritique: `Validation failed at apply: ${validation.error}` });
    context.emit("org-change:updated", { id: request.id, status: "rejected" });
    return { ok: false, error: validation.error };
  }

  let ok = false;
  switch (request.changeType) {
    case "create_agent": {
      const created = validateEmployeeCreate(config, { name: request.employeeName, ...request.proposed }, registry.keys());
      ok = created.ok && !!created.employee && createEmployeeYaml(created.employee);
      break;
    }
    case "retire_agent":
      ok = retireEmployeeYaml(request.employeeName);
      break;
    case "disable_agent":
      ok = updateEmployeeYaml(request.employeeName, { lifecycle: "disabled" });
      break;
    default: {
      const current = registry.get(request.employeeName);
      if (!current) {
        ok = false;
        break;
      }
      const upd = validateEmployeeUpdate(config, current, request.proposed, registry.keys());
      ok = upd.ok && !!upd.updates && updateEmployeeYaml(request.employeeName, upd.updates);
    }
  }

  if (!ok) {
    updateChangeRequestStatus(request.id, "rejected", { hrCritique: "Apply failed — the org writer rejected the change." });
    context.emit("org-change:updated", { id: request.id, status: "rejected" });
    return { ok: false, error: "apply failed" };
  }

  context.reloadOrg?.();
  context.emit("org:updated", { employee: request.employeeName, action: request.changeType });
  updateChangeRequestStatus(request.id, "applied", { appliedAt: new Date().toISOString() });
  context.emit("org-change:updated", { id: request.id, status: "applied" });
  return { ok: true };
}
