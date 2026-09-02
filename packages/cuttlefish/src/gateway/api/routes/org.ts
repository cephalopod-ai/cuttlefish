import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { ORG_DIR } from "../../../shared/paths.js";
import { logger } from "../../../shared/logger.js";
import { getSession, listSessions } from "../../../sessions/registry.js";
import { readJsonBody } from "../../http-helpers.js";
import { isDirectChildSession } from "../../manager-auth.js";
import type { GatewayPrincipal } from "../../auth.js";
import { defaultBoardState, readBoardArray, readBoardState } from "../../board-service.js";
import { resolveBestSessionForTicket, resolveTicketSessionFallbackState, resolveTicketSessionFailureReason, resolveTicketSessionStalled, shouldExposeSessionForTicket } from "../../ticket-session-resolver.js";
import { dispatchTicket } from "../../ticket-dispatch.js";
import { scanOrg } from "../../org.js";
import { buildOrgServices, computeExecutionProfileSummary, listOrgDepartments } from "../../org-services.js";
import { parseChangeInput } from "../../org-validation.js";
import { resolveUserHeader } from "../../connector-reply.js";
import type { ApiContext } from "../context.js";
import { matchRoute } from "../match-route.js";
import { badRequest, json, notFound, serverError } from "../responses.js";
import { loadSessionMessagesForApi } from "../session-query-routes.js";
import type { OrgWarning } from "../../../shared/types.js";
import {
  applyApprovedOrgChange,
  approveOrgChange,
  createOrgEmployee,
  deleteOrgEmployee,
  rejectOrgChange,
  renameOrgDepartment,
  submitOrgChangeRequest,
  updateDepartmentBoard,
  updateOrgEmployee,
} from "../../org-mutation-service.js";
import { createCrossRequest } from "../../cross-request-service.js";
import { appendExternalA2AServices } from "../../../a2a/external-services.js";

const TICKET_SESSION_TAIL_LIMIT = 8;

async function reconcileDepartmentBoardView(department: string, context: ApiContext): Promise<void> {
  const { reconcileDepartmentOrphanedTickets } = await import("../../orphaned-ticket-reconciler.js");
  reconcileDepartmentOrphanedTickets(department, {
    engines: context.sessionManager?.getEngines?.() ?? new Map(),
    orgDir: ORG_DIR,
    getSession,
    listSessions,
    emit: context.emit,
    cause: "periodic",
  });
}

