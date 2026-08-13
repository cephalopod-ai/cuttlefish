import { createSession, getSession, insertMessage } from "../sessions/registry.js";
import type { GatewayPrincipal } from "./auth.js";
import type { ApiContext } from "./api/context.js";
import { evaluateCrossRequestChain, resolveCrossRequestIdentity } from "./cross-request-guards.js";
import { isHrHumanOnlyBlocked } from "./manager-auth.js";
import { dispatchEmployeeSessionRun } from "./mid-pair-orchestrator.js";
import { isActiveEmployee, scanOrg } from "./org.js";
import {
  buildCrossRequestBrief,
  buildOrgServices,
  findServiceProvider,
} from "./org-services.js";

export interface CrossRequestResult {
  statusCode: number;
  body: Record<string, unknown>;
}

/** Resolve, persist, and dispatch a cross-employee service request. */
export async function createCrossRequest(
  body: Record<string, unknown>,
  principal: GatewayPrincipal | undefined,
  context: ApiContext,
): Promise<CrossRequestResult> {
  const fromEmployee = typeof body.fromEmployee === "string" ? body.fromEmployee.trim() : "";
  const serviceName = typeof body.service === "string" ? body.service.trim() : "";
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  let parentSessionId = typeof body.parentSessionId === "string" && body.parentSessionId.trim()
    ? body.parentSessionId.trim()
    : undefined;
  const identity = resolveCrossRequestIdentity({
    principal,
    fromEmployee,
    parentSessionId,
    lookup: { getSession },
  });
  if (!identity.ok) return { statusCode: 403, body: { error: identity.error, code: identity.code } };
  parentSessionId = identity.parentSessionId;
  if (!fromEmployee) return { statusCode: 400, body: { error: "fromEmployee must be a non-empty string" } };
  if (!serviceName) return { statusCode: 400, body: { error: "service must be a non-empty string" } };
  if (!prompt) return { statusCode: 400, body: { error: "prompt must be a non-empty string" } };
  if (parentSessionId && !getSession(parentSessionId)) {
    return { statusCode: 404, body: { error: "Not found" } };
  }

  const registry = scanOrg();
  const requester = registry.get(fromEmployee);
  if (!requester || !isActiveEmployee(requester)) {
    return { statusCode: 404, body: { error: "Not found" } };
  }
  const availableServices = buildOrgServices(registry);
  const provider = findServiceProvider(registry, serviceName);
  if (!provider) {
    return {
      statusCode: 422,
      body: {
        error: `No active provider is registered for service "${serviceName}"`,
        code: "no_service_provider",
        requestedService: serviceName,
        availableServices,
      },
    };
  }
  if (isHrHumanOnlyBlocked(provider.employee.name, { isDirectTopLevelHumanRequest: false })) {
    return {
      statusCode: 403,
      body: {
        error: "HR / Org Steward accepts direct top-level requests from a human operator only",
        code: "hr_human_only",
      },
    };
  }
  const engine = context.sessionManager.getEngine(provider.employee.engine);
  if (!engine) {
    return { statusCode: 500, body: { error: `Provider engine "${provider.employee.engine}" is not available` } };
  }
  const chainGuard = evaluateCrossRequestChain({
    parentSessionId,
    fromEmployee: requester.name,
    provider: provider.employee.name,
    lookup: { getSession },
  });
  if (!chainGuard.ok) {
    return {
      statusCode: 409,
      body: {
        error: chainGuard.error,
        code: chainGuard.code,
        requestedService: serviceName,
        chain: chainGuard.chain,
      },
    };
  }

  const { resolveOrgHierarchy, resolveCrossRequestRoute, withPortalExecutive } = await import("./org-hierarchy.js");
  const config = context.getConfig();
  const hierarchy = resolveOrgHierarchy(withPortalExecutive(registry, config.portal?.portalName, config));
  const routed = resolveCrossRequestRoute(requester.name, provider.employee.name, hierarchy);
  const brief = buildCrossRequestBrief({ requester, service: provider.service, prompt });
  const now = Date.now();
  const session = createSession({
    engine: provider.employee.engine,
    source: "web",
    sourceRef: `cross-request:${now}:${provider.employee.name}`,
    connector: "web",
    sessionKey: `cross-request:${now}:${provider.employee.name}`,
    replyContext: { source: "web" },
    employee: provider.employee.name,
    parentSessionId,
    model: provider.employee.model,
    effortLevel: provider.employee.effortLevel,
    title: `Cross request: ${provider.service.name}`,
    prompt: brief,
    promptExcerpt: prompt,
    portalName: config.portal?.portalName,
    transportMeta: {
      crossRequest: {
        fromEmployee: requester.name,
        service: provider.service.name,
        provider: provider.employee.name,
        route: routed.route,
        managers: routed.managers,
        ...(parentSessionId ? { requesterSessionId: parentSessionId } : {}),
      },
    },
  });
  insertMessage(session.id, "user", brief);
  void dispatchEmployeeSessionRun(session, brief, engine, config, context, provider.employee);
  context.emit("session:created", { sessionId: session.id, employee: provider.employee.name });
  if (session.parentSessionId) {
    const talkParent = getSession(session.parentSessionId);
    if (talkParent?.source === "talk") {
      context.emit("talk:focus", { cooId: session.id, label: provider.service.name, parentId: talkParent.id });
    }
  }
  return {
    statusCode: 201,
    body: {
      sessionId: session.id,
      provider: {
        name: provider.employee.name,
        displayName: provider.employee.displayName,
        department: provider.employee.department,
      },
      route: routed.route,
      managers: routed.managers,
      service: provider.service.name,
    },
  };
}
