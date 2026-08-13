import { CUTTLEFISH_HOME, ORG_DIR } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import { forkEngineSession } from "../sessions/fork.js";
import { validateSessionPatch } from "../sessions/session-patch.js";
import {
  cancelAllPendingQueueItems,
  cancelQueueItemForSession,
  deleteSession,
  duplicateSession,
  getQueueItems,
  getSession,
  updateSession,
  type UpdateSessionFields,
} from "../sessions/registry.js";
import { clearTalkAttachments } from "../talk/attachments.js";
import { maybeEmitTalkGraph } from "../talk/graph.js";
import { clearTalkMuted } from "../talk/mute-state.js";
import type { ApiContext } from "./api/context.js";
import {
  killSessionEngines,
  redispatchPendingWebQueueItemsForSessionKey,
} from "./api/session-dispatch.js";
import { serializeSession } from "./api/serialize-session.js";
import { deleteSessionsWithBoardCleanup } from "./lifecycle-delete.js";
import { attachResourcesToSession } from "./session-resources.js";

export interface SessionMutationResult {
  statusCode: number;
  body: Record<string, unknown>;
}

const notFound = (): SessionMutationResult => ({ statusCode: 404, body: { error: "Not found" } });

export function patchSession(
  sessionId: string,
  body: Record<string, unknown>,
  context: ApiContext,
): SessionMutationResult {
  const session = getSession(sessionId);
  if (!session) return notFound();
  const updates: UpdateSessionFields = {};
  if (body.title !== undefined) {
    if (typeof body.title !== "string") {
      return { statusCode: 400, body: { error: "title must be a string" } };
    }
    const trimmed = body.title.trim();
    if (!trimmed) return { statusCode: 400, body: { error: "title must not be empty" } };
    updates.title = trimmed.slice(0, 200);
  }
  if (body.model !== undefined || body.effortLevel !== undefined) {
    const config = context.getConfig();
    const engineConfig = (config.engines as unknown as Record<string, { model?: string } | undefined>)[session.engine] ?? {};
    const patch = validateSessionPatch(config, session.engine, session.model, body, {
      engineSessionId: session.engineSessionId,
      defaultModel: engineConfig.model,
    });
    if (!patch.ok) {
      return { statusCode: 400, body: { error: patch.error || "invalid model/effort" } };
    }
    if (patch.updates?.model !== undefined) updates.model = patch.updates.model;
    if (patch.updates?.effortLevel !== undefined) updates.effortLevel = patch.updates.effortLevel;
  }
  if (Object.keys(updates).length === 0) {
    return { statusCode: 400, body: { error: "no valid fields to update" } };
  }
  const updated = updateSession(sessionId, updates);
  if (!updated) return notFound();
  context.emit("session:updated", { sessionId });
  return { statusCode: 200, body: serializeSession(updated, context) };
}

export async function attachSessionResources(
  sessionId: string,
  body: Record<string, unknown>,
  context: ApiContext,
): Promise<SessionMutationResult> {
  const session = getSession(sessionId);
  if (!session) return notFound();
  try {
    const attached = await attachResourcesToSession(session, body, context);
    context.emit("session:updated", { sessionId });
    return {
      statusCode: 201,
      body: { attachments: serializeSession(attached.session, context).attachments ?? [] },
    };
  } catch (err) {
    return { statusCode: 400, body: { error: err instanceof Error ? err.message : "invalid resources" } };
  }
}

export function deleteSessionAndCleanup(sessionId: string, context: ApiContext): SessionMutationResult {
  const session = getSession(sessionId);
  if (!session) return notFound();

  const deletion = deleteSessionsWithBoardCleanup(ORG_DIR, [sessionId]);
  if (!deletion.ok) {
    logger.error(`Session ${sessionId} was not deleted safely: ${deletion.error}`);
    return { statusCode: 500, body: { error: `Session was not deleted: ${deletion.error}` } };
  }
  logger.info(`Killing engine process for deleted session ${sessionId}`);
  killSessionEngines(context, session, "Interrupted: session deleted");
  context.sessionManager.getQueue().clearQueue(session.sessionKey || session.sourceRef || session.id);
  maybeEmitTalkGraph(sessionId, "removed", { getSession, emit: context.emit, session });
  clearTalkMuted(sessionId);
  clearTalkAttachments(sessionId);
  for (const department of deletion.archived.departments) context.emit("board:updated", { department });
  context.emit("session:deleted", { sessionId });
  logger.info(`Session deleted: ${sessionId}`);
  return { statusCode: 200, body: { status: "deleted" } };
}

