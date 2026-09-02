import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { Role, TaskState, type Message } from "@a2a-js/sdk";
import { ServerCallContext } from "@a2a-js/sdk/server";
import { A2AUser } from "../auth.js";
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

const message = (content = "hello"): Message => ({
  messageId: "client-message-1",
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
});
