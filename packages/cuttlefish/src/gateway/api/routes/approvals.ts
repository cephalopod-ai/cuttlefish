import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import type { ListableApprovalType, Approval } from "../../../shared/types.js";
import { getApproval, listApprovals } from "../../approvals.js";
import type { ApiContext } from "../context.js";
import { matchRoute } from "../match-route.js";
import { badRequest, json, notFound } from "../responses.js";
import { serializeSession } from "../serialize-session.js";
import { resolveUserHeader } from "../../connector-reply.js";
import type { GatewayPrincipal } from "../../auth.js";
import { delegatedApprovalActor, isAuthorizedHumanDelegatePrincipal, mayAccessDecisionSession } from "../../manager-auth.js";
import { assertApprovalDecisionAuthority } from "../../approval-binding.js";
import { readJsonObjectBody } from "../../http-helpers.js";
import { approveOrdinaryApproval, rejectOrdinaryApproval, rejectOrgApproval, ApprovalOperationError } from "../../approval-decisions.js";

function approvalActor(req: HttpRequest, context: ApiContext): string | null {
  const principal = (req as HttpRequest & { cuttlefishPrincipal?: GatewayPrincipal }).cuttlefishPrincipal;
  return principal?.kind === "session"
    ? delegatedApprovalActor(principal)
    : resolveUserHeader(req.headers, context.getConfig().gateway.userHeader) ?? null;
}

export async function handleApprovalRoutes(
  method: string,
  pathname: string,
  req: HttpRequest,
  url: URL,
  res: ServerResponse,
  context: ApiContext,
): Promise<boolean> {
  let reviewedRevision: string | null = null;
  if (method === "POST" && /^\/api\/approvals\/[^/]+\/(approve|reject)$/.test(pathname) && req.headers["content-type"]?.includes("application/json")) {
    const parsed = await readJsonObjectBody(req, res); if (!parsed.ok) return true;
    reviewedRevision = typeof parsed.body.reviewedRevision === "string" ? parsed.body.reviewedRevision : null;
  }
  if (method === "GET" && pathname === "/api/approvals") {
    const stateParam = (url.searchParams.get("state") ?? "pending") as
      | "pending" | "approved" | "rejected" | "all";
    const sessionId = url.searchParams.get("sessionId") ?? undefined;
    // checkpoint approvals are served via /api/checkpoints/:id/decision
    const principal = (req as HttpRequest & { cuttlefishPrincipal?: GatewayPrincipal }).cuttlefishPrincipal;
    json(res, listApprovals({ state: stateParam, sessionId }).filter((approval): approval is Approval & { type: ListableApprovalType } => approval.type !== "checkpoint" && mayAccessDecisionSession(principal, approval.sessionId)));
    return true;
  }

  let approvalParams = matchRoute("/api/approvals/:id/approve", pathname);
  if (method === "POST" && approvalParams) {
    const approval = getApproval(approvalParams.id);
    if (!approval) {
      notFound(res);
      return true;
    }
    const principal = (req as HttpRequest & { cuttlefishPrincipal?: GatewayPrincipal }).cuttlefishPrincipal;
    if (principal?.kind === "session" && !isAuthorizedHumanDelegatePrincipal(principal, ["approve", "decide"], undefined, approval.sessionId)) {
      json(res, { error: "This session does not have explicit delegated approval authority" }, 403);
      return true;
    }
    const actor = approvalActor(req, context);
    if (approval.state === "pending") assertApprovalDecisionAuthority(approval, principal, reviewedRevision);

    if (approval.type === "checkpoint") {
      json(res, { error: "checkpoint approvals must be resolved via POST /api/checkpoints/:id/decision" }, 409);
      return true;
    }

    if (approval.type === "org-change") {
      // Domain choreography lives in hr-steward.ts's resolveOrgChangeApproval
      // — the ONE approve funnel shared with the autonomous dual-model path —
      // so this route only validates, delegates, and translates the outcome.
      const { resolveOrgChangeApproval } = await import("../../hr-steward.js");
      assertApprovalDecisionAuthority(getApproval(approval.id)!, principal, reviewedRevision);
      const outcome = await resolveOrgChangeApproval(approval, { kind: "human", actor, principal, reviewedRevision }, context);
      switch (outcome.status) {
        case "missing_change_request_id":
          badRequest(res, "approval payload missing changeRequestId");
          return true;
        case "change_not_found":
          notFound(res);
          return true;
        case "conflict":
          json(res, { error: outcome.message }, 409);
          return true;
        case "already_applied":
          json(res, { approval: outcome.approval, changeRequest: outcome.request, status: "ok" });
          return true;
        case "apply_failed":
          json(res, { status: "error", error: outcome.error, approval: outcome.approval, changeRequest: outcome.request }, 400);
          return true;
        case "applied":
          json(res, { approval: outcome.approval, changeRequest: outcome.request, status: "ok" });
          return true;
      }
      // Unreachable — every outcome status returns above; guard so a future
      // outcome variant can never fall through into the non-org-change branches.
      return true;
    }

    try {
      const outcome = approveOrdinaryApproval(approval, { principal, reviewedRevision, actor }, context);
      json(res, { approval: outcome.approval, ...(outcome.session ? { session: serializeSession(outcome.session, context) } : {}) });
    } catch (error) {
      if (!(error instanceof ApprovalOperationError)) throw error;
      json(res, { error: error.message }, error.status);
    }
    return true;
  }

  approvalParams = matchRoute("/api/approvals/:id/reject", pathname);
  if (method === "POST" && approvalParams) {
    const approval = getApproval(approvalParams.id);
    if (!approval) {
      notFound(res);
      return true;
    }
    const principal = (req as HttpRequest & { cuttlefishPrincipal?: GatewayPrincipal }).cuttlefishPrincipal;
    if (principal?.kind === "session" && !isAuthorizedHumanDelegatePrincipal(principal, ["decide"], undefined, approval.sessionId)) {
      json(res, { error: "This session does not have explicit delegated decision authority" }, 403);
      return true;
    }
    if (approval.type === "checkpoint") {
      json(res, { error: "checkpoint approvals must be resolved via POST /api/checkpoints/:id/decision" }, 409);
      return true;
    }
    if (approval.state === "pending") assertApprovalDecisionAuthority(approval, principal, reviewedRevision, ["decide"]);
    const actor = approvalActor(req, context);
    try {
      const outcome = approval.type === "org-change"
        ? await rejectOrgApproval(approval, { principal, reviewedRevision, actor }, context)
        : rejectOrdinaryApproval(approval, { principal, reviewedRevision, actor }, context);
      json(res, outcome);
    } catch (error) {
      if (!(error instanceof ApprovalOperationError)) throw error;
      json(res, { error: error.message }, error.status);
    }
    return true;
  }

  return false;
}
