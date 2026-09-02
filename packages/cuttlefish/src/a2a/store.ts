import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  Task,
  TaskState,
  type ListTasksRequest,
  type ListTasksResponse,
  type Message,
} from "@a2a-js/sdk";
import type { ServerCallContext, TaskStore } from "@a2a-js/sdk/server";
import { RequestMalformedError, TaskNotFoundError } from "@a2a-js/sdk/errors";
import { initDb } from "../sessions/registry.js";
import { hashA2AInput } from "./content.js";

interface A2ATaskRow {
  task_id: string;
  context_id: string;
  owner_id: string;
  initial_message_id: string;
  input_hash: string;
  session_id: string | null;
  task_json: string;
  canceled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface A2ATaskRecord {
  task: Task;
  ownerId: string;
  initialMessageId: string;
  inputHash: string;
  sessionId?: string;
  canceledAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface A2ATaskReservation {
  task: Task;
  replayed: boolean;
  dispatched: boolean;
}

interface A2AMessageRow {
  task_id: string;
  input_hash: string;
  dispatched_at: string | null;
}

export type A2ATaskProjector = (record: A2ATaskRecord) => Task | Promise<Task>;

function ownerId(context: ServerCallContext): string {
  const user = context.user;
  if (!user?.isAuthenticated || !user.userName) {
    throw new RequestMalformedError("An authenticated A2A caller identity is required");
  }
  return user.userName;
}

function parseTask(json: string): Task {
  try {
    return Task.fromJSON(JSON.parse(json));
  } catch {
    throw new Error("Stored A2A task data is corrupt");
  }
}

function serializeTask(task: Task): string {
  return JSON.stringify(Task.toJSON(task));
}

function recordFromRow(row: A2ATaskRow): A2ATaskRecord {
  return {
    task: parseTask(row.task_json),
    ownerId: row.owner_id,
    initialMessageId: row.initial_message_id,
    inputHash: row.input_hash,
    sessionId: row.session_id ?? undefined,
    canceledAt: row.canceled_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function limitHistory(task: Task, historyLength: number | undefined): Task {
  if (historyLength === undefined) return task;
  return { ...task, history: historyLength <= 0 ? [] : task.history.slice(-historyLength) };
}

function parsePageToken(value: string): number {
  if (!value) return 0;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const offset = Number(decoded);
    if (Number.isSafeInteger(offset) && offset >= 0) return offset;
  } catch {
    // Fall through to the protocol error below.
  }
  throw new RequestMalformedError("Invalid A2A page token");
}

function pageToken(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

export class SqliteA2ATaskStore implements TaskStore {
  constructor(
    private readonly getDb: () => Database.Database = initDb,
    private readonly projector?: A2ATaskProjector,
  ) {}

  private row(taskId: string, owner: string): A2ATaskRow | undefined {
    return this.getDb().prepare(
      `SELECT task_id, context_id, owner_id, initial_message_id, input_hash,
              session_id, task_json, canceled_at, created_at, updated_at
         FROM a2a_tasks WHERE task_id = ? AND owner_id = ?`,
    ).get(taskId, owner) as A2ATaskRow | undefined;
  }

  async getRecord(taskId: string, context: ServerCallContext): Promise<A2ATaskRecord | undefined> {
    const row = this.row(taskId, ownerId(context));
    return row ? recordFromRow(row) : undefined;
  }

  reserveInitial(message: Message, context: ServerCallContext): A2ATaskReservation {
    if (!message.messageId) throw new RequestMalformedError("message.messageId is required");
    if (message.taskId) throw new RequestMalformedError("Only a new A2A message can reserve a task");
    const owner = ownerId(context);
    const inputHash = hashA2AInput(message);
    const db = this.getDb();
    return db.transaction((): A2ATaskReservation => {
      const prior = db.prepare(
        `SELECT task_id, context_id, owner_id, initial_message_id, input_hash,
                session_id, task_json, canceled_at, created_at, updated_at
           FROM a2a_tasks WHERE owner_id = ? AND initial_message_id = ?`,
      ).get(owner, message.messageId) as A2ATaskRow | undefined;
      if (prior) {
        if (prior.input_hash !== inputHash) {
          throw new RequestMalformedError("message.messageId was already used with different content");
        }
        db.prepare(
          `INSERT OR IGNORE INTO a2a_messages (owner_id, message_id, task_id, input_hash, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(owner, message.messageId, prior.task_id, inputHash, prior.created_at);
        const receipt = db.prepare(
          "SELECT task_id, input_hash, dispatched_at FROM a2a_messages WHERE owner_id = ? AND message_id = ?",
        ).get(owner, message.messageId) as A2AMessageRow | undefined;
        return { task: recordFromRow(prior).task, replayed: true, dispatched: Boolean(receipt?.dispatched_at) };
      }

      const now = new Date().toISOString();
      const contextId = message.contextId || randomUUID();
      const task: Task = {
        id: randomUUID(),
        contextId,
        status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: now },
        artifacts: [],
        history: [],
        metadata: {},
      };
      db.prepare(
        `INSERT INTO a2a_contexts (context_id, owner_id, root_session_id, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?)
         ON CONFLICT(context_id, owner_id) DO UPDATE SET updated_at = excluded.updated_at`,
      ).run(contextId, owner, now, now);
      db.prepare(
        `INSERT INTO a2a_tasks
           (task_id, context_id, owner_id, initial_message_id, input_hash, session_id,
            task_json, canceled_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)`,
      ).run(task.id, contextId, owner, message.messageId, inputHash, serializeTask(task), now, now);
      db.prepare(
        `INSERT INTO a2a_messages (owner_id, message_id, task_id, input_hash, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(owner, message.messageId, task.id, inputHash, now);
      return { task, replayed: false, dispatched: false };
    })();
  }

  /** Reserve every message id before dispatch, including follow-up turns. */
  reserveMessage(message: Message, context: ServerCallContext): A2ATaskReservation {
    if (!message.taskId) return this.reserveInitial(message, context);
    if (!message.messageId) throw new RequestMalformedError("message.messageId is required");
    const owner = ownerId(context);
    const inputHash = hashA2AInput(message);
    const db = this.getDb();
    return db.transaction((): A2ATaskReservation => {
      const prior = db.prepare(
        "SELECT task_id, input_hash, dispatched_at FROM a2a_messages WHERE owner_id = ? AND message_id = ?",
      ).get(owner, message.messageId) as A2AMessageRow | undefined;
      if (prior) {
        if (prior.task_id !== message.taskId || prior.input_hash !== inputHash) {
          throw new RequestMalformedError("message.messageId was already used with different content or task");
        }
        const row = this.row(prior.task_id, owner);
        if (!row) throw new TaskNotFoundError(`Task not found: ${prior.task_id}`);
        return { task: recordFromRow(row).task, replayed: true, dispatched: Boolean(prior.dispatched_at) };
      }
      const row = this.row(message.taskId, owner);
      if (!row) throw new TaskNotFoundError(`Task not found: ${message.taskId}`);
      if (message.contextId && message.contextId !== row.context_id) {
        throw new RequestMalformedError("message.contextId does not match the mapped task context");
      }
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO a2a_messages (owner_id, message_id, task_id, input_hash, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(owner, message.messageId, message.taskId, inputHash, now);
      return { task: recordFromRow(row).task, replayed: false, dispatched: false };
    })();
  }

  markMessageDispatched(messageId: string, context: ServerCallContext): void {
    const result = this.getDb().prepare(
      "UPDATE a2a_messages SET dispatched_at = COALESCE(dispatched_at, ?) WHERE owner_id = ? AND message_id = ?",
    ).run(new Date().toISOString(), ownerId(context), messageId);
    if (result.changes !== 1) throw new Error(`Cannot confirm unknown A2A message ${messageId}`);
  }

  getContextRoot(contextId: string, context: ServerCallContext): string | undefined {
    const row = this.getDb().prepare(
      "SELECT root_session_id FROM a2a_contexts WHERE context_id = ? AND owner_id = ?",
    ).get(contextId, ownerId(context)) as { root_session_id: string | null } | undefined;
    return row?.root_session_id ?? undefined;
  }

  /** Link a task and atomically claim/read the canonical root for its context. */
  linkSession(taskId: string, context: ServerCallContext, sessionId: string): string {
    const owner = ownerId(context);
    const db = this.getDb();
    return db.transaction((): string => {
      const row = this.row(taskId, owner);
      if (!row) throw new Error(`A2A task ${taskId} is not owned by this caller`);
      const now = new Date().toISOString();
      const updated = db.prepare(
        `UPDATE a2a_tasks SET session_id = ?, updated_at = ?
          WHERE task_id = ? AND owner_id = ? AND (session_id IS NULL OR session_id = ?)`,
      ).run(sessionId, now, taskId, owner, sessionId);
      if (updated.changes !== 1) throw new Error(`A2A task ${taskId} is already linked to another session`);
      db.prepare(
        `UPDATE a2a_contexts SET root_session_id = COALESCE(root_session_id, ?), updated_at = ?
          WHERE context_id = ? AND owner_id = ?`,
      ).run(sessionId, now, row.context_id, owner);
      const contextRow = db.prepare(
        "SELECT root_session_id FROM a2a_contexts WHERE context_id = ? AND owner_id = ?",
      ).get(row.context_id, owner) as { root_session_id: string | null } | undefined;
      if (!contextRow?.root_session_id) throw new Error(`A2A context ${row.context_id} has no root session`);
      return contextRow.root_session_id;
    })();
  }

  markCanceled(taskId: string, context: ServerCallContext, canceledAt = new Date().toISOString()): void {
    const owner = ownerId(context);
    this.getDb().prepare(
      "UPDATE a2a_tasks SET canceled_at = ?, updated_at = ? WHERE task_id = ? AND owner_id = ?",
    ).run(canceledAt, canceledAt, taskId, owner);
  }

  async save(task: Task, context: ServerCallContext): Promise<void> {
    const owner = ownerId(context);
    const now = new Date().toISOString();
    const result = this.getDb().prepare(
      `UPDATE a2a_tasks SET task_json = ?, context_id = ?, updated_at = ?
        WHERE task_id = ? AND owner_id = ?`,
    ).run(serializeTask(task), task.contextId, now, task.id, owner);
    if (result.changes !== 1) throw new Error(`Cannot save unknown A2A task ${task.id}`);
  }

  async load(taskId: string, context: ServerCallContext): Promise<Task | undefined> {
    const record = await this.getRecord(taskId, context);
    if (!record) return undefined;
    return structuredClone(this.projector ? await this.projector(record) : record.task);
  }

  async list(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
    const owner = ownerId(context);
    const db = this.getDb();
    const conditions = ["owner_id = ?"];
    const values: unknown[] = [owner];
    if (params.contextId) {
      conditions.push("context_id = ?");
      values.push(params.contextId);
    }
    const where = conditions.join(" AND ");
    const size = Math.min(100, Math.max(1, params.pageSize ?? 50));
    const offset = parsePageToken(params.pageToken);
    // Projected status and its timestamp come from the live backing session tree,
    // so a2a_tasks.updated_at is not a semantics-preserving SQL substitute.
    const requiresProjectedFiltering = Boolean(params.status) || Boolean(params.statusTimestampAfter);
    const totalSize = requiresProjectedFiltering
      ? undefined
      : (db.prepare(`SELECT COUNT(*) AS count FROM a2a_tasks WHERE ${where}`).get(...values) as { count: number }).count;
    const rows = db.prepare(
      `SELECT task_id, context_id, owner_id, initial_message_id, input_hash,
              session_id, task_json, canceled_at, created_at, updated_at
         FROM a2a_tasks WHERE ${where} ORDER BY updated_at DESC, task_id DESC
         ${requiresProjectedFiltering ? "" : "LIMIT ? OFFSET ?"}`,
    ).all(...values, ...(requiresProjectedFiltering ? [] : [size, offset])) as A2ATaskRow[];
    const projected = await Promise.all(rows.map(async (row) => {
      const record = recordFromRow(row);
      return this.projector ? this.projector(record) : record.task;
    }));
    const filtered = projected.filter((task) => {
      if (params.contextId && task.contextId !== params.contextId) return false;
      if (params.status && task.status?.state !== params.status) return false;
      if (params.statusTimestampAfter) {
        const timestamp = task.status?.timestamp;
        if (!timestamp || timestamp < params.statusTimestampAfter) return false;
      }
      return true;
    });
    const filteredTotal = totalSize ?? filtered.length;
    const page = requiresProjectedFiltering ? filtered.slice(offset, offset + size) : filtered;
    const tasks = page.map((task) => ({
      ...limitHistory(task, params.historyLength),
      artifacts: params.includeArtifacts === true ? task.artifacts : [],
    }));
    const nextOffset = offset + tasks.length;
    return {
      tasks,
      nextPageToken: nextOffset < filteredTotal ? pageToken(nextOffset) : "",
      pageSize: size,
      totalSize: filteredTotal,
    };
  }
}
