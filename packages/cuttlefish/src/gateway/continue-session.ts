import { logger } from "../shared/logger.js";
import { isInterruptibleEngine, type CuttlefishConfig } from "../shared/types.js";
import {
  deletePartialMessages,
  enqueueQueueItem,
  getSession,
  hasPendingQueueItemBefore,
  insertMessage,
  listChildSessions,
  patchSessionTransportMeta,
  updateSession,
} from "../sessions/registry.js";
import { acknowledgeLeaderAck } from "../sessions/leader-ack.js";
import {
  buildOperatorDelegationGrant,
  OperatorDelegationPolicyError,
  isHumanDelegateRole,
  isHumanDelegationModelAllowed,
  parseOperatorDelegationScopes,
  type OperatorDelegationScope,
  HUMAN_DELEGATION_MODELS_LABEL,
} from "../sessions/operator-delegation.js";
import {
  claimManagerDelegationSynthesis,
  markManagerDelegationSynthesisDispatched,
} from "../sessions/manager-delegation.js";
import { maybeEmitTalkGraph } from "../talk/graph.js";
import type { GatewayPrincipal } from "./auth.js";
import type { ApiContext } from "./api/context.js";
import { maybeRevertEngineOverride } from "./api/session-dispatch.js";
import {
  dispatchPendingWebQueueHeadForSessionKey,
} from "./api/session-dispatch.js";
import { dispatchEmployeeSessionRun } from "./mid-pair-orchestrator.js";
import { supersedeRunningTurn } from "./session-turn-state.js";
import { attachResourcesToSession, attachmentMedia, describeSessionResources } from "./session-resources.js";
import { ArtifactAccessError, assertScopedArtifactReferences } from "./artifact-access.js";
import { buildSessionExecutionBoundary, queueDispatchAuthority } from "../sessions/execution-boundary.js";

export interface ContinueSessionInput {
  sessionId: string;
  body: Record<string, unknown>;
  context: ApiContext;
  principal?: GatewayPrincipal;
  userId?: string | null;
  /** Structured Management authority selection. When supplied, the visible
   * message does not need to contain the legacy delegation directive. */
  operatorDelegationScopes?: OperatorDelegationScope[];
}

export interface ContinueSessionResult {
  statusCode: number;
  body: Record<string, unknown>;
  insertedMessageId?: string;
}

function configuredEngineModel(config: CuttlefishConfig, engine: string): string | undefined {
  return (config.engines as unknown as Record<string, { model?: string } | undefined>)[engine]?.model;
}