export function stopSession(sessionId: string, context: ApiContext): SessionMutationResult {
  const session = getSession(sessionId);
  if (!session) return notFound();

  const wasRunning = session.status === "running";
  const killResult = killSessionEngines(context, session, "Interrupted by user");
  context.sessionManager.getQueue().clearQueue(session.sessionKey || session.sourceRef || session.id);
  const stopped = killResult.interruptible > 0 || session.status !== "running";
  if (stopped) {
    updateSession(sessionId, {
      status: "idle",
      lastActivity: new Date().toISOString(),
      lastError: null,
      ...(wasRunning && session.engine === "grok" ? { engineSessionId: null } : {}),
    });
    context.emit("session:stopped", { sessionId });
  }
  return {
    statusCode: stopped ? 200 : 409,
    body: {
      status: stopped ? "stopped" : "not_stopped",
      stopped,
      wasRunning,
      interruptible: killResult.interruptible > 0,
      sessionId,
    },
  };
}

export function resetSession(sessionId: string, context: ApiContext): SessionMutationResult {
  const session = getSession(sessionId);
  if (!session) return notFound();

  killSessionEngines(context, session, "Interrupted: session reset");
  context.sessionManager.getQueue().clearQueue(session.sessionKey || session.sourceRef || session.id);
  const transportMeta = { ...(session.transportMeta || {}) } as Record<string, unknown>;
  delete transportMeta.engineSessions;
  delete transportMeta.engineOverride;
  updateSession(sessionId, {
    status: "idle",
    engineSessionId: null,
    lastActivity: new Date().toISOString(),
    lastError: null,
    transportMeta: transportMeta as never,
  });
  logger.info(`Session ${sessionId} reset via API (cleared engineSessions, engineOverride, engineSessionId, lastError)`);
  context.emit("session:updated", { sessionId });
  return { statusCode: 200, body: { status: "reset", sessionId } };
}