export async function handleOrgRoutes(
  method: string,
  pathname: string,
  req: HttpRequest,
  res: ServerResponse,
  context: ApiContext,
): Promise<boolean> {
  let params = matchRoute("/api/org/employees/:name", pathname);

  if (method === "GET" && pathname === "/api/org") {
    if (!fs.existsSync(ORG_DIR)) {
      json(res, { departments: [], employees: [], hierarchy: { root: null, sorted: [], warnings: [] } });
      return true;
    }
    const { resolveOrgHierarchy, withPortalExecutive } = await import("../../org-hierarchy.js");
    const scanWarnings: OrgWarning[] = [];
    const config = context.getConfig();
    const orgRegistry = withPortalExecutive(scanOrg(scanWarnings), config.portal?.portalName, config);
    const { directoryDepartments, departments } = listOrgDepartments(ORG_DIR, orgRegistry);
    const hierarchy = resolveOrgHierarchy(orgRegistry);
    const employees = hierarchy.sorted.map((name) => {
      const node = hierarchy.nodes[name];
      const emp = node.employee;
      const { persona, ...rest } = emp;
      return {
        ...rest,
        parentName: node.parentName,
        directReports: node.directReports,
        depth: node.depth,
        chain: node.chain,
        executionProfileSummary: computeExecutionProfileSummary(emp),
      };
    });
    json(res, {
      departments,
      boardDepartments: directoryDepartments,
      employees,
      hierarchy: {
        root: hierarchy.root,
        sorted: hierarchy.sorted,
        // Parse failures happen inside scanOrg, before the hierarchy is even
        // built, so they're surfaced here alongside (not inside)
        // resolveOrgHierarchy's own structural warnings (broken refs, cycles).
        warnings: [...scanWarnings, ...hierarchy.warnings],
      },
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/org/services") {
    json(res, {
      services: appendExternalA2AServices(buildOrgServices(scanOrg()), context.getConfig()),
    });
    return true;
  }

  if (method === "POST" && pathname === "/api/org/cross-request") {
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    const body = parsed.body as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      badRequest(res, "body must be a JSON object");
      return true;
    }
    const principal = (req as HttpRequest & { cuttlefishPrincipal?: GatewayPrincipal }).cuttlefishPrincipal;
    const result = await createCrossRequest(body, principal, context);
    json(res, result.body, result.statusCode);
    return true;
  }

  if (method === "GET" && params) {
    const orgRegistry = scanOrg();
    const { resolveOrgHierarchy, withPortalExecutive } = await import("../../org-hierarchy.js");
    const config = context.getConfig();
    const hierarchyRegistry = withPortalExecutive(orgRegistry, config.portal?.portalName, config);
    const emp = orgRegistry.get(params.name) ?? hierarchyRegistry.get(params.name);
    if (!emp) {
      notFound(res);
      return true;
    }
    const hierarchy = resolveOrgHierarchy(hierarchyRegistry);
    const node = hierarchy.nodes[params.name];
    json(res, {
      ...emp,
      parentName: node?.parentName ?? null,
      directReports: node?.directReports ?? [],
      depth: node?.depth ?? 0,
      chain: node?.chain ?? [params.name],
      executionProfileSummary: computeExecutionProfileSummary(emp),
    });
    return true;
  }

  if (method === "POST" && pathname === "/api/org/employees") {
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    const body = parsed.body as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      badRequest(res, "employee body must be a JSON object");
      return true;
    }
    const result = await createOrgEmployee(body, context);
    json(res, result.body, result.statusCode);
    return true;
  }

  params = matchRoute("/api/org/employees/:name", pathname);
  if (method === "PATCH" && params) {
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    const body = parsed.body as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      badRequest(res, "update body must be a JSON object");
      return true;
    }
    const principal = (req as HttpRequest & { cuttlefishPrincipal?: GatewayPrincipal }).cuttlefishPrincipal;
    const result = await updateOrgEmployee(params.name, body, principal, context);
    json(res, result.body, result.statusCode);
    return true;
  }

  if (method === "DELETE" && params) {
    const result = await deleteOrgEmployee(params.name, context);
    json(res, result.body, result.statusCode);
    return true;
  }

  // --- Org change requests (HR / Org Steward) ---------------------------------
  // Phase 1 is draft-only: validate + create/list/get change requests. The
  // critique pipeline (pending_critique → pending_approval) and approve→apply
  // routes are layered on in later phases without changing these surfaces.

  if (method === "POST" && pathname === "/api/org/validate") {
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    const input = parseChangeInput(parsed.body);
    if (!input.ok) {
      badRequest(res, input.error);
      return true;
    }
    const { validateOrgChange } = await import("../../org.js");
    const result = validateOrgChange(context.getConfig(), input.value);
    json(res, { ok: result.ok, error: result.error ?? null });
    return true;
  }

  if (method === "POST" && pathname === "/api/org/change-requests") {
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    const body = parsed.body as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      badRequest(res, "change request body must be a JSON object");
      return true;
    }
    const principal = (req as HttpRequest & { cuttlefishPrincipal?: GatewayPrincipal }).cuttlefishPrincipal;
    const result = await submitOrgChangeRequest(body, principal, context);
    json(res, result.body, result.statusCode);
    return true;
  }

  if (method === "GET" && pathname === "/api/org/retired") {
    const { listRetiredEmployees } = await import("../../org.js");
    const employees = listRetiredEmployees().map(({ persona, ...rest }) => rest);
    json(res, { employees });
    return true;
  }

  if (method === "GET" && pathname === "/api/org/change-requests") {
    const { listChangeRequests } = await import("../../org-changes.js");
    const query = new URL(req.url ?? "/", "http://localhost").searchParams;
    const statusParam = query.get("status");
    const statuses = statusParam
      ? statusParam.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
    const requests = listChangeRequests(statuses ? { status: statuses as never } : undefined);
    json(res, { changeRequests: requests });
    return true;
  }

  params = matchRoute("/api/org/change-requests/:id", pathname);
  if (method === "GET" && params) {
    const { getChangeRequest } = await import("../../org-changes.js");
    const request = getChangeRequest(params.id);
    if (!request) {
      notFound(res);
      return true;
    }
    json(res, request);
    return true;
  }

  params = matchRoute("/api/org/change-requests/:id/approve", pathname);
  if (method === "POST" && params) {
    const actor = resolveUserHeader(req.headers, context.getConfig().gateway.userHeader);
    const result = await approveOrgChange(params.id, actor, context);
    json(res, result.body, result.statusCode);
    return true;
  }

  params = matchRoute("/api/org/change-requests/:id/reject", pathname);
  if (method === "POST" && params) {
    const actor = resolveUserHeader(req.headers, context.getConfig().gateway.userHeader);
    const result = await rejectOrgChange(params.id, actor, context);
    json(res, result.body, result.statusCode);
    return true;
  }

  params = matchRoute("/api/org/change-requests/:id/apply", pathname);
  if (method === "POST" && params) {
    const actor = resolveUserHeader(req.headers, context.getConfig().gateway.userHeader);
    const result = await applyApprovedOrgChange(params.id, actor, context);
    json(res, result.body, result.statusCode);
    return true;
  }

  params = matchRoute("/api/org/departments/:name", pathname);
  if (method === "PATCH" && params) {
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    const body = parsed.body as Record<string, unknown>;
    const nextName = typeof body.name === "string" ? body.name.trim() : "";
    const result = await renameOrgDepartment(params.name, nextName, context);
    json(res, result.body, result.statusCode);
    return true;
  }

  params = matchRoute("/api/org/departments/:name/board", pathname);
  if (method === "GET" && params) {
    const deptDir = path.join(ORG_DIR, params.name);
    if (!fs.existsSync(deptDir)) {
      notFound(res);
      return true;
    }
    const boardPath = path.join(deptDir, "board.json");
    if (!fs.existsSync(boardPath)) {
      // The department exists but has no board yet — that's an empty board, not a
      // missing resource. Returning 200 with an empty state (instead of 404) keeps
      // the dashboard's per-department board fetches quiet: a brand-new org has no
      // board.json until the first ticket is written, and a 404 there only produces
      // console-error noise on every poll that could mask a real failure.
      json(res, defaultBoardState());
      return true;
    }
    try {
      await reconcileDepartmentBoardView(params.name, context);
      const board = readBoardState(ORG_DIR, params.name) ?? defaultBoardState();
      json(res, board);
    } catch (err) {
      logger.warn(`GET /api/org/departments/${params.name}/board: corrupt board.json — ${err instanceof Error ? err.message : String(err)}`);
      serverError(res, "board.json is corrupt");
    }
    return true;
  }

  params = matchRoute("/api/org/departments/:name/tickets/:id/session", pathname);
  if (method === "GET" && params) {
    const routeParams = params;
    let board: import("../../board-service.js").BoardTicket[] | null;
    try {
      await reconcileDepartmentBoardView(routeParams.name, context);
      board = readBoardArray(ORG_DIR, routeParams.name);
    } catch (err) {
      logger.warn(`GET /api/org/departments/${routeParams.name}/tickets/${routeParams.id}/session: corrupt board.json — ${err instanceof Error ? err.message : String(err)}`);
      serverError(res, "board.json is corrupt");
      return true;
    }
    const ticket = board?.find((entry) => entry?.id === routeParams.id);
    if (!ticket) {
      json(res, { found: false });
      return true;
    }
    const session = resolveBestSessionForTicket(ticket, listSessions());
    if (!session) {
      json(res, { found: false });
      return true;
    }
    if (!shouldExposeSessionForTicket(ticket, session)) {
      json(res, { found: false });
      return true;
    }
    // SEC-002: scopedTokenForbidden only blocks non-GET verbs under /api/org/*
    // ("roster is readable"), so this GET route was reachable by any
    // session-scoped agent token with no check that the caller has anything
    // to do with `session` — shouldExposeSessionForTicket only inspects
    // ticket/session *status*, never caller identity. Require the caller to
    // be the session itself or its direct parent, mirroring the same
    // isDirectChildSession primitive auth-gate.ts already uses for the
    // analogous /api/sessions/:id case.
    const principal = (req as HttpRequest & { cuttlefishPrincipal?: GatewayPrincipal }).cuttlefishPrincipal;
    if (
      principal?.kind === "session" &&
      principal.sessionId.toLowerCase() !== session.id.toLowerCase() &&
      !isDirectChildSession(principal.sessionId, session.id)
    ) {
      json(res, { found: false });
      return true;
    }
    const detail = loadSessionMessagesForApi(session.id, context, String(TICKET_SESSION_TAIL_LIMIT));
    if (!detail) {
      json(res, { found: false });
      return true;
    }
    const lastActivityMs = Date.parse(detail.session.lastActivity || "");
    const lastActivityAgoMs = Number.isFinite(lastActivityMs) ? Math.max(0, Date.now() - lastActivityMs) : null;
    const stalled = resolveTicketSessionStalled(detail.session);
    const fallback = resolveTicketSessionFallbackState(detail.session);
    json(res, {
      found: true,
      sessionId: detail.session.id,
      status: detail.session.status,
      engine: detail.session.engine,
      model: detail.session.model,
      employee: detail.session.employee,
      totalCost: detail.session.totalCost,
      lastActivityIso: detail.session.lastActivity,
      lastActivityAgoMs,
      stalled,
      stalledForMs: stalled ? lastActivityAgoMs : null,
      failureReason: resolveTicketSessionFailureReason(detail.session),
      fallback,
      lastError: detail.session.lastError,
      messages: detail.messages.map((message) => ({
        role: message.role,
        text: message.content,
        ts: message.timestamp,
        kind: message.toolCall ? "tool_call" : message.partial ? "partial" : message.role === "notification" ? "notification" : "message",
        toolCall: message.toolCall,
      })),
    });
    return true;
  }

  params = matchRoute("/api/org/departments/:name/tickets/:id/dispatch", pathname);
  if (method === "POST" && params) {
    const body = req.method === "POST" ? await readJsonBody(req, res).then((r) => (r.ok ? r.body : {})) : {};
    const routeToManager = (body as Record<string, unknown>).routeToManager === true;
    const result = await dispatchTicket(
      params.name,
      params.id,
      { source: "manual", routeToManager },
      { context, orgDir: ORG_DIR },
    );
    if (!result.ok) {
      if (result.reason === "no-assignee") {
        json(res, { reason: result.reason, error: "Assign someone first." }, 400);
        return true;
      }
      if (result.reason === "foreign-department-assignee") {
        json(res, { reason: result.reason, error: "Assignee does not belong to this department." }, 400);
        return true;
      }
      if (result.reason === "employee-not-active") {
        json(res, { reason: result.reason, error: "Assigned agent is not active (draft, disabled, or retired)." }, 409);
        return true;
      }
      if (result.reason === "already-running") {
        json(res, { reason: result.reason, error: "Ticket already has a running session." }, 409);
        return true;
      }
      if (result.reason === "manual-only") {
        json(res, { reason: result.reason, error: "This ticket is marked manual only and cannot be auto-dispatched." }, 409);
        return true;
      }
      if (result.reason === "invalid-resource") {
        json(res, { reason: result.reason, error: "Ticket resource path or URL is invalid for this gateway." }, 400);
        return true;
      }
      if (result.reason === "resource-blocked") {
        json(res, { reason: result.reason, error: "Ticket resource was blocked by untrusted-content screening." }, 409);
        return true;
      }
      if (result.reason.startsWith("orchestration-")) {
        json(res, { reason: result.reason, error: result.reason }, 409);
        return true;
      }
      if (result.reason === "not-found") {
        notFound(res);
        return true;
      }
      json(res, { reason: result.reason, error: result.reason }, 404);
      return true;
    }
    json(res, { status: "ok", sessionId: result.sessionId });
    return true;
  }

  params = matchRoute("/api/org/departments/:name/board", pathname);
  if (method === "PUT" && params) {
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    const result = updateDepartmentBoard(params.name, parsed.body, context);
    json(res, result.body, result.statusCode);
    return true;
  }

  return false;
}