export async function continueSession(input: ContinueSessionInput): Promise<ContinueSessionResult> {
  try {
    assertScopedArtifactReferences(input.body, input.principal);
  } catch (err) {
    if (!(err instanceof ArtifactAccessError)) throw err;
    return { statusCode: 403, body: { error: err.message, code: "artifact_scope_forbidden" } };
  }
  const existingSession = getSession(input.sessionId);
  if (!existingSession) return { statusCode: 404, body: { error: "Not found" } };
  if (input.principal?.kind === "session" && input.principal.sessionId !== existingSession.id
    && !(existingSession.parentSessionId === input.principal.sessionId && getSession(input.principal.sessionId)?.employee === null)) {
    return { statusCode: 403, body: { error: "Session is outside this task's scope", code: "session_scope_forbidden" } };
  }
  if (existingSession.executionBoundaryInvalid || (existingSession.executionBoundary?.cancelled && input.principal?.kind !== "admin")) {
    return { statusCode: 403, body: { error: "Execution boundary is unavailable or task was cancelled", code: "execution_authority_denied" } };
  }
  let session = maybeRevertEngineOverride(existingSession);
  const body = input.body;
  const prompt = (typeof body.message === "string" ? body.message : typeof body.prompt === "string" ? body.prompt : "").trim();
  if (!prompt) return { statusCode: 400, body: { error: "message is required" } };

  if (session.parentSessionId) {
    const talkParent = getSession(session.parentSessionId);
    if (talkParent?.source === "talk") {
      input.context.emit("talk:focus", { cooId: session.id, label: session.title || "", parentId: talkParent.id });
    }
  }
  maybeEmitTalkGraph(session.id, "status", { getSession, emit: input.context.emit });

  const messageRole = body.role === "notification" ? "notification" : "user";
  const isNotification = messageRole === "notification";
  const displayMessage = typeof body.displayMessage === "string" && body.displayMessage.trim()
    ? body.displayMessage
    : prompt;
  const config = input.context.getConfig();
  const legacyScopes = isNotification ? null : parseOperatorDelegationScopes(prompt);
  const requestedDelegationScopes = input.operatorDelegationScopes?.length
    ? input.operatorDelegationScopes
    : legacyScopes;
  if (requestedDelegationScopes) {
    if (input.principal?.kind !== "admin" || isNotification) {
      return { statusCode: 403, body: { error: "Only a direct human operator message can delegate operator authority", code: "operator_delegation_human_only" } };
    }
    if (!isHumanDelegateRole(session.employee, session.source)) {
      return { statusCode: 403, body: { error: "Human-delegated authority is limited to Cuttlefish (COO) and Program Manager", code: "operator_delegation_role_forbidden" } };
    }
    const delegationModel = session.model ?? configuredEngineModel(config, session.engine);
    if (!isHumanDelegationModelAllowed(session.engine, delegationModel)) {
      return { statusCode: 403, body: { error: `Human-delegated authority requires one of: ${HUMAN_DELEGATION_MODELS_LABEL}`, code: "operator_delegation_model_forbidden" } };
    }
    if (!session.model && delegationModel) session = updateSession(session.id, { model: delegationModel }) ?? session;
  }

  const ptyEngine = body.mode === "interactive" ? input.context.ptyViewEngines?.[session.engine] : undefined;
  const engine = ptyEngine ?? input.context.sessionManager.getEngine(session.engine);
  if (!engine) return { statusCode: 500, body: { error: `Engine "${session.engine}" not available` } };

  const userMedia = isNotification ? [] : attachmentMedia(body);
  let attached;
  if (isNotification) {
    attached = { session, ...describeSessionResources(session) };
  } else {
    try {
      attached = await attachResourcesToSession(session, body, input.context, input.principal);
    } catch (error) {
      if (error instanceof ArtifactAccessError) {
        return { statusCode: 403, body: { error: error.message, code: "artifact_scope_forbidden" } };
      }
      return { statusCode: 400, body: { error: error instanceof Error ? error.message : "invalid resources" } };
    }
  }
  // Resource resolution/screening can await while the current turn completes
  // or opens a checkpoint. Reject invalid input before touching that turn and
  // make the interruption decision from the fresh, persisted session below.
  const currentSession = getSession(session.id);
  if (!currentSession) return { statusCode: 404, body: { error: "Not found" } };
  session = currentSession;
  if (session.executionBoundaryInvalid || (session.executionBoundary?.cancelled && (input.principal?.kind !== "admin" || isNotification))) {
    return { statusCode: 403, body: { error: "Task was cancelled or its boundary is unavailable", code: "execution_authority_denied" } };
  }
  if (!isNotification && input.principal?.kind === "admin") {
    if (!session.executionBoundary || session.executionBoundary.cancelled) {
      session = updateSession(session.id, { executionBoundary: buildSessionExecutionBoundary({ origin: "operator",
        requirement: session.executionBoundary?.requirement, parent: session.parentSessionId ? getSession(session.parentSessionId) : undefined }) }) ?? session;
    }
    if (requestedDelegationScopes && (!isHumanDelegateRole(session.employee, session.source) || !isHumanDelegationModelAllowed(session.engine, session.model))) {
      return { statusCode: 403, body: { error: "Delegate eligibility changed", code: "operator_delegation_model_forbidden" } };
    }
    let grant;
    try {
      grant = requestedDelegationScopes ? buildOperatorDelegationGrant({ session, prompt, scopes: requestedDelegationScopes, grantedBy: input.userId }) : undefined;
    } catch (error) {
      if (!(error instanceof OperatorDelegationPolicyError)) throw error;
      return { statusCode: 403, body: { error: error.message, code: "operator_delegation_policy_unavailable" } };
    }
    session = patchSessionTransportMeta(session.id, (meta) => {
      const next = { ...meta }; delete next.operatorDelegation;
      if (grant) next.operatorDelegation = grant as never;
      return next;
    }) ?? session;
  }
  const claimedSourceChildId = isNotification && typeof body.sourceChildSessionId === "string" ? body.sourceChildSessionId.trim() : "";
  const sourceChildSession = claimedSourceChildId ? getSession(claimedSourceChildId) : undefined;
  if (claimedSourceChildId && (!sourceChildSession || sourceChildSession.parentSessionId !== session.id
    || sourceChildSession.executionBoundary?.cancelled
    || (typeof sourceChildSession.transportMeta?.latestRunId === "string" && body.sourceRunId !== sourceChildSession.transportMeta.latestRunId)
    || (input.principal?.kind === "session" && input.principal.sessionId !== claimedSourceChildId))) {
    return { statusCode: 403, body: { error: "Callback does not match the current child attempt", code: "stale_callback" } };
  }
  const insertedMessageId = insertMessage(
    session.id,
    messageRole,
    isNotification ? displayMessage : prompt,
    userMedia.length > 0 ? userMedia : undefined,
  );
  if (isNotification) {
    input.context.emit("session:notification", { sessionId: session.id, message: displayMessage });
    const currentSession = getSession(session.id) ?? session;
    const synthesis = claimManagerDelegationSynthesis(
      currentSession.id,
      currentSession.transportMeta,
      listChildSessions(currentSession.id),
      sourceChildSession,
    );
    if (!synthesis.shouldDispatch) {
      return {
        statusCode: 200,
        body: {
          status: "notification_recorded",
          sessionId: session.id,
          ...(synthesis.reason === "waiting_for_children" ? { pendingChildSessionIds: synthesis.pendingChildSessionIds } : {}),
        },
        insertedMessageId,
      };
    }
    if (synthesis.tracked) {
      session = updateSession(currentSession.id, {
        transportMeta: markManagerDelegationSynthesisDispatched(currentSession.transportMeta),
      }) ?? currentSession;
    }
  } else if (acknowledgeLeaderAck(session.id, session, { acknowledgedBy: session.parentSessionId ?? null })) {
    input.context.emit("session:updated", { sessionId: session.id });
  }

  if (!isNotification && session.status === "waiting") {
    const reason = session.lastError?.trim();
    const queuedText = `⏳ ${reason || "This session is paused."} Your message is queued until the session resumes.`;
    insertMessage(session.id, "notification", queuedText);
    input.context.emit("session:notification", { sessionId: session.id, message: queuedText });
  }
  if (session.status === "running") {
    const shouldInterruptRunningTurn = !isNotification
      && (config.sessions?.interruptOnNewMessage ?? true)
      && isInterruptibleEngine(engine)
      && ("isTurnRunning" in engine ? (engine as { isTurnRunning(id: string): boolean }).isTurnRunning(session.id) : engine.isAlive(session.id));
    if (shouldInterruptRunningTurn) {
      logger.info(`Interrupting running session ${session.id} for new message`);
      supersedeRunningTurn(session);
      engine.kill(session.id, "Interrupted: new message received");
      input.context.emit("session:interrupted", { sessionId: session.id, reason: "new message" });
    } else if (!isNotification) {
      input.context.emit("session:queued", { sessionId: session.id, message: prompt });
    }
  }
  if (session.status === "interrupted") {
    logger.info(`Resuming interrupted session ${session.id} (engineSessionId: ${session.engineSessionId})`);
    updateSession(session.id, { status: "running", lastActivity: new Date().toISOString(), lastError: null });
    input.context.emit("session:resumed", { sessionId: session.id });
  }

  input.context.sessionManager.getQueue().clearCancelled(session.sessionKey || session.sourceRef || session.id);
  const sessionKey = session.sessionKey || session.sourceRef || session.id;
  const queue = input.context.sessionManager.getQueue();
  const scheduled = typeof queue.hasScheduled === "function" ? queue.hasScheduled(sessionKey) : queue.isRunning(sessionKey);
  let queueItemId: string | undefined;
  if (!isNotification || session.status === "waiting" || scheduled) {
    queueItemId = enqueueQueueItem(session.id, sessionKey, prompt, queueDispatchAuthority(session, prompt, sourceChildSession));
    input.context.emit("queue:updated", { sessionId: session.id, sessionKey });
  }
  if (attached.blocked) {
    return { statusCode: 200, body: { status: "checkpoint_required", sessionId: session.id }, insertedMessageId };
  }
  // A followup is not an approval: keep it durable until the wait is resolved.
  if (session.status === "waiting") {
    return { statusCode: 200, body: { status: isNotification ? "notification_recorded" : "queued", sessionId: session.id }, insertedMessageId };
  }
  // Keep followers durable until the active turn settles. It may open a
  // checkpoint after this request arrives; the drain then rechecks that wait.
  if (queueItemId && (scheduled || hasPendingQueueItemBefore(sessionKey, queueItemId))) {
    dispatchPendingWebQueueHeadForSessionKey(input.context, sessionKey);
  } else {
    let followUpEmployee;
    if (session.employee && !session.parentSessionId) {
      const { scanOrg } = await import("./org.js");
      followUpEmployee = scanOrg().get(session.employee);
    }
    dispatchEmployeeSessionRun(session, prompt, engine, config, input.context, followUpEmployee, {
      queueItemId,
      attachments: attached.engineAttachments.length > 0 ? attached.engineAttachments : undefined,
      resourceContext: attached.promptBlock,
    });
  }
  return { statusCode: 200, body: { status: "queued", sessionId: session.id }, insertedMessageId };
}
