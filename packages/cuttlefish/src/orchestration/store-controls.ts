import Database from "better-sqlite3";
import { parseDbJson } from "./store-utils.js";

export type HoldState = "active" | "expired" | "cancelled";
export type ArtifactKind = "prompt" | "output" | "diff" | "patch_apply";
export type PatchApplyState = "applied" | "failed";

export interface TaskPauseRecord {
  taskId: string;
  coordinatorId: string;
  pausedAt: string;
  pauseReason: string | null;
  managerName: string | null;
}

export interface HoldRecord {
  holdId: string;
  managerName: string;
  state: HoldState;
  roles: string[];
  workerIds: string[];
  taskId: string | null;
  coordinatorId: string | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface ArtifactRecord {
  artifactId: string;
  taskId: string;
  coordinatorId: string;
  kind: ArtifactKind;
  lane: string | null;
  path: string;
  bytes: number;
  createdAt: string;
  note: string | null;
}

export interface PatchApplyAttemptRecord {
  attemptId: string;
  taskId: string;
  winnerLane: string;
  state: PatchApplyState;
  baseCwd: string;
  patchPath: string | null;
  error: string | null;
  createdAt: string;
}

interface TaskPauseRow {
  task_id: string;
  coordinator_id: string;
  paused_at: string;
  pause_reason: string | null;
  manager_name: string | null;
}

interface HoldRow {
  hold_id: string;
  manager_name: string;
  state: HoldState;
  roles_json: string;
  worker_ids_json: string;
  task_id: string | null;
  coordinator_id: string | null;
  reason: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

interface ArtifactRow {
  artifact_id: string;
  task_id: string;
  coordinator_id: string | null;
  kind: ArtifactKind;
  lane: string | null;
  path: string;
  bytes: number;
  created_at: string;
  note: string | null;
}

interface PatchApplyAttemptRow {
  attempt_id: string;
  task_id: string;
  winner_lane: string;
  state: PatchApplyState;
  base_cwd: string;
  patch_path: string | null;
  error: string | null;
  created_at: string;
}

export function setTaskPauseInDb(db: Database.Database, record: TaskPauseRecord): void {
  db.prepare(`
    INSERT INTO task_pauses (task_id, coordinator_id, paused_at, pause_reason, manager_name)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(task_id, coordinator_id) DO UPDATE SET
      paused_at = excluded.paused_at,
      pause_reason = excluded.pause_reason,
      manager_name = excluded.manager_name
  `).run(record.taskId, record.coordinatorId, record.pausedAt, record.pauseReason, record.managerName);
}

export function deleteTaskPauseFromDb(db: Database.Database, taskId: string, coordinatorId: string): boolean {
  return db.prepare("DELETE FROM task_pauses WHERE task_id = ? AND coordinator_id = ?").run(taskId, coordinatorId).changes > 0;
}

export function getTaskPauseFromDb(
  db: Database.Database,
  taskId: string,
  coordinatorId: string,
): TaskPauseRecord | undefined {
  const row = db.prepare(`
    SELECT * FROM task_pauses WHERE task_id = ? AND coordinator_id = ?
  `).get(taskId, coordinatorId) as TaskPauseRow | undefined;
  return row ? rowToTaskPause(row) : undefined;
}

export function listTaskPausesFromDb(db: Database.Database): TaskPauseRecord[] {
  const rows = db.prepare(`
    SELECT * FROM task_pauses ORDER BY paused_at, task_id, coordinator_id
  `).all() as TaskPauseRow[];
  return rows.map(rowToTaskPause);
}

export function upsertHoldInDb(db: Database.Database, record: HoldRecord): void {
  db.prepare(`
    INSERT INTO orchestration_holds (
      hold_id, manager_name, state, roles_json, worker_ids_json, task_id,
      coordinator_id, reason, created_at, updated_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(hold_id) DO UPDATE SET
      manager_name = excluded.manager_name,
      state = excluded.state,
      roles_json = excluded.roles_json,
      worker_ids_json = excluded.worker_ids_json,
      task_id = excluded.task_id,
      coordinator_id = excluded.coordinator_id,
      reason = excluded.reason,
      updated_at = excluded.updated_at,
      expires_at = excluded.expires_at
  `).run(
    record.holdId,
    record.managerName,
    record.state,
    JSON.stringify(record.roles),
    JSON.stringify(record.workerIds),
    record.taskId,
    record.coordinatorId,
    record.reason,
    record.createdAt,
    record.updatedAt,
    record.expiresAt,
  );
}

export function getHoldFromDb(db: Database.Database, holdId: string): HoldRecord | undefined {
  const row = db.prepare("SELECT * FROM orchestration_holds WHERE hold_id = ?").get(holdId) as HoldRow | undefined;
  return row ? rowToHold(row) : undefined;
}

export function listHoldsFromDb(db: Database.Database, opts: { includeInactive?: boolean } = {}): HoldRecord[] {
  const rows = opts.includeInactive
    ? db.prepare("SELECT * FROM orchestration_holds ORDER BY updated_at DESC, hold_id").all() as HoldRow[]
    : db.prepare("SELECT * FROM orchestration_holds WHERE state = 'active' ORDER BY expires_at, hold_id").all() as HoldRow[];
  return rows.map(rowToHold);
}

export function expireHoldsInDb(db: Database.Database, nowIso: string): number {
  return db.prepare(`
    UPDATE orchestration_holds
    SET state = 'expired', updated_at = ?
    WHERE state = 'active' AND expires_at <= ?
  `).run(nowIso, nowIso).changes;
}

export function cancelHoldInDb(db: Database.Database, holdId: string, updatedAt: string): HoldRecord | undefined {
  db.prepare(`
    UPDATE orchestration_holds
    SET state = 'cancelled', updated_at = ?
    WHERE hold_id = ? AND state = 'active'
  `).run(updatedAt, holdId);
  return getHoldFromDb(db, holdId);
}

export function addArtifactRecordInDb(db: Database.Database, record: ArtifactRecord): void {
  if (!record.coordinatorId.trim()) throw new Error("artifact record coordinatorId is required");
  db.prepare(`
    INSERT INTO artifact_records (artifact_id, task_id, coordinator_id, kind, lane, path, bytes, created_at, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(artifact_id) DO UPDATE SET
      coordinator_id = excluded.coordinator_id,
      path = excluded.path,
      bytes = excluded.bytes,
      created_at = excluded.created_at,
      note = excluded.note
  `).run(
    record.artifactId,
    record.taskId,
    record.coordinatorId,
    record.kind,
    record.lane,
    record.path,
    record.bytes,
    record.createdAt,
    record.note,
  );
}

export function listArtifactRecordsFromDb(
  db: Database.Database,
  taskId: string,
  kind?: ArtifactKind,
  coordinatorId?: string,
): ArtifactRecord[] {
  const rows = coordinatorId && kind
    ? db.prepare(`
      SELECT * FROM artifact_records WHERE task_id = ? AND coordinator_id = ? AND kind = ?
      ORDER BY created_at, lane, artifact_id
    `).all(taskId, coordinatorId, kind) as ArtifactRow[]
    : coordinatorId
      ? db.prepare(`
      SELECT * FROM artifact_records WHERE task_id = ? AND coordinator_id = ?
      ORDER BY created_at, kind, lane, artifact_id
    `).all(taskId, coordinatorId) as ArtifactRow[]
      : kind
    ? db.prepare(`
      SELECT * FROM artifact_records WHERE task_id = ? AND kind = ?
      ORDER BY created_at, lane, artifact_id
    `).all(taskId, kind) as ArtifactRow[]
    : db.prepare(`
      SELECT * FROM artifact_records WHERE task_id = ?
      ORDER BY created_at, kind, lane, artifact_id
    `).all(taskId) as ArtifactRow[];
  return rows.map(rowToArtifact);
}

export function addPatchApplyAttemptInDb(db: Database.Database, record: PatchApplyAttemptRecord): void {
  db.prepare(`
    INSERT INTO patch_apply_attempts (
      attempt_id, task_id, winner_lane, state, base_cwd, patch_path, error, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.attemptId,
    record.taskId,
    record.winnerLane,
    record.state,
    record.baseCwd,
    record.patchPath,
    record.error,
    record.createdAt,
  );
}

export function listPatchApplyAttemptsFromDb(db: Database.Database, taskId?: string): PatchApplyAttemptRecord[] {
  const rows = taskId
    ? db.prepare(`
      SELECT * FROM patch_apply_attempts WHERE task_id = ?
      ORDER BY created_at DESC, attempt_id
    `).all(taskId) as PatchApplyAttemptRow[]
    : db.prepare(`
      SELECT * FROM patch_apply_attempts
      ORDER BY created_at DESC, attempt_id
    `).all() as PatchApplyAttemptRow[];
  return rows.map(rowToPatchApplyAttempt);
}

function rowToTaskPause(row: TaskPauseRow): TaskPauseRecord {
  return {
    taskId: row.task_id,
    coordinatorId: row.coordinator_id,
    pausedAt: row.paused_at,
    pauseReason: row.pause_reason,
    managerName: row.manager_name,
  };
}

function rowToHold(row: HoldRow): HoldRecord {
  return {
    holdId: row.hold_id,
    managerName: row.manager_name,
    state: row.state,
    roles: parseDbJson<string[]>(row.roles_json, "hold roles"),
    workerIds: parseDbJson<string[]>(row.worker_ids_json, "hold workers"),
    taskId: row.task_id,
    coordinatorId: row.coordinator_id,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

function rowToArtifact(row: ArtifactRow): ArtifactRecord {
  if (!row.coordinator_id) throw new Error(`artifact record ${row.artifact_id} is missing coordinator_id`);
  return {
    artifactId: row.artifact_id,
    taskId: row.task_id,
    coordinatorId: row.coordinator_id,
    kind: row.kind,
    lane: row.lane,
    path: row.path,
    bytes: row.bytes,
    createdAt: row.created_at,
    note: row.note,
  };
}

function rowToPatchApplyAttempt(row: PatchApplyAttemptRow): PatchApplyAttemptRecord {
  return {
    attemptId: row.attempt_id,
    taskId: row.task_id,
    winnerLane: row.winner_lane,
    state: row.state,
    baseCwd: row.base_cwd,
    patchPath: row.patch_path,
    error: row.error,
    createdAt: row.created_at,
  };
}
