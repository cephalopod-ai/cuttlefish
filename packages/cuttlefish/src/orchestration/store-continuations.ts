import Database from "better-sqlite3";
import { logger } from "../shared/logger.js";
import type { LiveRunContinuationRecord, LiveRunContinuationState } from "./live-run.js";
import { QUEUE_PAUSE_META_KEY } from "./store-schema.js";
import { parseDbJson, setMeta } from "./store-utils.js";

export const DEFAULT_MAX_LIVE_CONTINUATION_RETRIES = 3;

export interface QueuePauseState {
  queuePaused: boolean;
  pausedAt: string | null;
  pauseReason: string | null;
}

interface LiveRunContinuationRow {
  task_id: string;
  coordinator_id: string;
  mode: LiveRunContinuationRecord["mode"];
  state: LiveRunContinuationState;
  task_json: string;
  enqueued_at: string;
  updated_at: string;
  retry_count: number;
  last_dispatched_at: string | null;
  allocation_id: string | null;
  last_error: string | null;
}

export function listLiveContinuationsFromDb(
  db: Database.Database,
  states?: LiveRunContinuationState[],
): LiveRunContinuationRecord[] {
  if (!states || states.length === 0) {
    const rows = db.prepare(`
      SELECT * FROM live_run_continuations
      ORDER BY updated_at, task_id, coordinator_id
    `).all() as LiveRunContinuationRow[];
    return rows.map(rowToLiveRunContinuation);
  }
  const placeholders = states.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT * FROM live_run_continuations
    WHERE state IN (${placeholders})
    ORDER BY updated_at, task_id, coordinator_id
  `).all(...states) as LiveRunContinuationRow[];
  return rows.map(rowToLiveRunContinuation);
}

export function getLiveContinuationFromDb(
  db: Database.Database,
  taskId: string,
  coordinatorId: string,
): LiveRunContinuationRecord | undefined {
  const row = db.prepare(`
    SELECT * FROM live_run_continuations
    WHERE task_id = ? AND coordinator_id = ?
  `).get(taskId, coordinatorId) as LiveRunContinuationRow | undefined;
  return row ? rowToLiveRunContinuation(row) : undefined;
}

export function upsertLiveContinuationInDb(db: Database.Database, record: LiveRunContinuationRecord): void {
  const existing = getLiveContinuationFromDb(db, record.taskId, record.coordinatorId);
  if (existing && (existing.state === "queued" || existing.state === "dispatching")) {
    throw new Error(`live continuation ${record.taskId}/${record.coordinatorId} is active (${existing.state}) and cannot be overwritten`);
  }
  db.prepare(`
    INSERT INTO live_run_continuations (
      task_id, coordinator_id, mode, state, task_json, enqueued_at, updated_at,
      retry_count, last_dispatched_at, allocation_id, last_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id, coordinator_id) DO UPDATE SET
      mode = excluded.mode,
      state = excluded.state,
      task_json = excluded.task_json,
      enqueued_at = excluded.enqueued_at,
      updated_at = excluded.updated_at,
      retry_count = excluded.retry_count,
      last_dispatched_at = excluded.last_dispatched_at,
      allocation_id = excluded.allocation_id,
      last_error = excluded.last_error
  `).run(
    record.taskId,
    record.coordinatorId,
    record.mode,
    record.state,
    JSON.stringify(record.task),
    record.enqueuedAt,
    record.updatedAt,
    record.retryCount,
    record.lastDispatchedAt ?? null,
    record.allocationId ?? null,
    record.lastError ?? null,
  );
}

export function deleteLiveContinuationFromDb(db: Database.Database, taskId: string, coordinatorId: string): void {
  db.prepare(`
    DELETE FROM live_run_continuations
    WHERE task_id = ? AND coordinator_id = ?
  `).run(taskId, coordinatorId);
}

export function claimQueuedLiveContinuationInDb(
  db: Database.Database,
  taskId: string,
  coordinatorId: string,
  opts: { updatedAt?: string; allocationId?: string; maxRetryCount?: number } = {},
): LiveRunContinuationRecord | undefined {
  const updatedAt = opts.updatedAt ?? new Date().toISOString();
  const maxRetryCount = opts.maxRetryCount ?? DEFAULT_MAX_LIVE_CONTINUATION_RETRIES;
  const claim = db.transaction(() => {
    const current = db.prepare(`
      SELECT * FROM live_run_continuations
      WHERE task_id = ? AND coordinator_id = ?
    `).get(taskId, coordinatorId) as LiveRunContinuationRow | undefined;
    if (!current || current.state !== "queued") return undefined;
    if (current.retry_count >= maxRetryCount) {
      db.prepare(`
        UPDATE live_run_continuations
        SET state = ?, updated_at = ?, allocation_id = NULL, last_error = ?
        WHERE task_id = ? AND coordinator_id = ? AND state = ?
      `).run(
        "failed",
        updatedAt,
        `retry limit reached after ${current.retry_count} attempt(s)`,
        taskId,
        coordinatorId,
        "queued",
      );
      return undefined;
    }
    db.prepare(`
      UPDATE live_run_continuations
      SET state = ?, updated_at = ?, retry_count = ?, last_dispatched_at = ?, allocation_id = ?, last_error = NULL
      WHERE task_id = ? AND coordinator_id = ? AND state = ?
    `).run(
      "dispatching",
      updatedAt,
      current.retry_count + 1,
      updatedAt,
      opts.allocationId ?? null,
      taskId,
      coordinatorId,
      "queued",
    );
    const claimed = db.prepare(`
      SELECT * FROM live_run_continuations
      WHERE task_id = ? AND coordinator_id = ?
    `).get(taskId, coordinatorId) as LiveRunContinuationRow | undefined;
    return claimed ? rowToLiveRunContinuation(claimed) : undefined;
  });
  return claim();
}

export function markLiveContinuationStateInDb(
  db: Database.Database,
  taskId: string,
  coordinatorId: string,
  state: LiveRunContinuationState,
  opts: {
    updatedAt?: string;
    allocationId?: string | null;
    lastError?: string | null;
  } = {},
): LiveRunContinuationRecord | undefined {
  const updatedAt = opts.updatedAt ?? new Date().toISOString();
  const update = db.transaction(() => {
    db.prepare(`
      UPDATE live_run_continuations
      SET state = ?, updated_at = ?, allocation_id = ?, last_error = ?
      WHERE task_id = ? AND coordinator_id = ?
    `).run(
      state,
      updatedAt,
      opts.allocationId ?? null,
      opts.lastError ?? null,
      taskId,
      coordinatorId,
    );
    const row = db.prepare(`
      SELECT * FROM live_run_continuations
      WHERE task_id = ? AND coordinator_id = ?
    `).get(taskId, coordinatorId) as LiveRunContinuationRow | undefined;
    return row ? rowToLiveRunContinuation(row) : undefined;
  });
  return update();
}

export function getQueuePauseStateFromDb(db: Database.Database): QueuePauseState {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(QUEUE_PAUSE_META_KEY) as { value: string } | undefined;
  if (!row) return { queuePaused: false, pausedAt: null, pauseReason: null };
  try {
    const parsed = JSON.parse(row.value) as Partial<QueuePauseState>;
    return {
      queuePaused: parsed.queuePaused === true,
      pausedAt: typeof parsed.pausedAt === "string" ? parsed.pausedAt : null,
      pauseReason: typeof parsed.pauseReason === "string" ? parsed.pauseReason : null,
    };
  } catch {
    logger.warn("orchestration DB has corrupt queue pause metadata; treating queue as unpaused");
    return { queuePaused: false, pausedAt: null, pauseReason: null };
  }
}

export function setQueuePauseStateInDb(db: Database.Database, state: QueuePauseState): void {
  if (!state.queuePaused) {
    db.prepare("DELETE FROM meta WHERE key = ?").run(QUEUE_PAUSE_META_KEY);
    return;
  }
  setMeta(db, QUEUE_PAUSE_META_KEY, JSON.stringify(state));
}

function rowToLiveRunContinuation(row: LiveRunContinuationRow): LiveRunContinuationRecord {
  return {
    taskId: row.task_id,
    coordinatorId: row.coordinator_id,
    mode: row.mode,
    state: row.state,
    task: parseDbJson<LiveRunContinuationRecord["task"]>(row.task_json, "live run task"),
    enqueuedAt: row.enqueued_at,
    updatedAt: row.updated_at,
    retryCount: row.retry_count,
    lastDispatchedAt: row.last_dispatched_at ?? undefined,
    allocationId: row.allocation_id ?? undefined,
    lastError: row.last_error ?? undefined,
  };
}
