import { randomUUID } from "node:crypto";
import { getModelRegistry } from "../shared/models.js";
import { logger } from "../shared/logger.js";
import type { CuttlefishConfig } from "../shared/types.js";
import {
  resolveModelAlias,
  validateCwd,
  validateNewSessionSelection,
} from "../sessions/session-patch.js";
import {
  coercePortalEmployee,
  createSession,
  deleteSession,
  enqueueQueueItem,
  getSession,
  hasPendingQueueItemBefore,
  insertMessage,
  updateSession,
} from "../sessions/registry.js";
import {
  buildOperatorDelegationGrant,
  HUMAN_DELEGATION_MODELS_LABEL,
  isHumanDelegateRole,
  isHumanDelegationModelAllowed,
  parseOperatorDelegationScopes,
} from "../sessions/operator-delegation.js";
import { maybeEmitTalkGraph } from "../talk/graph.js";
import type { GatewayPrincipal } from "./auth.js";
import type { ApiContext } from "./api/context.js";
import {
  dispatchPendingWebQueueHeadForSessionKey,
  maybeRevertEngineOverride,
} from "./api/session-dispatch.js";
import { serializeSession } from "./api/serialize-session.js";
import { fileIdsToMedia } from "./files.js";
import { findHrSessionProfileConflict, getReusableHrSession } from "./hr-session.js";
import { isHrHumanOnlyBlocked } from "./manager-auth.js";
import { dispatchEmployeeSessionRun } from "./mid-pair-orchestrator.js";
import { HR_EMPLOYEE_NAME, HR_SESSION_KEY } from "./org-policy.js";
import { attachResourcesToSession } from "./session-resources.js";
import {
  buildWorkspaceProfilePrompt,
  resolveWorkspaceProfile,
  type ResolvedWorkspaceProfile,
} from "./workspace-profiles.js";

export interface CreateSessionInput {
  body: Record<string, unknown>;
  context: ApiContext;
  principal?: GatewayPrincipal;
  userId?: string | null;
}

export interface CreateSessionResult {
  statusCode: number;
  body: Record<string, unknown>;
}

function configuredEngineModel(config: CuttlefishConfig, engine: string): string | undefined {
  return (config.engines as unknown as Record<string, { model?: string } | undefined>)[engine]?.model;
}

function singletonEmployeeSessionKey(employeeName: string | null | undefined): string | null {
  return employeeName === HR_EMPLOYEE_NAME ? HR_SESSION_KEY : null;
}

function canonicalizeExistingHrProfile(
  session: Pick<import("../shared/types.js").Session, "engine" | "model" | "effortLevel" | "cwd">,
  config: CuttlefishConfig,
): Pick<import("../shared/types.js").Session, "engine" | "model" | "effortLevel" | "cwd"> {
  if (!session.model) return session;
  const knownModelIds = new Set((getModelRegistry(config)[session.engine]?.models ?? []).map((model) => model.id));
  const canonicalModel = resolveModelAlias(session.engine, session.model, knownModelIds);
  return canonicalModel === session.model ? session : { ...session, model: canonicalModel };
}

/**
 * Validate, persist, queue, and dispatch a new web session.
 *
 * The HTTP route owns JSON parsing and response translation; this service owns
 * the session/profile/delegation invariants and lifecycle transitions.
 */
