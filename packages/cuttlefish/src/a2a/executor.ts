import {
  AgentEvent,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
  type ServerCallContext,
} from "@a2a-js/sdk/server";
import { randomUUID } from "node:crypto";
import { TaskState, type Message, type Task } from "@a2a-js/sdk";
import { RequestMalformedError, TaskNotCancelableError, TaskNotFoundError } from "@a2a-js/sdk/errors";
import type { ApiContext } from "../gateway/api/context.js";
import { listApprovals } from "../gateway/approvals.js";
import { findServiceProvider } from "../gateway/org-services.js";
import { scanOrg } from "../gateway/org.js";
import { stopSession } from "../gateway/session-lifecycle-service.js";
import { dispatchCollaborationMessage } from "../collaboration/dispatch.js";
import { saveFile } from "../gateway/files/uploads.js";
import { getSession, getSessionBySessionKey, listChildSessions, patchSessionTransportMeta } from "../sessions/registry.js";
import { listAdvertisedA2AServices, type AdvertisedA2AService } from "./card.js";
import { getA2AMaxArtifactBytes, getA2AMaxInputBytes, getA2APollIntervalMs, getConfiguredA2AClient, normalizeServiceName } from "./config.js";
import { parseA2AInput, resolveA2AService } from "./content.js";
import { canceledA2ATask, interruptedDispatchA2ATask } from "./task-mapper.js";
import type { SqliteA2ATaskStore } from "./store.js";

const TERMINAL_STATES = new Set([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
]);

interface ActiveExecution {
  context: ServerCallContext;
  aborted: boolean;
}

function owner(context: ServerCallContext): string {
  return context.user?.userName || "unknown";
}

