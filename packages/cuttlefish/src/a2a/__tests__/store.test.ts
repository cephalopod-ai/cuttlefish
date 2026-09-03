import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { Role, TaskState, type Message } from "@a2a-js/sdk";
import { ServerCallContext } from "@a2a-js/sdk/server";
import { A2AUser } from "../auth.js";
import { SqliteA2ATaskStore, type A2ATaskRecord } from "../store.js";
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
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY)");
  db.exec(CREATE_A2A_CONTEXTS_TABLE);
  db.exec(CREATE_A2A_TASKS_TABLE);
  db.exec(CREATE_A2A_TASKS_OWNER_INDEX);
  db.exec(CREATE_A2A_TASKS_CONTEXT_INDEX);
  db.exec(CREATE_A2A_MESSAGES_TABLE);
  db.exec(CREATE_A2A_MESSAGES_TASK_INDEX);
  return db;
}

const context = (owner: string) => new ServerCallContext({ user: new A2AUser(owner), requestedVersion: "1.0" });

const message = (content = "hello", messageId = "client-message-1"): Message => ({
  messageId,
  contextId: "",
  taskId: "",
  role: Role.ROLE_USER,
  parts: [{ content: { $case: "text", value: content }, mediaType: "text/plain", filename: "", metadata: {} }],
  metadata: {},
  extensions: [],
  referenceTaskIds: [],
});

