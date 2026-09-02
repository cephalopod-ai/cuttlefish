import { createHash } from "node:crypto";
import { TaskState, type Artifact, type Message, type Part, type Task } from "@a2a-js/sdk";
import type { Employee } from "../shared/types.js";
import {
  createSession,
  beginSessionRun,
  getFile,
  getSession,
  insertFile,
  insertMessage,
  patchSessionTransportMeta,
  updateSession,
} from "../sessions/registry.js";
import {
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
}

const activeExternalRequests = new Map<string, ActiveExternalRequest>();

function patchOutboundMeta(sessionId: string, patch: Record<string, unknown>): void {
  patchSessionTransportMeta(sessionId, (current) => {
    const prior = current.a2aOutbound;
    const existing = prior && typeof prior === "object" && !Array.isArray(prior)
      ? prior as Record<string, unknown>
      : {};
    return { ...current, a2aOutbound: { ...existing, ...patch } } as never;
  });
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
): Promise<void> {
  execution.taskId = task.id;
  const artifactIds = await registerRemoteArtifacts(sessionId, destinationId, task, context);
  const progressMessage = task.status?.message;
  if (progressMessage?.messageId && !execution.seenMessageIds.has(progressMessage.messageId)) {
    const text = externalA2AResultText(progressMessage);
    if (text) insertMessage(sessionId, "assistant", text);
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
  });
  const state = task.status?.state;
  if (state === TaskState.TASK_STATE_INPUT_REQUIRED || state === TaskState.TASK_STATE_AUTH_REQUIRED) {
    updateSession(sessionId, { status: "waiting", lastError: null });
  } else if (!externalA2ATaskIsTerminal(task)) {
    updateSession(sessionId, { status: "running", lastError: null });
  }
  context.emit("session:updated", { sessionId });
}

async function finalizeRemoteResult(
  sessionId: string,
  destinationId: string,
  result: Message | Task,
  context: ApiContext,
  execution: ActiveExternalRequest,
): Promise<void> {
  if (execution.finalized) return;
  execution.finalized = true;
  if (isA2ATask(result)) await recordRemoteProgress(sessionId, destinationId, result, context, execution);
  const state = isA2ATask(result) ? result.status?.state : TaskState.TASK_STATE_COMPLETED;
  const text = externalA2AResultText(result) || `External A2A request ended in ${remoteState(result)}.`;
  insertMessage(sessionId, "assistant", text);
  if (state === TaskState.TASK_STATE_INPUT_REQUIRED || state === TaskState.TASK_STATE_AUTH_REQUIRED) {
    updateSession(sessionId, { status: "waiting", lastError: null });
  } else if (state === TaskState.TASK_STATE_COMPLETED) {
    updateSession(sessionId, { status: "idle", lastError: null });
  } else if (state === TaskState.TASK_STATE_CANCELED) {
    updateSession(sessionId, { status: "interrupted", lastError: "Remote A2A task was canceled" });
  } else {
    updateSession(sessionId, { status: "error", lastError: `Remote A2A task ended in ${remoteState(result)}` });
  }
  context.emit("session:updated", { sessionId });
}

/** Abort local waiting and propagate a stop to the mapped remote A2A task. */
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
    execution.controller.abort(new Error("External A2A cross-request stopped"));
  }
  patchOutboundMeta(sessionId, { cancellationRequestedAt: new Date().toISOString() });
  if (!destinationId || !taskId || !context.a2aOutbound) return Boolean(execution);

  const finalization = execution ?? {
    controller: new AbortController(),
    destinationId,
    taskId,
    cancelRequested: true,
    finalized: false,
    seenMessageIds: new Set<string>(),
  };
  void context.a2aOutbound.cancelTask(destinationId, taskId)
    .then((task) => finalizeRemoteResult(sessionId, destinationId, task, context, finalization))
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      updateSession(sessionId, { status: "error", lastError: `Remote A2A cancellation failed: ${message}` });
      context.emit("session:updated", { sessionId });
    });
  return true;
}

async function runExternalRequest(
  sessionId: string,
  service: ConfiguredExternalA2AService,
  brief: string,
  context: ApiContext,
): Promise<void> {
  const outbound = context.a2aOutbound;
  if (!outbound) {
    updateSession(sessionId, { status: "error", lastError: "Outbound A2A service is unavailable" });
    context.emit("session:updated", { sessionId });
    return;
  }
  updateSession(sessionId, { status: "running", lastError: null });
  context.emit("session:updated", { sessionId });
  const execution: ActiveExternalRequest = {
    controller: new AbortController(),
    destinationId: service.destinationId,
    cancelRequested: false,
    finalized: false,
    seenMessageIds: new Set(),
  };
  activeExternalRequests.set(sessionId, execution);
  try {
    let result = await outbound.send({
      destinationId: service.destinationId,
      skillId: service.skillId,
      message: brief,
      returnImmediately: true,
      signal: execution.controller.signal,
    });
    if (isA2ATask(result)) {
      await recordRemoteProgress(sessionId, service.destinationId, result, context, execution);
      if (execution.cancelRequested) {
        result = await outbound.cancelTask(service.destinationId, result.id);
        await finalizeRemoteResult(sessionId, service.destinationId, result, context, execution);
        return;
      }
      if (!externalA2ATaskIsTerminal(result)) {
        result = await outbound.waitForTask(service.destinationId, result.id, {
          signal: execution.controller.signal,
          onUpdate: (task) => recordRemoteProgress(sessionId, service.destinationId, task, context, execution),
        });
      }
    }
    await finalizeRemoteResult(sessionId, service.destinationId, result, context, execution);
  } catch (error) {
    if (execution.cancelRequested) {
      if (!execution.taskId) {
        updateSession(sessionId, {
          status: "interrupted",
          lastError: "External A2A request stopped before the remote task identity was confirmed",
        });
        context.emit("session:updated", { sessionId });
      }
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    updateSession(sessionId, { status: "error", lastError: `Outbound A2A request failed: ${message}` });
    context.emit("session:updated", { sessionId });
  } finally {
    if (activeExternalRequests.get(sessionId) === execution) activeExternalRequests.delete(sessionId);
  }
}

export function createExternalA2ACrossRequest(input: ExternalCrossRequestInput) {
  const config = input.context.getConfig();
  const brief = buildCrossRequestBrief({ requester: input.requester, service: input.service, prompt: input.prompt });
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
        state: "SUBMITTED",
      },
    },
  });
  const runSession = beginSessionRun({ sessionId: session.id, prompt: brief, transportMeta: session.transportMeta });
  if (!runSession) throw new Error(`Failed to create run ledger entry for external A2A session ${session.id}`);
  insertMessage(session.id, "user", brief);
  void runExternalRequest(session.id, input.service, brief, input.context);
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
