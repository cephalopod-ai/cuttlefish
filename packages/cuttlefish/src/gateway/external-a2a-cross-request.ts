import { createHash, randomUUID } from "node:crypto";
import { TaskState, type Artifact, type Message, type Part, type Task } from "@a2a-js/sdk";
import type { Employee, Session } from "../shared/types.js";
import {
  createSession,
  beginSessionRun,
  getFile,
  getSession,
  insertFile,
  insertMessage,
  insertMessageOnce,
  listSessions,
  patchSessionTransportMeta,
  updateSession,
} from "../sessions/registry.js";
import {
  destinationForExternalService,
  externalA2AResultText,
  externalA2ATaskIsTerminal,
  isA2ATask,
  type ConfiguredExternalA2AService,
} from "../a2a/external-services.js";
import { buildCrossRequestBrief } from "./org-services.js";
import type { ApiContext } from "./api/context.js";
import { saveFile } from "./files/uploads.js";

interface ExternalCrossRequestInput {
  requester: Employee;
  service: ConfiguredExternalA2AService;
  prompt: string;
  parentSessionId?: string;
  context: ApiContext;
}

function remoteState(result: Message | Task): string {
  return isA2ATask(result) ? TaskState[result.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED] : "MESSAGE";
}

interface ActiveExternalRequest {
  controller: AbortController;
  destinationId: string;
  taskId?: string;
  cancelRequested: boolean;
  finalized: boolean;
  seenMessageIds: Set<string>;
  wakeRetry?: () => void;
}

interface RecoverableExternalRequestMeta {
  destinationId: string;
  taskId?: string;
  skillId?: string;
  requestMessageId?: string;
  requestMessage?: string;
  destinationAgentCardUrl?: string;
  lastProgressMessageId?: string;
  cancellationRequested: boolean;
  reconciliationPending: boolean;
  reconciliationAttempts: number;
  reconciliationError?: string;
  messageIdDeduplicationGuaranteed: boolean;
}

const activeExternalRequests = new Map<string, ActiveExternalRequest>();
const EXTERNAL_REQUEST_HEARTBEAT_MS = 10_000;
const EXTERNAL_REQUEST_RETRY_BASE_MS = 1_000;
const EXTERNAL_REQUEST_RETRY_MAX_MS = 30_000;
const EXTERNAL_REQUEST_MAX_RECONCILIATION_ATTEMPTS = 3;

function recoverableExternalRequestMeta(
  session: Pick<Session, "engine" | "status" | "transportMeta">,
): RecoverableExternalRequestMeta | undefined {
  if (session.engine !== "a2a") return undefined;
  const rawMeta = session.transportMeta?.a2aOutbound;
  const meta = rawMeta && typeof rawMeta === "object" && !Array.isArray(rawMeta)
    ? rawMeta as Record<string, unknown>
    : {};
  const destinationId = typeof meta.destinationId === "string" ? meta.destinationId : undefined;
  const taskId = typeof meta.taskId === "string" ? meta.taskId : undefined;
  const skillId = typeof meta.skillId === "string" ? meta.skillId : undefined;
  const requestMessageId = typeof meta.requestMessageId === "string" ? meta.requestMessageId : undefined;
  const requestMessage = typeof meta.requestMessage === "string" ? meta.requestMessage : undefined;
  const destinationAgentCardUrl = typeof meta.destinationAgentCardUrl === "string"
    ? meta.destinationAgentCardUrl
    : undefined;
  const cancellationRequested = typeof meta.cancellationRequestedAt === "string";
  const reconciliationPending = typeof meta.reconciliationPendingAt === "string";
  const reconciliationAttempts = typeof meta.reconciliationAttempts === "number"
    && Number.isSafeInteger(meta.reconciliationAttempts)
    && meta.reconciliationAttempts >= 0
    ? meta.reconciliationAttempts
    : 0;
  const messageIdDeduplicationGuaranteed = meta.messageIdDeduplication === "guaranteed";
  const exhaustedWhileWaiting = session.status === "waiting"
    && reconciliationAttempts >= EXTERNAL_REQUEST_MAX_RECONCILIATION_ATTEMPTS;
  const statusIsRecoverable = session.status === "running"
    || (session.status === "waiting" && (
      cancellationRequested
      || reconciliationPending
      || exhaustedWhileWaiting
    ));
  if (!statusIsRecoverable || !destinationId) return undefined;
  if (!taskId && (
    !messageIdDeduplicationGuaranteed
    || !skillId
    || !requestMessageId
    || !requestMessage
    || !destinationAgentCardUrl
  )) return undefined;
  return {
    destinationId,
    ...(taskId ? { taskId } : {}),
    ...(skillId ? { skillId } : {}),
    ...(requestMessageId ? { requestMessageId } : {}),
    ...(requestMessage ? { requestMessage } : {}),
    ...(destinationAgentCardUrl ? { destinationAgentCardUrl } : {}),
    ...(typeof meta.lastProgressMessageId === "string"
      ? { lastProgressMessageId: meta.lastProgressMessageId }
      : {}),
    cancellationRequested,
    reconciliationPending,
    reconciliationAttempts,
    ...(typeof meta.reconciliationError === "string"
      ? { reconciliationError: meta.reconciliationError }
      : {}),
    messageIdDeduplicationGuaranteed,
  };
}