describe("SqliteA2ATaskStore", () => {
  it("reserves initial work once and survives a store restart", async () => {
    const db = database();
    const firstStore = new SqliteA2ATaskStore(() => db);
    const first = firstStore.reserveInitial(message(), context("partner-a"));
    const retry = firstStore.reserveInitial(message(), context("partner-a"));
    expect(retry).toMatchObject({ replayed: true, dispatched: false, task: { id: first.task.id } });
    firstStore.markMessageDispatched(message().messageId, context("partner-a"));
    expect(firstStore.reserveInitial(message(), context("partner-a"))).toMatchObject({ replayed: true, dispatched: true });

    const restarted = new SqliteA2ATaskStore(() => db);
    expect(await restarted.load(first.task.id, context("partner-a"))).toMatchObject({
      id: first.task.id,
      status: { state: TaskState.TASK_STATE_SUBMITTED },
    });
    db.close();
  });

  it("retains the first session as the durable root for a shared A2A context", () => {
    const db = database();
    const store = new SqliteA2ATaskStore(() => db);
    const owner = context("partner-a");
    const firstMessage = { ...message("first"), contextId: "shared-context" };
    const first = store.reserveInitial(firstMessage, owner);
    db.prepare("INSERT INTO sessions (id) VALUES (?)").run("root-session");
    expect(store.linkSession(first.task.id, owner, "root-session")).toBe("root-session");
    const secondMessage = { ...message("second"), messageId: "client-message-2", contextId: "shared-context" };
    store.reserveInitial(secondMessage, owner);

    expect(store.getContextRoot("shared-context", owner)).toBe("root-session");
    db.close();
  });

  it("atomically returns one canonical context root after stale concurrent reads", () => {
    const db = database();
    const store = new SqliteA2ATaskStore(() => db);
    const owner = context("partner-a");
    const first = store.reserveInitial({ ...message("first"), contextId: "raced-context" }, owner);
    const second = store.reserveInitial({
      ...message("second"),
      messageId: "client-message-2",
      contextId: "raced-context",
    }, owner);
    db.prepare("INSERT INTO sessions (id) VALUES (?), (?)").run("race-session-a", "race-session-b");

    expect(store.getContextRoot("raced-context", owner)).toBeUndefined();
    expect(store.getContextRoot("raced-context", owner)).toBeUndefined();
    const firstRoot = store.linkSession(first.task.id, owner, "race-session-a");
    const secondRoot = store.linkSession(second.task.id, owner, "race-session-b");

    expect(firstRoot).toBe("race-session-a");
    expect(secondRoot).toBe("race-session-a");
    expect(store.getContextRoot("raced-context", owner)).toBe("race-session-a");
    db.close();
  });

  it("rejects message-id reuse with changed input", () => {
    const db = database();
    const store = new SqliteA2ATaskStore(() => db);
    store.reserveInitial(message("first"), context("partner-a"));
    expect(() => store.reserveInitial(message("changed"), context("partner-a"))).toThrow(/different content/);
    db.close();
  });

  it("isolates task lookup and idempotency by authenticated caller", async () => {
    const db = database();
    const store = new SqliteA2ATaskStore(() => db);
    const a = store.reserveInitial(message(), context("partner-a"));
    const b = store.reserveInitial(message(), context("partner-b"));
    expect(a.task.id).not.toBe(b.task.id);
    expect(await store.load(a.task.id, context("partner-b"))).toBeUndefined();
    expect((await store.list({
      tenant: "",
      contextId: "",
      status: TaskState.TASK_STATE_UNSPECIFIED,
      pageToken: "",
      statusTimestampAfter: undefined,
    }, context("partner-a"))).totalSize).toBe(1);
    db.close();
  });

  it("filters context and paginates in SQLite before projecting ordinary task lists", async () => {
    const db = database();
    const projector = vi.fn(async (record: A2ATaskRecord) => record.task);
    const store = new SqliteA2ATaskStore(() => db, projector);
    const owner = context("partner-a");
    for (let index = 0; index < 5; index += 1) {
      store.reserveInitial({
        ...message(`selected-${index}`, `selected-message-${index}`),
        contextId: "selected-context",
      }, owner);
    }
    for (let index = 0; index < 4; index += 1) {
      store.reserveInitial({
        ...message(`other-${index}`, `other-message-${index}`),
        contextId: "other-context",
      }, owner);
    }

    const first = await store.list({
      tenant: "",
      contextId: "selected-context",
      status: TaskState.TASK_STATE_UNSPECIFIED,
      pageSize: 2,
      pageToken: "",
      statusTimestampAfter: undefined,
    }, owner);

    expect(first).toMatchObject({ pageSize: 2, totalSize: 5 });
    expect(first.tasks).toHaveLength(2);
    expect(first.nextPageToken).not.toBe("");
    expect(projector).toHaveBeenCalledTimes(2);

    projector.mockClear();
    const second = await store.list({
      tenant: "",
      contextId: "selected-context",
      status: TaskState.TASK_STATE_UNSPECIFIED,
      pageSize: 2,
      pageToken: first.nextPageToken,
      statusTimestampAfter: undefined,
    }, owner);
    expect(second.tasks).toHaveLength(2);
    expect(second.totalSize).toBe(5);
    expect(projector).toHaveBeenCalledTimes(2);
    db.close();
  });

  it("preserves exact projected status and timestamp filtering across pages", async () => {
    const db = database();
    const projector = vi.fn(async (record: A2ATaskRecord) => ({
      ...record.task,
      status: {
        state: record.initialMessageId.includes("-completed-")
          ? TaskState.TASK_STATE_COMPLETED
          : TaskState.TASK_STATE_WORKING,
        message: record.task.status?.message,
        timestamp: record.initialMessageId.endsWith("-old")
          ? "2026-09-01T00:00:00.000Z"
          : "2026-09-03T00:00:00.000Z",
      },
    }));
    const store = new SqliteA2ATaskStore(() => db, projector);
    const owner = context("partner-a");
    store.reserveInitial(message("one", "one-completed-recent"), owner);
    store.reserveInitial(message("two", "two-working-recent"), owner);
    store.reserveInitial(message("three", "three-completed-old"), owner);
    store.reserveInitial(message("four", "four-completed-recent"), owner);

    const first = await store.list({
      tenant: "",
      contextId: "",
      status: TaskState.TASK_STATE_COMPLETED,
      pageSize: 1,
      pageToken: "",
      statusTimestampAfter: "2026-09-02T00:00:00.000Z",
    }, owner);

    expect(first).toMatchObject({ pageSize: 1, totalSize: 2 });
    expect(first.tasks).toHaveLength(1);
    expect(first.nextPageToken).not.toBe("");
    expect(projector).toHaveBeenCalledTimes(4);

    projector.mockClear();
    const second = await store.list({
      tenant: "",
      contextId: "",
      status: TaskState.TASK_STATE_COMPLETED,
      pageSize: 1,
      pageToken: first.nextPageToken,
      statusTimestampAfter: "2026-09-02T00:00:00.000Z",
    }, owner);
    expect(second).toMatchObject({ pageSize: 1, totalSize: 2, nextPageToken: "" });
    expect(second.tasks).toHaveLength(1);
    expect(second.tasks[0]?.id).not.toBe(first.tasks[0]?.id);
    expect(projector).toHaveBeenCalledTimes(4);
    db.close();
  });

  it("bounds dynamic projection batches while retaining exact totals", async () => {
    const db = database();
    let active = 0;
    let maxActive = 0;
    const projector = vi.fn(async (record: A2ATaskRecord) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return {
        ...record.task,
        status: {
          state: record.initialMessageId.includes("-match-")
            ? TaskState.TASK_STATE_COMPLETED
            : TaskState.TASK_STATE_WORKING,
          message: record.task.status?.message,
          timestamp: record.task.status?.timestamp ?? "2026-09-02T00:00:00.000Z",
        },
      };
    });
    const store = new SqliteA2ATaskStore(() => db, projector);
    const owner = context("partner-a");
    for (let index = 0; index < 205; index += 1) {
      store.reserveInitial({
        ...message(`candidate-${index}`, `candidate-${index % 2 === 0 ? "match" : "miss"}-${index}`),
        contextId: "batched-context",
      }, owner);
    }
    for (let index = 0; index < 25; index += 1) {
      store.reserveInitial({
        ...message(`excluded-${index}`, `excluded-match-${index}`),
        contextId: "other-context",
      }, owner);
    }

    const result = await store.list({
      tenant: "",
      contextId: "batched-context",
      status: TaskState.TASK_STATE_COMPLETED,
      pageSize: 7,
      pageToken: "",
      statusTimestampAfter: undefined,
    }, owner);

    expect(result).toMatchObject({ pageSize: 7, totalSize: 103 });
    expect(result.tasks).toHaveLength(7);
    expect(result.nextPageToken).not.toBe("");
    expect(projector).toHaveBeenCalledTimes(205);
    expect(maxActive).toBeLessThanOrEqual(100);
    expect(maxActive).toBeGreaterThan(1);
    db.close();
  });
});