function statusEvent(task: Task) {
  return AgentEvent.statusUpdate({
    taskId: task.id,
    contextId: task.contextId,
    status: task.status,
    metadata: {},
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sessionTree(rootSessionId: string) {
  const sessions = [];
  const visit = (sessionId: string): void => {
    for (const child of listChildSessions(sessionId)) {
      visit(child.id);
      sessions.push(child);
    }
  };
  visit(rootSessionId);
  const root = getSession(rootSessionId);
  if (root) sessions.push(root);
  return sessions;
}

function requestedService(message: Message): string | undefined {
  for (const key of ["skillId", "service", "cuttlefish.service"]) {
    const value = message.metadata?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** Keep every follow-up on the service selected by the task's initial message. */
export function resolveMappedA2AService(
  message: Message,
  task: Task,
  available: AdvertisedA2AService[],
): AdvertisedA2AService {
  const storedService = task.metadata?.["cuttlefish.service"];
  const storedSkillId = task.metadata?.["cuttlefish.skillId"];
  if (typeof storedService !== "string" || typeof storedSkillId !== "string") {
    return resolveA2AService(message, available);
  }

  const mapped = available.find((service) => (
    normalizeServiceName(service.name) === normalizeServiceName(storedService)
    && service.skillId === storedSkillId
  ));
  if (!mapped) throw new RequestMalformedError("The service mapped to this A2A task is no longer available to the caller");

  const requested = requestedService(message);
  if (requested && requested !== mapped.skillId && normalizeServiceName(requested) !== normalizeServiceName(mapped.name)) {
    throw new RequestMalformedError("An A2A follow-up cannot switch the service mapped to its task");
  }
  return mapped;
}

export class CuttlefishA2AExecutor implements AgentExecutor {
  private readonly active = new Map<string, ActiveExecution>();
  private readonly canceling = new Map<string, Promise<Task>>();

  constructor(
    private readonly store: SqliteA2ATaskStore,
    private readonly context: ApiContext,
  ) {}

  private allowedServices(context: ServerCallContext) {
    const config = this.context.getConfig();
    const client = getConfiguredA2AClient(config, owner(context));
    if (!client) return [];
    return listAdvertisedA2AServices(config)
      .filter((service) => client.allowedServices.has(normalizeServiceName(service.name)));
  }

  private async publishProjection(taskId: string, context: ServerCallContext, eventBus: ExecutionEventBus): Promise<Task> {
    const task = await this.store.load(taskId, context);
    if (!task) throw new TaskNotFoundError(`Task not found: ${taskId}`);
    for (const artifact of task.artifacts) {
      eventBus.publish(AgentEvent.artifactUpdate({
        taskId: task.id,
        contextId: task.contextId,
        artifact,
        append: false,
        lastChunk: true,
        metadata: {},
      }));
    }
    eventBus.publish(statusEvent(task));
    return task;
  }

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const initial = requestContext.task ?? await this.store.load(requestContext.taskId, requestContext.context);
    if (!initial) throw new TaskNotFoundError(`Task not found: ${requestContext.taskId}`);

    const active: ActiveExecution = { context: requestContext.context, aborted: false };
    this.active.set(initial.id, active);
    try {
      const config = this.context.getConfig();
      const record = await this.store.getRecord(initial.id, requestContext.context);
      if (!record) throw new TaskNotFoundError(`Task not found: ${initial.id}`);

      const pendingApproval = record.sessionId
        ? sessionTree(record.sessionId).some((session) => listApprovals({ state: "pending", sessionId: session.id }).length > 0)
        : false;
      if (pendingApproval) {
        eventBus.publish(AgentEvent.task(initial));
        await this.publishProjection(initial.id, requestContext.context, eventBus);
        this.store.markMessageDispatched(requestContext.userMessage.messageId, requestContext.context);
        return;
      }

      const parsedInput = parseA2AInput(
        requestContext.userMessage,
        getA2AMaxInputBytes(config),
        getA2AMaxArtifactBytes(config),
      );
      const prompt = parsedInput.prompt;
      const service = resolveMappedA2AService(requestContext.userMessage, initial, this.allowedServices(requestContext.context));
      const provider = findServiceProvider(scanOrg(), service.name);
      if (!provider) throw new Error(`The allowlisted service "${service.name}" no longer has an active provider`);

      initial.metadata = { ...(initial.metadata ?? {}), "cuttlefish.service": service.name, "cuttlefish.skillId": service.skillId };
      await this.store.save(initial, requestContext.context);
      eventBus.publish(AgentEvent.task(initial));
      const existingSession = record.sessionId ? getSession(record.sessionId) : undefined;
      const contextRootSessionId = this.store.getContextRoot(initial.contextId, requestContext.context);
      const attachmentInputs: unknown[] = [...parsedInput.urlResources];
      const result = await dispatchCollaborationMessage({
        lane: "management",
        message: prompt,
        projectRootSessionId: contextRootSessionId,
        targets: [{
          recipientId: provider.employee.name,
          session: existingSession,
          employee: provider.employee,
          sessionKey: `a2a:task:${initial.id}`,
        }],
        context: this.context,
        userId: `a2a:${owner(requestContext.context)}`,
        author: { kind: "system", id: owner(requestContext.context), displayName: `A2A client ${owner(requestContext.context)}` },
        turnBody: { attachments: attachmentInputs },
        beforeDispatch: async ({ session }) => {
          const canonicalContextRoot = !record.sessionId
            ? this.store.linkSession(initial.id, requestContext.context, session.id)
            : this.store.getContextRoot(initial.contextId, requestContext.context);
          for (const file of parsedInput.rawFiles) {
            const stored = await saveFile({
              id: randomUUID(),
              filename: file.filename,
              buffer: file.buffer,
              mimetype: file.mediaType,
              customPath: null,
              open: false,
              sessionId: session.id,
              artifactKind: "input",
              tags: ["a2a-input"],
              notes: `Inbound A2A artifact for task ${initial.id}`,
            }, this.context);
            attachmentInputs.push(stored.id);
          }
          patchSessionTransportMeta(session.id, {
            ...(canonicalContextRoot && canonicalContextRoot !== session.id
              ? { managementProjectRootSessionId: canonicalContextRoot }
              : {}),
            a2a: {
              taskId: initial.id,
              contextId: initial.contextId,
              clientId: owner(requestContext.context),
              service: service.name,
              skillId: service.skillId,
            },
          });
        },
      });
      if (!result.ok) throw new Error(result.error);
      this.store.markMessageDispatched(requestContext.userMessage.messageId, requestContext.context);

      const working: Task = {
        ...initial,
        status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: new Date().toISOString() },
      };
      eventBus.publish(statusEvent(working));

      while (!active.aborted) {
        const projected = await this.store.load(initial.id, requestContext.context);
        if (!projected) throw new TaskNotFoundError(`Task not found: ${initial.id}`);
        const state = projected.status?.state;
        if (state === TaskState.TASK_STATE_INPUT_REQUIRED || (state !== undefined && TERMINAL_STATES.has(state))) {
          await this.publishProjection(initial.id, requestContext.context, eventBus);
          return;
        }
        await delay(getA2APollIntervalMs(this.context.getConfig()));
      }
    } finally {
      this.active.delete(initial.id);
    }
  }

  /**
   * Resolve an ambiguous restart without dispatching a second turn. The task is
   * failed explicitly so the caller can safely retry with a new message id.
   */
  async failInterruptedMessage(taskId: string, messageId: string, context: ServerCallContext): Promise<Task> {
    const record = await this.store.getRecord(taskId, context);
    if (!record) throw new TaskNotFoundError(`Task not found: ${taskId}`);
    const current = await this.store.load(taskId, context);
    if (!current) throw new TaskNotFoundError(`Task not found: ${taskId}`);
    const state = current.status?.state;
    const isInitialReceipt = messageId === record.initialMessageId;
    if (isInitialReceipt && (state === TaskState.TASK_STATE_INPUT_REQUIRED || (state !== undefined && TERMINAL_STATES.has(state)))) {
      this.store.markMessageDispatched(messageId, context);
      return current;
    }

    const mappedSession = record.sessionId
      ? getSession(record.sessionId)
      : getSessionBySessionKey(`a2a:task:${taskId}`);
    if (mappedSession) {
      for (const session of sessionTree(mappedSession.id)) {
        const result = stopSession(session.id, this.context);
        if (result.statusCode >= 400) {
          throw new TaskNotCancelableError(`Cannot safely resolve interrupted A2A dispatch for task ${taskId}`);
        }
      }
    }
    const failed = interruptedDispatchA2ATask(current);
    await this.store.save(failed, context);
    this.store.markMessageDispatched(messageId, context);
    return failed;
  }

  private async performCancellation(taskId: string, context: ServerCallContext, eventBus?: ExecutionEventBus): Promise<Task> {
    const record = await this.store.getRecord(taskId, context);
    if (!record) throw new TaskNotFoundError(`Task not found: ${taskId}`);
    const current = await this.store.load(taskId, context);
    if (!current) throw new TaskNotFoundError(`Task not found: ${taskId}`);
    if (current.status?.state === TaskState.TASK_STATE_CANCELED) return current;
    if (current.status?.state !== undefined && TERMINAL_STATES.has(current.status.state)) {
      throw new TaskNotCancelableError(`Task not cancelable: ${taskId}`);
    }

    const active = this.active.get(taskId);
    if (active) active.aborted = true;
    if (record.sessionId) {
      for (const session of sessionTree(record.sessionId)) {
        const result = stopSession(session.id, this.context);
        if (result.statusCode >= 400) throw new TaskNotCancelableError(`Task not cancelable: ${taskId}`);
      }
    }
    const timestamp = new Date().toISOString();
    this.store.markCanceled(taskId, context, timestamp);
    const canceled = canceledA2ATask(current, timestamp);
    await this.store.save(canceled, context);
    eventBus?.publish(statusEvent(canceled));
    return canceled;
  }

  async cancelMappedTask(taskId: string, context: ServerCallContext, eventBus?: ExecutionEventBus): Promise<Task> {
    const current = this.canceling.get(taskId);
    if (current) return current;
    const operation = this.performCancellation(taskId, context, eventBus);
    this.canceling.set(taskId, operation);
    try {
      return await operation;
    } finally {
      if (this.canceling.get(taskId) === operation) this.canceling.delete(taskId);
    }
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    const active = this.active.get(taskId);
    if (!active) throw new TaskNotCancelableError(`Task ${taskId} is not active in this process`);
    await this.cancelMappedTask(taskId, active.context, eventBus);
  }
}