function canonicalAgentCardUrl(value: string): string | undefined {
  try {
    return new URL(value).href;
  } catch {
    return undefined;
  }
}

function tasklessReplayConfigurationError(
  checkpoint: RecoverableExternalRequestMeta,
  context: ApiContext,
): string | undefined {
  if (!checkpoint.messageIdDeduplicationGuaranteed) {
    return "the checkpoint does not record a message-ID deduplication guarantee";
  }
  const destination = context.getConfig().a2a?.destinations?.find(
    (candidate) => candidate.id === checkpoint.destinationId,
  );
  if (!destination) return `destination ${checkpoint.destinationId} is no longer configured`;
  if (destination.messageIdDeduplication !== "guaranteed") {
    return `destination ${checkpoint.destinationId} no longer guarantees message-ID deduplication`;
  }
  const currentAgentCardUrl = canonicalAgentCardUrl(destination.agentCardUrl);
  if (!checkpoint.destinationAgentCardUrl || currentAgentCardUrl !== checkpoint.destinationAgentCardUrl) {
    return `destination ${checkpoint.destinationId} no longer matches the checkpointed peer identity`;
  }
  return undefined;
}

function refuseTasklessReplay(
  sessionId: string,
  context: ApiContext,
  checkpoint: RecoverableExternalRequestMeta,
  reason: string,
): void {
  const session = getSession(sessionId);
  const current = session?.transportMeta ?? {};
  const prior = current.a2aOutbound;
  const existing = prior && typeof prior === "object" && !Array.isArray(prior)
    ? prior as Record<string, unknown>
    : {};
  const lastActivity = new Date().toISOString();
  updateSession(sessionId, {
    status: "error",
    lastActivity,
    lastError: `Outbound A2A send replay refused: ${reason}`,
    transportMeta: {
      ...current,
      a2aOutbound: {
        ...existing,
        dispatchOutcome: "replay-refused-config-drift",
        reconciliationPendingAt: null,
        reconciliationError: reason,
        reconciliationAttempts: checkpoint.reconciliationAttempts,
      },
    } as never,
  });
  context.emit("session:updated", { sessionId });
}

/** Identify sessions the generic boot sweeps must preserve for A2A recovery. */
export function recoverableExternalA2ACrossRequestSessionIds(): ReadonlySet<string> {
  return new Set(
    listSessions({ engine: "a2a" })
      .filter((session) => recoverableExternalRequestMeta(session) !== undefined)
      .map((session) => session.id),
  );
}

function startExternalRequestHeartbeat(sessionId: string): () => void {
  const timer = setInterval(() => {
    updateSession(sessionId, { lastActivity: new Date().toISOString() });
  }, EXTERNAL_REQUEST_HEARTBEAT_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

function waitForExternalRequestRetry(execution: ActiveExternalRequest, attempt: number): Promise<void> {
  const delay = Math.min(
    EXTERNAL_REQUEST_RETRY_MAX_MS,
    EXTERNAL_REQUEST_RETRY_BASE_MS * (2 ** Math.min(attempt, 5)),
  );
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (execution.wakeRetry === finish) delete execution.wakeRetry;
      resolve();
    };
    const timer = setTimeout(finish, delay);
    timer.unref?.();
    execution.wakeRetry = finish;
  });
}

function patchOutboundMeta(sessionId: string, patch: Record<string, unknown>): void {
  patchSessionTransportMeta(sessionId, (current) => {
    const prior = current.a2aOutbound;
    const existing = prior && typeof prior === "object" && !Array.isArray(prior)
      ? prior as Record<string, unknown>
      : {};
    return { ...current, a2aOutbound: { ...existing, ...patch } } as never;
  });
}