export async function duplicateEngineSession(sessionId: string, context: ApiContext): Promise<SessionMutationResult> {
  const source = getSession(sessionId);
  if (!source) return notFound();
  if (!source.engineSessionId) {
    return { statusCode: 400, body: { error: "Session has no engine session ID — cannot duplicate" } };
  }

  let newSessionId: string | null = null;
  try {
    const { session: newSession, messageCount } = duplicateSession(sessionId);
    newSessionId = newSession.id;
    const interactive = source.engine === "claude" && context.interactiveClaudeEngine
      ? {
          sourceCuttlefishSessionId: sessionId,
          engine: context.interactiveClaudeEngine,
          bin: context.getConfig().engines.claude.bin,
        }
      : undefined;
    const forkResult = await forkEngineSession(source.engine, source.engineSessionId, CUTTLEFISH_HOME, interactive);
    updateSession(newSession.id, { engineSessionId: forkResult.engineSessionId });

    const result = getSession(newSession.id)!;
    logger.info(`Session duplicated: ${sessionId} → ${newSession.id} (engine: ${forkResult.engineSessionId}, ${messageCount} messages)`);
    context.emit("session:created", { sessionId: newSession.id });
    return { statusCode: 200, body: serializeSession(result, context) };
  } catch (err) {
    if (newSessionId) {
      try { deleteSession(newSessionId); } catch { /* retain the original fork error */ }
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to duplicate session ${sessionId}: ${message}`);
    return { statusCode: 500, body: { error: `Duplicate failed: ${message}` } };
  }
}

export function cancelSessionQueueItem(
  sessionId: string,
  itemId: string,
  context: ApiContext,
): SessionMutationResult {
  const session = getSession(sessionId);
  if (!session) return notFound();
  const sessionKey = session.sessionKey || session.sourceRef || session.id;
  const cancelled = cancelQueueItemForSession(itemId, session.id, sessionKey);
  if (!cancelled) {
    return { statusCode: 409, body: { error: "Item not found or already running" } };
  }
  context.emit("queue:updated", { sessionId, sessionKey: session.sessionKey });
  return { statusCode: 200, body: { status: "cancelled", itemId } };
}

export function clearSessionQueue(sessionId: string, context: ApiContext): SessionMutationResult {
  const session = getSession(sessionId);
  if (!session) return notFound();
  const sessionKey = session.sessionKey || session.sourceRef || session.id;
  const pendingBefore = getQueueItems(sessionKey).filter((item) => item.status === "pending").length;
  context.sessionManager.getQueue().clearQueue(sessionKey);
  const cancelled = cancelAllPendingQueueItems(sessionKey);
  context.emit("queue:updated", { sessionId, sessionKey, depth: 0 });
  const status = pendingBefore === 0 ? "empty" : cancelled < pendingBefore ? "partial" : "cleared";
  return { statusCode: 200, body: { status, cancelled, requested: pendingBefore } };
}

export function pauseSessionQueue(sessionId: string, context: ApiContext): SessionMutationResult {
  const session = getSession(sessionId);
  if (!session) return notFound();
  const sessionKey = session.sessionKey || session.sourceRef || session.id;
  context.sessionManager.getQueue().pauseQueue(sessionKey);
  context.emit("queue:updated", { sessionId, sessionKey, paused: true });
  return { statusCode: 200, body: { status: "paused", sessionId } };
}

export async function resumeSessionQueue(sessionId: string, context: ApiContext): Promise<SessionMutationResult> {
  const session = getSession(sessionId);
  if (!session) return notFound();
  const sessionKey = session.sessionKey || session.sourceRef || session.id;
  context.sessionManager.getQueue().resumeQueue(sessionKey);
  const redispatched = await redispatchPendingWebQueueItemsForSessionKey(context, sessionKey);
  context.emit("queue:updated", { sessionId, sessionKey, paused: false });
  return { statusCode: 200, body: { status: "resumed", sessionId, redispatched } };
}

export function bulkDeleteSessions(rawIds: unknown, context: ApiContext): SessionMutationResult {
  const ids = Array.isArray(rawIds) ? [...new Set(rawIds)] : rawIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== "string")) {
    return { statusCode: 400, body: { error: "ids array is required" } };
  }

  const sessionsToDelete = ids
    .map((id) => getSession(id))
    .filter((session): session is NonNullable<ReturnType<typeof getSession>> => Boolean(session));
  const existingIds = sessionsToDelete.map((session) => session.id);
  const missingIds = ids.filter((id) => !existingIds.includes(id));
  const deletion = deleteSessionsWithBoardCleanup(ORG_DIR, existingIds);
  if (!deletion.ok) {
    logger.error(`Bulk session deletion aborted safely: ${deletion.error}`);
    return { statusCode: 500, body: { error: `Sessions were not deleted: ${deletion.error}` } };
  }
  for (const session of sessionsToDelete) {
    killSessionEngines(context, session, "Interrupted: session deleted");
    context.sessionManager.getQueue().clearQueue(session.sessionKey || session.sourceRef || session.id);
  }
  const deletedIds = existingIds.filter((id) => !getSession(id));
  for (const department of deletion.archived.departments) context.emit("board:updated", { department });
  for (const session of sessionsToDelete.filter((item) => deletedIds.includes(item.id))) {
    maybeEmitTalkGraph(session.id, "removed", { getSession, emit: context.emit, session });
    clearTalkMuted(session.id);
    clearTalkAttachments(session.id);
    context.emit("session:deleted", { sessionId: session.id });
  }
  const failedIds = ids.filter((id) => !deletedIds.includes(id));
  if (failedIds.length > 0 || deletion.count !== existingIds.length) {
    logger.warn(`Bulk delete partial: deleted ${deletedIds.length}/${ids.length} sessions`);
    return {
      statusCode: 409,
      body: {
        status: "partial",
        count: deletedIds.length,
        requested: ids.length,
        deletedIds,
        failedIds,
        missingIds,
        error: `Deleted ${deletedIds.length} of ${ids.length} selected sessions`,
      },
    };
  }
  logger.info(`Bulk deleted ${deletion.count} sessions`);
  return {
    statusCode: 200,
    body: { status: "deleted", count: deletion.count, requested: ids.length, deletedIds },
  };
}
