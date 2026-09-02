import type {
  AgentCard,
  CancelTaskRequest,
  DeleteTaskPushNotificationConfigRequest,
  GetExtendedAgentCardRequest,
  GetTaskPushNotificationConfigRequest,
  GetTaskRequest,
  ListTaskPushNotificationConfigsRequest,
  ListTaskPushNotificationConfigsResponse,
  ListTasksRequest,
  ListTasksResponse,
  Message,
  SendMessageRequest,
  StreamResponse,
  SubscribeToTaskRequest,
  Task,
  TaskPushNotificationConfig,
} from "@a2a-js/sdk";
import type { A2ARequestHandler, ExecutionEventBusManager, ServerCallContext } from "@a2a-js/sdk/server";
import type { CuttlefishA2AExecutor } from "./executor.js";
import type { SqliteA2ATaskStore } from "./store.js";

/** Adds durable per-message idempotency and restart-safe cancellation. */
export class CuttlefishA2ARequestHandler implements A2ARequestHandler {
  private readonly inFlightMessages = new Set<string>();

  constructor(
    private readonly delegate: A2ARequestHandler,
    private readonly store: SqliteA2ATaskStore,
    private readonly executor: CuttlefishA2AExecutor,
    private readonly agentCardProvider?: () => Promise<AgentCard>,
    private readonly eventBuses?: ExecutionEventBusManager,
  ) {}

  getAgentCard(): Promise<AgentCard> {
    return this.agentCardProvider?.() ?? this.delegate.getAgentCard();
  }

  getAuthenticatedExtendedAgentCard(params: GetExtendedAgentCardRequest, context: ServerCallContext): Promise<AgentCard> {
    return this.delegate.getAuthenticatedExtendedAgentCard(params, context);
  }

  private reserve(params: SendMessageRequest, context: ServerCallContext): {
    params: SendMessageRequest;
    task?: Task;
    replayed: boolean;
    dispatched: boolean;
    key?: string;
  } {
    const message = params.message;
    if (!message) return { params, replayed: false, dispatched: false };
    const reservation = this.store.reserveMessage(message, context);
    const key = `${context.user?.userName ?? "unknown"}\u0000${message.messageId}`;
    const mappedParams = message.taskId ? params : {
      ...params,
      message: {
        ...message,
        taskId: reservation.task.id,
        contextId: reservation.task.contextId,
      },
    };
    return {
      params: mappedParams,
      task: reservation.task,
      replayed: reservation.replayed,
      dispatched: reservation.dispatched,
      key,
    };
  }

  async sendMessage(params: SendMessageRequest, context: ServerCallContext): Promise<Message | Task> {
    const reserved = this.reserve(params, context);
    if (!reserved.task || !reserved.key) return this.delegate.sendMessage(reserved.params, context);
    if (reserved.replayed) {
      if (!reserved.dispatched && !this.inFlightMessages.has(reserved.key)) {
        return this.executor.failInterruptedMessage(reserved.task.id, params.message!.messageId, context);
      }
      return (await this.store.load(reserved.task.id, context)) ?? reserved.task;
    }

    this.inFlightMessages.add(reserved.key);
    try {
      return await this.delegate.sendMessage(reserved.params, context);
    } finally {
      this.inFlightMessages.delete(reserved.key);
    }
  }

  async *sendMessageStream(params: SendMessageRequest, context: ServerCallContext): AsyncGenerator<StreamResponse, void, undefined> {
    const reserved = this.reserve(params, context);
    if (!reserved.task || !reserved.key) {
      yield* this.delegate.sendMessageStream(reserved.params, context);
      return;
    }
    if (reserved.replayed) {
      const task = !reserved.dispatched && !this.inFlightMessages.has(reserved.key)
        ? await this.executor.failInterruptedMessage(reserved.task.id, params.message!.messageId, context)
        : (await this.store.load(reserved.task.id, context)) ?? reserved.task;
      yield { payload: { $case: "task", value: task } };
      return;
    }

    this.inFlightMessages.add(reserved.key);
    try {
      yield* this.delegate.sendMessageStream(reserved.params, context);
    } finally {
      this.inFlightMessages.delete(reserved.key);
    }
  }

  getTask(params: GetTaskRequest, context: ServerCallContext): Promise<Task> {
    return this.delegate.getTask(params, context);
  }

  listTasks(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
    return this.delegate.listTasks(params, context);
  }

  cancelTask(params: CancelTaskRequest, context: ServerCallContext): Promise<Task> {
    return this.executor.cancelMappedTask(params.id, context, this.eventBuses?.getByTaskId(params.id));
  }

  createTaskPushNotificationConfig(params: TaskPushNotificationConfig, context: ServerCallContext): Promise<TaskPushNotificationConfig> {
    return this.delegate.createTaskPushNotificationConfig(params, context);
  }

  getTaskPushNotificationConfig(params: GetTaskPushNotificationConfigRequest, context: ServerCallContext): Promise<TaskPushNotificationConfig> {
    return this.delegate.getTaskPushNotificationConfig(params, context);
  }

  listTaskPushNotificationConfigs(params: ListTaskPushNotificationConfigsRequest, context: ServerCallContext): Promise<ListTaskPushNotificationConfigsResponse> {
    return this.delegate.listTaskPushNotificationConfigs(params, context);
  }

  deleteTaskPushNotificationConfig(params: DeleteTaskPushNotificationConfigRequest, context: ServerCallContext): Promise<void> {
    return this.delegate.deleteTaskPushNotificationConfig(params, context);
  }

  resubscribe(params: SubscribeToTaskRequest, context: ServerCallContext): AsyncGenerator<StreamResponse, void, undefined> {
    return this.delegate.resubscribe(params, context);
  }
}