function failExternalRequestReconciliation(
  sessionId: string,
  context: ApiContext,
  input: { attempts: number; message: string; cancellationRequested: boolean },
): void {
  const session = getSession(sessionId);
  const current = session?.transportMeta ?? {};
  const prior = current.a2aOutbound;
  const existing = prior && typeof prior === "object" && !Array.isArray(prior)
    ? prior as Record<string, unknown>
    : {};
  const lastActivity = new Date().toISOString();
  updateSession(sessionId, {
    status: "error",
    lastActivity,
    lastError: input.cancellationRequested
      ? `Outbound A2A cancellation reconciliation failed after ${input.attempts} attempts: ${input.message}`
      : `Outbound A2A reconciliation failed after ${input.attempts} attempts: ${input.message}`,
    transportMeta: {
      ...current,
      a2aOutbound: {
        ...existing,
        reconciliationPendingAt: null,
        reconciliationError: input.message,
        reconciliationAttempts: input.attempts,
      },
    } as never,
  });
  context.emit("session:updated", { sessionId });
}

function remoteMessageRowId(
  sessionId: string,
  destinationId: string,
  remoteId: string,
  kind: "progress" | "result",
  messageId: string,
): string {
  const digest = createHash("sha256")
    .update(`${sessionId}\0${destinationId}\0${remoteId}\0${kind}\0${messageId}`)
    .digest("hex")
    .slice(0, 32);
  return `a2a-${kind}-${digest}`;
}

function safeArtifactFilename(artifact: Artifact, part: Part, index: number): string {
  const candidate = part.filename || artifact.name || `remote-artifact-${artifact.artifactId}-${index + 1}`;
  return candidate.replace(/[\\/\0]/g, "-").replace(/^\.+/, "").slice(0, 180) || `remote-artifact-${index + 1}`;
}

function partBytes(part: Part): Buffer {
  if (part.content?.$case === "raw") return Buffer.from(part.content.value);
  if (part.content?.$case === "text" || part.content?.$case === "url") return Buffer.from(part.content.value, "utf8");
  if (part.content?.$case === "data") return Buffer.from(JSON.stringify(part.content.value), "utf8");
  return Buffer.alloc(0);
}

function partMediaType(part: Part): string {
  if (part.mediaType) return part.mediaType;
  if (part.content?.$case === "data") return "application/json";
  if (part.content?.$case === "text" || part.content?.$case === "url") return "text/plain";
  return "application/octet-stream";
}

async function registerRemoteArtifacts(
  sessionId: string,
  destinationId: string,
  task: Task,
  context: ApiContext,
): Promise<string[]> {
  const registered: string[] = [];
  const currentSession = getSession(sessionId);
  const activeRunId = typeof currentSession?.transportMeta?.activeRunId === "string"
    ? currentSession.transportMeta.activeRunId
    : sessionId;
  for (const artifact of task.artifacts) {
    for (const [index, part] of artifact.parts.entries()) {
      const bytes = partBytes(part);
      const digest = createHash("sha256").update(bytes).digest("hex");
      const idDigest = createHash("sha256")
        .update(`${destinationId}\0${task.id}\0${artifact.artifactId}\0${index}\0${digest}`)
        .digest("hex")
        .slice(0, 32);
      const id = `a2a-${idDigest}`;
      if (!getFile(id)) {
        const filename = safeArtifactFilename(artifact, part, index);
        if (part.content?.$case === "raw") {
          const meta = await saveFile({
            id,
            filename,
            buffer: bytes,
            mimetype: partMediaType(part),
            customPath: null,
            open: false,
            sessionId,
            artifactKind: "generated",
            producingRunId: activeRunId,
            tags: ["a2a-output", `a2a-destination:${destinationId}`],
            notes: `Remote A2A artifact ${artifact.artifactId} from task ${task.id}`,
          }, context);
          context.emit("artifact:registered", { id: meta.id, path: meta.path, producingRunId: meta.producingRunId });
        } else {
          const meta = insertFile({
            id,
            filename,
            size: bytes.length,
            mimetype: partMediaType(part),
            path: null,
            sha256: digest,
            artifactKind: "generated",
            producingRunId: activeRunId,
            sourceUrl: part.content?.$case === "url" ? part.content.value : null,
            tags: ["a2a-output", "metadata-only", `a2a-destination:${destinationId}`],
            notes: `Metadata-only remote A2A artifact ${artifact.artifactId} from task ${task.id}`,
          });
          context.emit("artifact:registered", { id: meta.id, path: meta.path, producingRunId: meta.producingRunId });
        }
      }
      registered.push(id);
    }
  }
  return registered;
}

