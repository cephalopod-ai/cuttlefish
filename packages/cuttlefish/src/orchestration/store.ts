import Database from "better-sqlite3";
import { ORCH_DB } from "../shared/paths.js";
import type { LiveRunContinuationRecord, LiveRunContinuationState } from "./live-run.js";
import {
  addArtifactRecordInDb,
  addPatchApplyAttemptInDb,
  cancelHoldInDb,
  deleteTaskPauseFromDb,
  expireHoldsInDb,
  getHoldFromDb,
  getTaskPauseFromDb,
  listArtifactRecordsFromDb,
  listHoldsFromDb,
  listPatchApplyAttemptsFromDb,
  listTaskPausesFromDb,
  setTaskPauseInDb,
  upsertHoldInDb,
  type ArtifactKind,
  type ArtifactRecord,
  type HoldRecord,
  type PatchApplyAttemptRecord,
  type TaskPauseRecord,
} from "./store-controls.js";
import {
  claimQueuedLiveContinuationInDb,
  deleteLiveContinuationFromDb,
  getLiveContinuationFromDb,
  getQueuePauseStateFromDb,
  listLiveContinuationsFromDb,
  markLiveContinuationStateInDb,
  setQueuePauseStateInDb,
  stampContinuationRunIdInDb,
  type QueuePauseState,
  upsertLiveContinuationInDb,
} from "./store-continuations.js";
import { openStoreDatabase, type StoreOpenOptions } from "./store-schema.js";
import { applySnapshotDeltaToDb, loadSnapshotFromDb, replaceSnapshotInDb } from "./store-snapshot.js";
import type { SchedulerSnapshot, TelemetryEvent } from "./types.js";

export type { QueuePauseState, StoreOpenOptions };
export type {
  ArtifactKind,
  ArtifactRecord,
  HoldRecord,
  PatchApplyAttemptRecord,
  TaskPauseRecord,
};

export class OrchestrationStore {
  private constructor(
    private readonly db: Database.Database,
    private readonly recoveryEvent?: TelemetryEvent,
  ) {}

  static open(dbPath = ORCH_DB, opts: StoreOpenOptions = {}): OrchestrationStore {
    const opened = openStoreDatabase(dbPath, opts);
    return new OrchestrationStore(opened.db, opened.recoveryEvent);
  }

  close(): void {
    this.db.close();
  }

  loadSnapshot(): SchedulerSnapshot {
    return loadSnapshotFromDb(this.db, this.recoveryEvent);
  }

  replaceSnapshot(snapshot: SchedulerSnapshot): void {
    replaceSnapshotInDb(this.db, snapshot);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  applySnapshotDelta(before: SchedulerSnapshot, after: SchedulerSnapshot): void {
    applySnapshotDeltaToDb(this.db, before, after);
  }

  listLiveContinuations(states?: LiveRunContinuationState[]): LiveRunContinuationRecord[] {
    return listLiveContinuationsFromDb(this.db, states);
  }

  getLiveContinuation(taskId: string, coordinatorId: string): LiveRunContinuationRecord | undefined {
    return getLiveContinuationFromDb(this.db, taskId, coordinatorId);
  }

  upsertLiveContinuation(record: LiveRunContinuationRecord): void {
    upsertLiveContinuationInDb(this.db, record);
  }

  deleteLiveContinuation(taskId: string, coordinatorId: string): void {
    deleteLiveContinuationFromDb(this.db, taskId, coordinatorId);
  }

  stampContinuationRunId(taskId: string, coordinatorId: string, runId: string): void {
    stampContinuationRunIdInDb(this.db, taskId, coordinatorId, runId);
  }

  claimQueuedLiveContinuation(
    taskId: string,
    coordinatorId: string,
    opts: { updatedAt?: string; allocationId?: string } = {},
  ): LiveRunContinuationRecord | undefined {
    return claimQueuedLiveContinuationInDb(this.db, taskId, coordinatorId, opts);
  }

  markLiveContinuationState(
    taskId: string,
    coordinatorId: string,
    state: LiveRunContinuationState,
    opts: {
      updatedAt?: string;
      allocationId?: string | null;
      lastError?: string | null;
    } = {},
  ): LiveRunContinuationRecord | undefined {
    return markLiveContinuationStateInDb(this.db, taskId, coordinatorId, state, opts);
  }

  getQueuePauseState(): QueuePauseState {
    return getQueuePauseStateFromDb(this.db);
  }

  setQueuePauseState(state: QueuePauseState): void {
    setQueuePauseStateInDb(this.db, state);
  }

  setTaskPause(record: TaskPauseRecord): void {
    setTaskPauseInDb(this.db, record);
  }

  deleteTaskPause(taskId: string, coordinatorId: string): boolean {
    return deleteTaskPauseFromDb(this.db, taskId, coordinatorId);
  }

  getTaskPause(taskId: string, coordinatorId: string): TaskPauseRecord | undefined {
    return getTaskPauseFromDb(this.db, taskId, coordinatorId);
  }

  listTaskPauses(): TaskPauseRecord[] {
    return listTaskPausesFromDb(this.db);
  }

  upsertHold(record: HoldRecord): void {
    upsertHoldInDb(this.db, record);
  }

  getHold(holdId: string): HoldRecord | undefined {
    return getHoldFromDb(this.db, holdId);
  }

  listHolds(opts: { includeInactive?: boolean } = {}): HoldRecord[] {
    return listHoldsFromDb(this.db, opts);
  }

  expireHolds(nowIso = new Date().toISOString()): number {
    return expireHoldsInDb(this.db, nowIso);
  }

  cancelHold(holdId: string, updatedAt = new Date().toISOString()): HoldRecord | undefined {
    return cancelHoldInDb(this.db, holdId, updatedAt);
  }

  addArtifactRecord(record: ArtifactRecord): void {
    addArtifactRecordInDb(this.db, record);
  }

  listArtifactRecords(taskId: string, kind?: ArtifactKind, coordinatorId?: string): ArtifactRecord[] {
    return listArtifactRecordsFromDb(this.db, taskId, kind, coordinatorId);
  }

  addPatchApplyAttempt(record: PatchApplyAttemptRecord): void {
    addPatchApplyAttemptInDb(this.db, record);
  }

  listPatchApplyAttempts(taskId?: string): PatchApplyAttemptRecord[] {
    return listPatchApplyAttemptsFromDb(this.db, taskId);
  }
}