export async function createSessionFromRequest(input: CreateSessionInput): Promise<CreateSessionResult> {
  const { body, context, principal, userId } = input;
  const prompt = (typeof body.prompt === "string" ? body.prompt : typeof body.message === "string" ? body.message : "").trim();
  if (!prompt) return { statusCode: 400, body: { error: "prompt or message is required" } };

  // Best-effort early rejection; dispatchEmployeeSessionRun still owns the
  // authoritative permit for the complete run.
  if (context.runSemaphore) {
    const probeRelease = context.runSemaphore.tryAcquire(context.getConfig().sessions?.maxConcurrentRuns);
    if (!probeRelease) {
      return { statusCode: 429, body: { error: "Too many concurrent runs — retry shortly", retryAfterMs: 2000 } };
    }
    probeRelease();
  }

  const config = context.getConfig();
  let workspaceProfile: ResolvedWorkspaceProfile | undefined;
  if (body.workspaceProfile !== undefined && body.workspaceProfile !== null && body.workspaceProfile !== "") {
    const resolved = resolveWorkspaceProfile(config, body.workspaceProfile);
    if (!resolved.ok) return { statusCode: resolved.status, body: { error: resolved.error } };
    workspaceProfile = resolved.profile;
  }
  const dispatchPrompt = workspaceProfile ? buildWorkspaceProfilePrompt(workspaceProfile, prompt) : prompt;
  const employeeName = coercePortalEmployee(body.employee as string | null | undefined, config.portal?.portalName);
  const isParentedRequest = typeof body.parentSessionId === "string" && body.parentSessionId.trim().length > 0;
  if (principal?.kind === "session" && [body.cwd, body.workspaceProfile, body.engine, body.model, body.effortLevel]
    .some((value) => value !== undefined && value !== null && value !== "")) {
    return {
      statusCode: 403,
      body: {
        error: "Session-scoped callers cannot override child workspace or engine selection",
        code: "session_child_profile_forbidden",
      },
    };
  }
  if (isHrHumanOnlyBlocked(employeeName, {
    isDirectTopLevelHumanRequest: !isParentedRequest && principal?.kind === "admin",
  })) {
    return {
      statusCode: 403,
      body: {
        error: "HR / Org Steward accepts direct top-level requests from a human operator only",
        code: "hr_human_only",
      },
    };
  }

  let employeeDefaults: { engine: string; model: string; effortLevel?: string } | undefined;
  if (employeeName) {
    const { scanOrg } = await import("./org.js");
    const employee = scanOrg().get(employeeName);
    if (employee) {
      employeeDefaults = { engine: employee.engine, model: employee.model };
      if (employee.effortLevel) employeeDefaults.effortLevel = employee.effortLevel;
    }
  }
  const selection = validateNewSessionSelection(config, {
    engine: body.engine,
    model: body.model,
    effortLevel: body.effortLevel,
  }, employeeDefaults);
  if (!selection.ok) {
    return { statusCode: 400, body: { error: selection.error || "invalid engine/model/effort" } };
  }

  let cwd: string | undefined = workspaceProfile?.cwd;
  if (body.cwd !== undefined) {
    const validatedCwd = validateCwd(body.cwd, { roots: config.workspaces?.roots });
    if (!validatedCwd.ok) {
      return { statusCode: 400, body: { error: validatedCwd.error || "invalid cwd" } };
    }
    cwd = validatedCwd.cwd;
  }

  const engineName = selection.engine || config.engines.default;
  const delegationModel = selection.model ?? configuredEngineModel(config, engineName);
  const singletonSessionKey = singletonEmployeeSessionKey(employeeName);
  const sessionKey = singletonSessionKey ?? `web:${randomUUID()}`;
  const requestedDelegationScopes = parseOperatorDelegationScopes(prompt);
  if (requestedDelegationScopes) {
    if (principal?.kind !== "admin") {
      return {
        statusCode: 403,
        body: { error: "Only a direct human operator message can delegate operator authority", code: "operator_delegation_human_only" },
      };
    }
    if (!isHumanDelegateRole(employeeName, "web")) {
      return {
        statusCode: 403,
        body: { error: "Human-delegated authority is limited to Cuttlefish (COO) and Program Manager", code: "operator_delegation_role_forbidden" },
      };
    }
    if (!isHumanDelegationModelAllowed(engineName, delegationModel)) {
      return {
        statusCode: 403,
        body: { error: `Human-delegated authority requires one of: ${HUMAN_DELEGATION_MODELS_LABEL}`, code: "operator_delegation_model_forbidden" },
      };
    }
  }

  const operatorDelegation = requestedDelegationScopes
    ? buildOperatorDelegationGrant({ prompt: dispatchPrompt, scopes: requestedDelegationScopes, grantedBy: userId })
    : undefined;
  const existingSingletonSession = singletonSessionKey ? getReusableHrSession() : undefined;
  const requestedHrProfile = existingSingletonSession
    ? {
        ...(body.engine !== undefined ? { engine: engineName } : {}),
        ...(body.model !== undefined && selection.model !== undefined ? { model: selection.model } : {}),
        ...(body.effortLevel !== undefined && selection.effortLevel !== undefined ? { effortLevel: selection.effortLevel } : {}),
        ...(body.cwd !== undefined || workspaceProfile?.cwd !== undefined ? { cwd: cwd ?? null } : {}),
      }
    : undefined;
  const hrSingletonConfigurationConflict = existingSingletonSession && requestedHrProfile
    ? findHrSessionProfileConflict(canonicalizeExistingHrProfile(existingSingletonSession, config), {
        ...(requestedHrProfile.engine !== undefined ? { engine: requestedHrProfile.engine } : {}),
        ...(requestedHrProfile.cwd !== undefined ? { cwd: requestedHrProfile.cwd } : {}),
      })
    : null;
  if (hrSingletonConfigurationConflict && existingSingletonSession) {
    return {
      statusCode: 409,
      body: {
        error: `HR singleton session cannot switch ${hrSingletonConfigurationConflict.field} from ${hrSingletonConfigurationConflict.existing ?? "default"} to ${hrSingletonConfigurationConflict.requested ?? "default"}; continue it without an override or start a separate non-HR session.`,
        code: "hr_singleton_profile_conflict",
        sessionId: existingSingletonSession.id,
        field: hrSingletonConfigurationConflict.field,
      },
    };
  }

  let session = existingSingletonSession
    ? maybeRevertEngineOverride(existingSingletonSession)
    : createSession({
        engine: engineName,
        source: "web",
        sourceRef: sessionKey,
        connector: "web",
        sessionKey,
        replyContext: { source: "web" },
        userId,
        employee: employeeName,
        parentSessionId: typeof body.parentSessionId === "string" ? body.parentSessionId : undefined,
        effortLevel: selection.effortLevel,
        model: operatorDelegation ? delegationModel : selection.model,
        prompt: dispatchPrompt,
        promptExcerpt: typeof body.promptExcerpt === "string" ? body.promptExcerpt : prompt,
        cwd,
        portalName: config.portal?.portalName,
        transportMeta: (workspaceProfile || operatorDelegation
          ? {
              ...(operatorDelegation ? { operatorDelegation } : {}),
              ...(workspaceProfile ? {
                workspaceProfile: {
                  id: workspaceProfile.id,
                  label: workspaceProfile.label,
                  cwd: workspaceProfile.cwd ?? null,
                },
              } : {}),
            }
          : undefined) as never,
      });
  if (existingSingletonSession && requestedHrProfile
    && (requestedHrProfile.model !== undefined || requestedHrProfile.effortLevel !== undefined)) {
    session = updateSession(session.id, {
      ...(requestedHrProfile.model !== undefined ? { model: requestedHrProfile.model } : {}),
      ...(requestedHrProfile.effortLevel !== undefined ? { effortLevel: requestedHrProfile.effortLevel } : {}),
    }) ?? session;
    context.emit("session:updated", { sessionId: session.id });
  }
  if (!existingSingletonSession) {
    logger.info(`Web session created: ${session.id} (model=${selection.model || "default"})`);
    if (session.parentSessionId) {
      const talkParent = getSession(session.parentSessionId);
      if (talkParent?.source === "talk") {
        const label = String(body.employee || prompt || "task").replace(/\s+/g, " ").trim().slice(0, 48);
        context.emit("talk:focus", { cooId: session.id, label, parentId: talkParent.id });
      }
    }
    maybeEmitTalkGraph(session.id, "added", { getSession, emit: context.emit });
  }

  const newSessionMedia = fileIdsToMedia(body.attachments);
  let attached;
  try {
    attached = await attachResourcesToSession(session, body, context);
  } catch (err) {
    if (!existingSingletonSession) {
      try {
        deleteSession(session.id);
        maybeEmitTalkGraph(session.id, "removed", { getSession, emit: context.emit });
        context.emit("session:deleted", { sessionId: session.id });
      } catch {
        // The original resource error remains the actionable failure.
      }
    }
    return { statusCode: 400, body: { error: err instanceof Error ? err.message : "invalid resources" } };
  }
  session = attached.session;

  let dispatchEmployee: import("../shared/types.js").Employee | undefined;
  if (employeeName && !session.parentSessionId) {
    const { scanOrg } = await import("./org.js");
    dispatchEmployee = scanOrg().get(employeeName);
  }
  insertMessage(session.id, "user", prompt, newSessionMedia.length > 0 ? newSessionMedia : undefined);

  const dispatchEngineName = session.engine || engineName;
  const ptyEngine = body.mode === "interactive" ? context.ptyViewEngines?.[dispatchEngineName] : undefined;
  const engine = ptyEngine ?? context.sessionManager.getEngine(dispatchEngineName);
  if (!engine) {
    const lastError = `Engine "${dispatchEngineName}" not available`;
    updateSession(session.id, { status: "error", lastError });
    return {
      statusCode: 201,
      body: serializeSession({ ...session, status: "error", lastError }, context),
    };
  }
  if (attached.blocked) return { statusCode: 201, body: serializeSession(session, context) };

  const singletonWasRunning = Boolean(existingSingletonSession && session.status === "running");
  if (session.status === "interrupted" || session.status === "idle") {
    session = updateSession(session.id, {
      status: "running",
      lastActivity: new Date().toISOString(),
      lastError: null,
    }) ?? { ...session, status: "running", lastError: null };
  }

  const queueSessionKey = session.sessionKey || session.sourceRef || session.id;
  const queueItemId = enqueueQueueItem(session.id, queueSessionKey, dispatchPrompt);
  context.emit("queue:updated", { sessionId: session.id, sessionKey: queueSessionKey });
  if (singletonWasRunning) context.emit("session:queued", { sessionId: session.id, message: prompt });
  if (hasPendingQueueItemBefore(queueSessionKey, queueItemId)) {
    dispatchPendingWebQueueHeadForSessionKey(context, queueSessionKey);
  } else {
    dispatchEmployeeSessionRun(session, dispatchPrompt, engine, config, context, dispatchEmployee, {
      queueItemId,
      attachments: attached.engineAttachments.length > 0 ? attached.engineAttachments : undefined,
      resourceContext: attached.promptBlock,
    });
  }

  return { statusCode: 201, body: serializeSession(session, context) };
}