async function recordRemoteProgress(
  sessionId: string,
  destinationId: string,
  task: Task,
  context: ApiContext,
  execution: ActiveExternalRequest,
): Promise<string | undefined> {
  execution.taskId = task.id;
  // Persist the minimum remote identity before artifact/message processing so
  // any later local failure can resume by task ID instead of replaying send.
  patchOutboundMeta(sessionId, {
    destinationId,
    taskId: task.id,
    contextId: task.contextId,
    state: remoteState(task),
    statusTimestamp: task.status?.timestamp,
  });
  const artifactIds = await registerRemoteArtifacts(sessionId, destinationId, task, context);
  const progressMessage = task.status?.message;
  const progressText = progressMessage ? externalA2AResultText(progressMessage) : "";
  if (progressMessage?.messageId && !execution.seenMessageIds.has(progressMessage.messageId)) {
    if (progressText) {
      insertMessageOnce(
        sessionId,
        remoteMessageRowId(sessionId, destinationId, task.id, "progress", progressMessage.messageId),
        "assistant",
        progressText,
      );
    }
    execution.seenMessageIds.add(progressMessage.messageId);
  }
  patchOutboundMeta(sessionId, {
    destinationId,
    taskId: task.id,
    contextId: task.contextId,
    state: remoteState(task),
    artifactCount: task.artifacts.length,
    artifactIds,
    statusTimestamp: task.status?.timestamp,
    ...(progressMessage?.messageId ? { lastProgressMessageId: progressMessage.messageId } : {}),
  });
  const state = task.status?.state;
  const lastActivity = new Date().toISOString();
  if (state === TaskState.TASK_STATE_INPUT_REQUIRED || state === TaskState.TASK_STATE_AUTH_REQUIRED) {
    updateSession(sessionId, { status: "waiting", lastActivity, lastError: null });
  } else if (!externalA2ATaskIsTerminal(task)) {
    updateSession(sessionId, { status: "running", lastActivity, lastError: null });
  }
  context.emit("session:updated", { sessionId });
  return progressText || undefined;
}

async function finalizeRemoteResult(
  sessionId: string,
  destinationId: string,
  result: Message | Task,
  context: ApiContext,
  execution: ActiveExternalRequest,
): Promise<void> {
  if (execution.finalized) return;
  const progressText = isA2ATask(result)
    ? await recordRemoteProgress(sessionId, destinationId, result, context, execution)
    : undefined;
  const state = isA2ATask(result) ? result.status?.state : TaskState.TASK_STATE_COMPLETED;
  const text = externalA2AResultText(result) || `External A2A request ended in ${remoteState(result)}.`;
  if (text !== progressText) {
    if (isA2ATask(result)) {
      insertMessageOnce(
        sessionId,
        remoteMessageRowId(sessionId, destinationId, result.id, "result", String(state)),
        "assistant",
        text,
      );
    } else if (result.messageId) {
      insertMessageOnce(
        sessionId,
        remoteMessageRowId(
          sessionId,
          destinationId,
          result.taskId || result.contextId || "message",
          "result",
          result.messageId,
        ),
        "assistant",
        text,
      );
    } else {
      insertMessage(sessionId, "assistant", text);
    }
  }
  const lastActivity = new Date().toISOString();
  if (state === TaskState.TASK_STATE_INPUT_REQUIRED || state === TaskState.TASK_STATE_AUTH_REQUIRED) {
    updateSession(sessionId, { status: "waiting", lastActivity, lastError: null });
  } else if (state === TaskState.TASK_STATE_COMPLETED) {
    updateSession(sessionId, { status: "idle", lastActivity, lastError: null });
  } else if (state === TaskState.TASK_STATE_CANCELED) {
    updateSession(sessionId, { status: "interrupted", lastActivity, lastError: "Remote A2A task was canceled" });
  } else {
    updateSession(sessionId, { status: "error", lastActivity, lastError: `Remote A2A task ended in ${remoteState(result)}` });
  }
  execution.finalized = true;
  context.emit("session:updated", { sessionId });
}

