import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { Role, TaskState, type Message, type SendMessageRequest } from "@a2a-js/sdk";
import type { A2ARequestHandler } from "@a2a-js/sdk/server";
import { ServerCallContext } from "@a2a-js/sdk/server";
import { A2AUser } from "../auth.js";
import { CuttlefishA2ARequestHandler } from "../request-handler.js";
import { SqliteA2ATaskStore } from "../store.js";
import {
  CREATE_A2A_CONTEXTS_TABLE,
  CREATE_A2A_MESSAGES_TABLE,
  CREATE_A2A_MESSAGES_TASK_INDEX,
  CREATE_A2A_TASKS_CONTEXT_INDEX,
  CREATE_A2A_TASKS_OWNER_INDEX,
  CREATE_A2A_TASKS_TABLE,
} from "../../sessions/registry/schema.js";

function database(): Database.Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY)");
  db.exec(CREATE_A2A_CONTEXTS_TABLE);
  db.exec(CREATE_A2A_TASKS_TABLE);
  db.exec(CREATE_A2A_TASKS_OWNER_INDEX);
  db.exec(CREATE_A2A_TASKS_CONTEXT_INDEX);
  db.exec(CREATE_A2A_MESSAGES_TABLE);
  db.exec(CREATE_A2A_MESSAGES_TASK_INDEX);
  return db;
}

function request(content: string): SendMessageRequest {
  const message: Message = {
    messageId: "stable-message-id",
    contextId: "",
    taskId: "",
    role: Role.ROLE_USER,
    parts: [{ content: { $case: "text", value: content }, mediaType: "text/plain", filename: "", metadata: {} }],
    metadata: { service: "review" },
    extensions: [],
    referenceTaskIds: [],
  };
  return { tenant: "", message, configuration: undefined, metadata: undefined };
}

describe("CuttlefishA2ARequestHandler", () => {
  it("dispatches a retried initial message exactly once", async () => {
    const db = database();
    const store = new SqliteA2ATaskStore(() => db);
    const context = new ServerCallContext({ user: new A2AUser("partner-a"), requestedVersion: "1.0" });
    const sendMessage = vi.fn(async (params: SendMessageRequest) => {
      const task = await store.load(params.message!.taskId, context);
      expect(task).toBeDefined();
      task!.status = { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: new Date().toISOString() };
      await store.save(task!, context);
      store.markMessageDispatched(params.message!.messageId, context);
      return task!;
    });
    const delegate = { sendMessage } as unknown as A2ARequestHandler;
    const handler = new CuttlefishA2ARequestHandler(delegate, store, { failInterruptedMessage: vi.fn() } as never);

    const first = await handler.sendMessage(request("review this"), context);
    const retry = await handler.sendMessage(request("review this"), context);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ id: expect.any(String), status: { state: TaskState.TASK_STATE_COMPLETED } });
    expect(retry).toMatchObject({ id: (first as { id: string }).id, status: { state: TaskState.TASK_STATE_COMPLETED } });
    db.close();
  });

  it("rejects changed content that reuses an initial message id", async () => {
    const db = database();
    const store = new SqliteA2ATaskStore(() => db);
    const context = new ServerCallContext({ user: new A2AUser("partner-a"), requestedVersion: "1.0" });
    const delegate = { sendMessage: vi.fn(async () => { throw new Error("not reached"); }) } as unknown as A2ARequestHandler;
    const handler = new CuttlefishA2ARequestHandler(delegate, store, { failInterruptedMessage: vi.fn() } as never);
    store.reserveInitial(request("first").message!, context);
    await expect(handler.sendMessage(request("changed"), context)).rejects.toThrow(/different content/);
    expect(delegate.sendMessage).not.toHaveBeenCalled();
    db.close();
  });

  it("continues a mapped task without reserving duplicate work", async () => {
    const db = database();
    const store = new SqliteA2ATaskStore(() => db);
    const context = new ServerCallContext({ user: new A2AUser("partner-a"), requestedVersion: "1.0" });
    const initial = store.reserveInitial(request("initial").message!, context).task;
    const sendMessage = vi.fn(async (params: SendMessageRequest) => {
      store.markMessageDispatched(params.message!.messageId, context);
      return initial;
    });
    const delegate = { sendMessage } as unknown as A2ARequestHandler;
    const handler = new CuttlefishA2ARequestHandler(delegate, store, { failInterruptedMessage: vi.fn() } as never);
    const followUp = request("continue");
    followUp.message = { ...followUp.message!, messageId: "follow-up-message", taskId: initial.id, contextId: initial.contextId };

    await handler.sendMessage(followUp, context);
    await handler.sendMessage(followUp, context);

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.objectContaining({ taskId: initial.id, contextId: initial.contextId }),
    }), context);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect((db.prepare("SELECT COUNT(*) AS count FROM a2a_tasks").get() as { count: number }).count).toBe(1);
    db.close();
  });

  it("rejects changed follow-up content that reuses a message id", async () => {
    const db = database();
    const store = new SqliteA2ATaskStore(() => db);
    const context = new ServerCallContext({ user: new A2AUser("partner-a"), requestedVersion: "1.0" });
    const initial = store.reserveInitial(request("initial").message!, context).task;
    const delegate = { sendMessage: vi.fn(async (params: SendMessageRequest) => {
      store.markMessageDispatched(params.message!.messageId, context);
      return initial;
    }) } as unknown as A2ARequestHandler;
    const handler = new CuttlefishA2ARequestHandler(delegate, store, { failInterruptedMessage: vi.fn() } as never);
    const first = request("first follow-up");
    first.message = { ...first.message!, messageId: "changed-follow-up", taskId: initial.id, contextId: initial.contextId };
    const changed = request("changed follow-up");
    changed.message = { ...changed.message!, messageId: "changed-follow-up", taskId: initial.id, contextId: initial.contextId };
    await handler.sendMessage(first, context);
    await expect(handler.sendMessage(changed, context)).rejects.toThrow(/different content or task/);
    expect(delegate.sendMessage).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("fails an unconfirmed receipt after restart instead of duplicating dispatch", async () => {
    const db = database();
    const store = new SqliteA2ATaskStore(() => db);
    const context = new ServerCallContext({ user: new A2AUser("partner-a"), requestedVersion: "1.0" });
    const original = store.reserveInitial(request("review this").message!, context).task;
    const failed = {
      ...original,
      status: { state: TaskState.TASK_STATE_FAILED, message: undefined, timestamp: new Date().toISOString() },
    };
    const failInterruptedMessage = vi.fn(async () => failed);
    const delegate = { sendMessage: vi.fn() } as unknown as A2ARequestHandler;
    const handler = new CuttlefishA2ARequestHandler(delegate, store, { failInterruptedMessage } as never);

    const response = await handler.sendMessage(request("review this"), context);

    expect(delegate.sendMessage).not.toHaveBeenCalled();
    expect(failInterruptedMessage).toHaveBeenCalledWith(original.id, "stable-message-id", context);
    expect(response).toMatchObject({ id: original.id, status: { state: TaskState.TASK_STATE_FAILED } });
    db.close();
  });
});