/** Persist stop intent and propagate it once the remote task identity is known. */
export function requestExternalA2ACrossRequestStop(sessionId: string, context: ApiContext): boolean {
  const execution = activeExternalRequests.get(sessionId);
  const session = getSession(sessionId);
  const rawMeta = session?.transportMeta?.a2aOutbound;
  const meta = rawMeta && typeof rawMeta === "object" && !Array.isArray(rawMeta)
    ? rawMeta as Record<string, unknown>
    : {};
  const destinationId = execution?.destinationId
    ?? (typeof meta.destinationId === "string" ? meta.destinationId : undefined);
  const taskId = execution?.taskId ?? (typeof meta.taskId === "string" ? meta.taskId : undefined);
  if (execution) {
    execution.cancelRequested = true;
    execution.wakeRetry?.();
    // Before a remote task ID exists, allow the keyed send to finish so its
    // result can be canceled. Aborting would discard the only task identity.
    if (taskId) execution.controller.abort(new Error("External A2A cross-request stopped"));
  }
  patchOutboundMeta(sessionId, { cancellationRequestedAt: new Date().toISOString() });
  if (execution) return true;
  if (!destinationId || !context.a2aOutbound) return false;
  // A waiting/checkpointed session has no live controller. Start the same
  // recovery path immediately; it will poll/reconcile, then cancel.
  recoverExternalA2ACrossRequests(context);
  return activeExternalRequests.has(sessionId);
}

async function resumeExternalRequest(
  sessionId: string,
  checkpoint: RecoverableExternalRequestMeta,
  context: ApiContext,
  execution: ActiveExternalRequest,
): Promise<void> {
  const stopHeartbeat = startExternalRequestHeartbeat(sessionId);
  try {
    const outbound = context.a2aOutbound;
    if (!outbound) {
      updateSession(sessionId, {
        status: "error",
        lastActivity: new Date().toISOString(),
        lastError: "Outbound A2A service is unavailable",
      });
      context.emit("session:updated", { sessionId });
      return;
    }
    let attempt = checkpoint.reconciliationAttempts;
    while (!execution.finalized) {
      try {
        if (execution.controller.signal.aborted) execution.controller = new AbortController();
        const taskId = execution.taskId ?? checkpoint.taskId;
        updateSession(sessionId, {
          status: execution.cancelRequested ? "waiting" : "running",
          lastActivity: new Date().toISOString(),
          ...(attempt === 0 ? { lastError: null } : {}),
        });
        context.emit("session:updated", { sessionId });
        let result: Message | Task;
        if (taskId) {
          result = execution.cancelRequested
            ? await outbound.cancelTask(checkpoint.destinationId, taskId)
            : await outbound.waitForTask(checkpoint.destinationId, taskId, {
                signal: execution.controller.signal,
                onUpdate: async (task) => {
                  await recordRemoteProgress(sessionId, checkpoint.destinationId, task, context, execution);
                },
              });
        } else {
          const replayConfigurationError = tasklessReplayConfigurationError(checkpoint, context);
          if (replayConfigurationError) {
            refuseTasklessReplay(sessionId, context, checkpoint, replayConfigurationError);
            return;
          }
          result = await outbound.send({
            destinationId: checkpoint.destinationId,
            skillId: checkpoint.skillId!,
            message: checkpoint.requestMessage!,
            messageId: checkpoint.requestMessageId!,
            returnImmediately: true,
            signal: execution.controller.signal,
          });
          if (isA2ATask(result)) {
            await recordRemoteProgress(sessionId, checkpoint.destinationId, result, context, execution);
            if (execution.cancelRequested && !externalA2ATaskIsTerminal(result)) {
              result = await outbound.cancelTask(checkpoint.destinationId, result.id);
            } else if (!externalA2ATaskIsTerminal(result)) {
              result = await outbound.waitForTask(checkpoint.destinationId, result.id, {
                signal: execution.controller.signal,
                onUpdate: async (task) => {
                  await recordRemoteProgress(sessionId, checkpoint.destinationId, task, context, execution);
                },
              });
            }
          }
        }
        patchOutboundMeta(sessionId, {
          reconciliationPendingAt: null,
          reconciliationError: null,
          reconciliationAttempts: 0,
        });
        await finalizeRemoteResult(sessionId, checkpoint.destinationId, result, context, execution);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        attempt += 1;
        const failedAt = new Date().toISOString();
        if (attempt >= EXTERNAL_REQUEST_MAX_RECONCILIATION_ATTEMPTS) {
          failExternalRequestReconciliation(sessionId, context, {
            attempts: attempt,
            message,
            cancellationRequested: execution.cancelRequested,
          });
          return;
        }
        patchOutboundMeta(sessionId, {
          reconciliationPendingAt: failedAt,
          reconciliationError: message,
          reconciliationAttempts: attempt,
        });
        updateSession(sessionId, {
          status: "waiting",
          lastActivity: failedAt,
          lastError: execution.cancelRequested
            ? `Outbound A2A cancellation reconciliation pending: ${message}`
            : `Outbound A2A reconciliation pending: ${message}`,
        });
        context.emit("session:updated", { sessionId });
        await waitForExternalRequestRetry(execution, attempt - 1);
      }
    }
  } finally {
    stopHeartbeat();
    if (activeExternalRequests.get(sessionId) === execution) activeExternalRequests.delete(sessionId);
  }
}

/** Reconcile durable outbound checkpoints by polling a task or replaying its logical message ID. */
export function recoverExternalA2ACrossRequests(context: ApiContext): number {
  let recovered = 0;
  for (const session of listSessions({ engine: "a2a" })) {
    if (activeExternalRequests.has(session.id)) continue;
    const meta = recoverableExternalRequestMeta(session);
    if (!meta) continue;
    if (meta.reconciliationAttempts >= EXTERNAL_REQUEST_MAX_RECONCILIATION_ATTEMPTS) {
      failExternalRequestReconciliation(session.id, context, {
        attempts: meta.reconciliationAttempts,
        message: meta.reconciliationError ?? "reconciliation attempt ceiling reached",
        cancellationRequested: meta.cancellationRequested,
      });
      continue;
    }
    const { destinationId, taskId } = meta;
    const execution: ActiveExternalRequest = {
      controller: new AbortController(),
      destinationId,
      taskId,
      cancelRequested: meta.cancellationRequested,
      finalized: false,
      seenMessageIds: new Set(
        meta.lastProgressMessageId ? [meta.lastProgressMessageId] : [],
      ),
    };
    activeExternalRequests.set(session.id, execution);
    patchOutboundMeta(session.id, { recoveryStartedAt: new Date().toISOString() });
    void resumeExternalRequest(session.id, meta, context, execution);
    recovered += 1;
  }
  return recovered;
}

async function runExternalRequest(
  sessionId: string,
  service: ConfiguredExternalA2AService,
  brief: string,
  requestMessageId: string,
  messageIdDeduplicationGuaranteed: boolean,
  destinationAgentCardUrl: string | undefined,
  context: ApiContext,
): Promise<void> {
  const outbound = context.a2aOutbound;
  if (!outbound) {
    updateSession(sessionId, {
      status: "error",
      lastActivity: new Date().toISOString(),
      lastError: "Outbound A2A service is unavailable",
    });
    context.emit("session:updated", { sessionId });
    return;
  }
  updateSession(sessionId, { status: "running", lastActivity: new Date().toISOString(), lastError: null });
  context.emit("session:updated", { sessionId });
  const execution: ActiveExternalRequest = {
    controller: new AbortController(),
    destinationId: service.destinationId,
    cancelRequested: false,
    finalized: false,
    seenMessageIds: new Set(),
  };
  activeExternalRequests.set(sessionId, execution);
  const stopHeartbeat = startExternalRequestHeartbeat(sessionId);
  try {
    let result = await outbound.send({
      destinationId: service.destinationId,
      skillId: service.skillId,
      message: brief,
      messageId: requestMessageId,
      returnImmediately: true,
      signal: execution.controller.signal,
    });
    if (isA2ATask(result)) {
      await recordRemoteProgress(sessionId, service.destinationId, result, context, execution);
      if (execution.cancelRequested && !externalA2ATaskIsTerminal(result)) {
        result = await outbound.cancelTask(service.destinationId, result.id);
        await finalizeRemoteResult(sessionId, service.destinationId, result, context, execution);
        return;
      }
      if (!externalA2ATaskIsTerminal(result)) {
        result = await outbound.waitForTask(service.destinationId, result.id, {
          signal: execution.controller.signal,
          onUpdate: async (task) => { await recordRemoteProgress(sessionId, service.destinationId, task, context, execution); },
        });
      }
    }
    await finalizeRemoteResult(sessionId, service.destinationId, result, context, execution);
  } catch (error) {
    if (execution.finalized) return;
    if (!execution.taskId && !messageIdDeduplicationGuaranteed) {
      const message = error instanceof Error ? error.message : String(error);
      const failedAt = new Date().toISOString();
      patchOutboundMeta(sessionId, {
        dispatchOutcome: "unknown-not-replayed",
        dispatchError: message,
      });
      updateSession(sessionId, {
        status: "error",
        lastActivity: failedAt,
        lastError: execution.cancelRequested
          ? `Outbound A2A request stopped before task identity; send outcome is unknown and was not replayed: ${message}`
          : `Outbound A2A send outcome is unknown and was not replayed: ${message}`,
      });
      context.emit("session:updated", { sessionId });
      return;
    }
    // Any error after the durable request checkpoint enters the same retrying
    // reconciliation path. Known tasks are polled/canceled by ID; an unknown
    // send outcome is replayed only under an operator-asserted peer guarantee.
    execution.controller = new AbortController();
    stopHeartbeat();
    await resumeExternalRequest(sessionId, {
      destinationId: service.destinationId,
      ...(execution.taskId ? { taskId: execution.taskId } : {}),
      skillId: service.skillId,
      requestMessageId,
      requestMessage: brief,
      ...(destinationAgentCardUrl ? { destinationAgentCardUrl } : {}),
      cancellationRequested: execution.cancelRequested,
      reconciliationPending: true,
      reconciliationAttempts: 0,
      messageIdDeduplicationGuaranteed,
    }, context, execution);
  } finally {
    stopHeartbeat();
    if (activeExternalRequests.get(sessionId) === execution) activeExternalRequests.delete(sessionId);
  }
}

export function createExternalA2ACrossRequest(input: ExternalCrossRequestInput) {
  const config = input.context.getConfig();
  const brief = buildCrossRequestBrief({ requester: input.requester, service: input.service, prompt: input.prompt });
  const requestMessageId = randomUUID();
  const destination = destinationForExternalService(config, input.service);
  const destinationAgentCardUrl = destination
    ? canonicalAgentCardUrl(destination.agentCardUrl)
    : undefined;
  const messageIdDeduplicationGuaranteed = destination?.messageIdDeduplication === "guaranteed"
    && destinationAgentCardUrl !== undefined;
  const now = Date.now();
  const session = createSession({
    engine: "a2a",
    source: "web",
    sourceRef: `cross-request:${now}:${input.service.providerId}`,
    connector: "web",
    sessionKey: `cross-request:${now}:${input.service.providerId}`,
    replyContext: { source: "web" },
    parentSessionId: input.parentSessionId,
    title: `Cross request: ${input.service.name}`,
    prompt: brief,
    promptExcerpt: input.prompt,
    portalName: config.portal?.portalName,
    transportMeta: {
      crossRequest: {
        fromEmployee: input.requester.name,
        service: input.service.name,
        provider: input.service.providerId,
        route: [input.requester.name, input.service.providerId],
        managers: [],
        ...(input.parentSessionId ? { requesterSessionId: input.parentSessionId } : {}),
      },
      a2aOutbound: {
        destinationId: input.service.destinationId,
        skillId: input.service.skillId,
        requestMessageId,
        requestMessage: brief,
        ...(messageIdDeduplicationGuaranteed
          ? { messageIdDeduplication: "guaranteed", destinationAgentCardUrl }
          : {}),
        state: "SUBMITTED",
      },
    },
  });
  const runSession = beginSessionRun({ sessionId: session.id, prompt: brief, transportMeta: session.transportMeta });
  if (!runSession) throw new Error(`Failed to create run ledger entry for external A2A session ${session.id}`);
  insertMessage(session.id, "user", brief);
  void runExternalRequest(
    session.id,
    input.service,
    brief,
    requestMessageId,
    messageIdDeduplicationGuaranteed,
    destinationAgentCardUrl,
    input.context,
  );
  input.context.emit("session:created", { sessionId: session.id, externalProvider: input.service.providerId });
  return {
    statusCode: 201,
    body: {
      sessionId: session.id,
      provider: {
        name: input.service.providerId,
        displayName: `External A2A peer (${input.service.destinationId})`,
        department: "external",
      },
      route: [input.requester.name, input.service.providerId],
      managers: [],
      service: input.service.name,
    },
  };
}
