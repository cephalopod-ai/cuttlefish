import Database from "better-sqlite3";
import { DEFAULT_LEASE_DURATION_MS, type Allocation, type Lease, type QueueItem, type SchedulerSnapshot, type TelemetryEvent } from "./types.js";
import { NEXT_SEQ_META_KEY } from "./store-schema.js";
import { parseDbJson, setMeta } from "./store-utils.js";

interface LeaseRow {
  lease_id: string;
  worker_id: string;
  task_id: string;
  coordinator_id: string;
  role: string;
  state: Lease["state"];
  started_at: string;
  lease_expires_at: string;
  lease_duration_ms?: number;
  heartbeat_at: string;
}

interface AllocationRow {
  allocation_id: string;
  task_id: string;
  coordinator_id: string;
  state: Allocation["state"];
  optional_roles_skipped_json: string;
  created_at: string;
  updated_at: string;
}

interface AllocationLeaseRow {
  lease_id: string;
}

interface QueueRow {
  task_id: string;
  coordinator_id: string;
  state: QueueItem["state"];
  missing_roles_json: string;
  priority: QueueItem["priority"];
  blocked_since: string;
  last_blocked_at: string | null;
  blocked_attempts: number | null;
  resume_on_json: string;
  request_json: string;
}

interface TelemetryRow {
  event_id: string;
  type: TelemetryEvent["type"];
  task_id: string | null;
  worker_id: string | null;
  provider: string | null;
  family: string | null;
  role: string | null;
  timestamp: string;
  detail_json: string | null;
}

export function loadSnapshotFromDb(db: Database.Database, recoveryEvent?: TelemetryEvent): SchedulerSnapshot {
  const leases = loadLeases(db);
  const leaseById = new Map(leases.map((lease) => [lease.leaseId, lease]));
  const allocations = loadAllocations(db, leaseById);
  const queue = loadQueue(db);
  const telemetry = loadTelemetry(db);
  if (recoveryEvent && !telemetry.some((event) => event.eventId === recoveryEvent.eventId)) {
    telemetry.unshift(recoveryEvent);
  }
  const nextSeq = loadNextSeq(db) ?? inferNextSeq({ allocations, leases, queue, telemetry, nextSeq: 1 });
  return { allocations, leases, queue, telemetry, nextSeq };
}

export function replaceSnapshotInDb(db: Database.Database, snapshot: SchedulerSnapshot): void {
  const replace = db.transaction(() => {
    db.prepare("DELETE FROM allocation_leases").run();
    db.prepare("DELETE FROM allocations").run();
    db.prepare("DELETE FROM leases").run();
    db.prepare("DELETE FROM queue_items").run();
    db.prepare("DELETE FROM telemetry_events").run();

    const insertLease = db.prepare(`
      INSERT INTO leases (
        lease_id, worker_id, task_id, coordinator_id, role, state, started_at, lease_expires_at, lease_duration_ms, heartbeat_at
      ) VALUES (
        @leaseId, @workerId, @taskId, @coordinatorId, @role, @state, @startedAt, @leaseExpiresAt, @leaseDurationMs, @heartbeatAt
      )
    `);
    for (const lease of snapshot.leases) insertLease.run(lease);

    const insertAllocation = db.prepare(`
      INSERT INTO allocations (
        allocation_id, task_id, coordinator_id, state, optional_roles_skipped_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertAllocationLease = db.prepare(`
      INSERT INTO allocation_leases (allocation_id, lease_id) VALUES (?, ?)
    `);
    for (const allocation of snapshot.allocations) {
      insertAllocation.run(
        allocation.allocationId,
        allocation.taskId,
        allocation.coordinatorId,
        allocation.state,
        JSON.stringify(allocation.optionalRolesSkipped),
        allocation.createdAt,
        allocation.updatedAt,
      );
      for (const lease of allocation.leases) {
        insertAllocationLease.run(allocation.allocationId, lease.leaseId);
      }
    }

    const insertQueueItem = db.prepare(`
      INSERT INTO queue_items (
        task_id, coordinator_id, state, missing_roles_json, priority, blocked_since, last_blocked_at, blocked_attempts, resume_on_json, request_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of snapshot.queue) {
      insertQueueItem.run(
        item.taskId,
        item.coordinatorId,
        item.state,
        JSON.stringify(item.missingRoles),
        item.priority,
        item.blockedSince,
        item.lastBlockedAt,
        item.blockedAttempts,
        JSON.stringify(item.resumeOn),
        JSON.stringify(item.request),
      );
    }

    const insertTelemetry = db.prepare(`
      INSERT INTO telemetry_events (
        event_id, type, task_id, worker_id, provider, family, role, timestamp, detail_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const event of snapshot.telemetry) {
      insertTelemetry.run(
        event.eventId,
        event.type,
        event.taskId ?? null,
        event.workerId ?? null,
        event.provider ?? null,
        event.family ?? null,
        event.role ?? null,
        event.timestamp,
        event.detail ? JSON.stringify(event.detail) : null,
      );
    }

    setMeta(db, NEXT_SEQ_META_KEY, String(snapshot.nextSeq));
  });
  replace();
}

export function applySnapshotDeltaToDb(db: Database.Database, before: SchedulerSnapshot, after: SchedulerSnapshot): void {
  const beforeLeases = new Map(before.leases.map((lease) => [lease.leaseId, lease]));
  const afterLeases = new Map(after.leases.map((lease) => [lease.leaseId, lease]));
  const beforeAllocations = new Map(before.allocations.map((allocation) => [allocation.allocationId, allocation]));
  const afterAllocations = new Map(after.allocations.map((allocation) => [allocation.allocationId, allocation]));
  const beforeQueue = new Map(before.queue.map((item) => [queueKey(item), item]));
  const afterQueue = new Map(after.queue.map((item) => [queueKey(item), item]));
  const beforeTelemetry = new Map(before.telemetry.map((event) => [event.eventId, event]));
  const afterTelemetry = new Map(after.telemetry.map((event) => [event.eventId, event]));

  const apply = db.transaction(() => {
    const deleteAllocationLease = db.prepare("DELETE FROM allocation_leases WHERE allocation_id = ?");
    const deleteAllocation = db.prepare("DELETE FROM allocations WHERE allocation_id = ?");
    for (const allocationId of beforeAllocations.keys()) {
      if (afterAllocations.has(allocationId)) continue;
      deleteAllocationLease.run(allocationId);
      deleteAllocation.run(allocationId);
    }

    const deleteLease = db.prepare("DELETE FROM leases WHERE lease_id = ?");
    for (const leaseId of beforeLeases.keys()) {
      if (!afterLeases.has(leaseId)) deleteLease.run(leaseId);
    }

    const deleteQueueItem = db.prepare("DELETE FROM queue_items WHERE task_id = ? AND coordinator_id = ?");
    for (const key of beforeQueue.keys()) {
      if (afterQueue.has(key)) continue;
      const [taskId, coordinatorId] = splitQueueKey(key);
      deleteQueueItem.run(taskId, coordinatorId);
    }

    const deleteTelemetry = db.prepare("DELETE FROM telemetry_events WHERE event_id = ?");
    for (const eventId of beforeTelemetry.keys()) {
      if (!afterTelemetry.has(eventId)) deleteTelemetry.run(eventId);
    }

    upsertLeases(db, beforeLeases, afterLeases);
    upsertAllocations(db, beforeAllocations, afterAllocations, deleteAllocationLease);
    upsertQueueItems(db, beforeQueue, afterQueue);
    upsertTelemetryEvents(db, beforeTelemetry, afterTelemetry);
    setMeta(db, NEXT_SEQ_META_KEY, String(after.nextSeq));
  });
  apply();
}

function upsertLeases(
  db: Database.Database,
  beforeLeases: Map<string, Lease>,
  afterLeases: Map<string, Lease>,
): void {
  const upsertLease = db.prepare(`
    INSERT INTO leases (
      lease_id, worker_id, task_id, coordinator_id, role, state, started_at, lease_expires_at, lease_duration_ms, heartbeat_at
    ) VALUES (
      @leaseId, @workerId, @taskId, @coordinatorId, @role, @state, @startedAt, @leaseExpiresAt, @leaseDurationMs, @heartbeatAt
    )
    ON CONFLICT(lease_id) DO UPDATE SET
      worker_id = excluded.worker_id,
      task_id = excluded.task_id,
      coordinator_id = excluded.coordinator_id,
      role = excluded.role,
      state = excluded.state,
      started_at = excluded.started_at,
      lease_expires_at = excluded.lease_expires_at,
      lease_duration_ms = excluded.lease_duration_ms,
      heartbeat_at = excluded.heartbeat_at
  `);
  for (const [leaseId, lease] of afterLeases) {
    if (sameJson(lease, beforeLeases.get(leaseId))) continue;
    upsertLease.run(lease);
  }
}

function upsertAllocations(
  db: Database.Database,
  beforeAllocations: Map<string, Allocation>,
  afterAllocations: Map<string, Allocation>,
  deleteAllocationLease: Database.Statement,
): void {
  const upsertAllocation = db.prepare(`
    INSERT INTO allocations (
      allocation_id, task_id, coordinator_id, state, optional_roles_skipped_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(allocation_id) DO UPDATE SET
      task_id = excluded.task_id,
      coordinator_id = excluded.coordinator_id,
      state = excluded.state,
      optional_roles_skipped_json = excluded.optional_roles_skipped_json,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at
  `);
  const insertAllocationLease = db.prepare(`
    INSERT INTO allocation_leases (allocation_id, lease_id) VALUES (?, ?)
    ON CONFLICT(allocation_id, lease_id) DO NOTHING
  `);
  for (const [allocationId, allocation] of afterAllocations) {
    if (sameAllocationRecord(allocation, beforeAllocations.get(allocationId))) continue;
    upsertAllocation.run(
      allocation.allocationId,
      allocation.taskId,
      allocation.coordinatorId,
      allocation.state,
      JSON.stringify(allocation.optionalRolesSkipped),
      allocation.createdAt,
      allocation.updatedAt,
    );
    deleteAllocationLease.run(allocation.allocationId);
    for (const lease of allocation.leases) {
      insertAllocationLease.run(allocation.allocationId, lease.leaseId);
    }
  }
}

function upsertQueueItems(
  db: Database.Database,
  beforeQueue: Map<string, QueueItem>,
  afterQueue: Map<string, QueueItem>,
): void {
  const upsertQueueItem = db.prepare(`
    INSERT INTO queue_items (
      task_id, coordinator_id, state, missing_roles_json, priority, blocked_since, last_blocked_at, blocked_attempts, resume_on_json, request_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id, coordinator_id) DO UPDATE SET
      state = excluded.state,
      missing_roles_json = excluded.missing_roles_json,
      priority = excluded.priority,
      blocked_since = excluded.blocked_since,
      last_blocked_at = excluded.last_blocked_at,
      blocked_attempts = excluded.blocked_attempts,
      resume_on_json = excluded.resume_on_json,
      request_json = excluded.request_json
  `);
  for (const [key, item] of afterQueue) {
    if (sameJson(item, beforeQueue.get(key))) continue;
    upsertQueueItem.run(
      item.taskId,
      item.coordinatorId,
      item.state,
      JSON.stringify(item.missingRoles),
      item.priority,
      item.blockedSince,
      item.lastBlockedAt,
      item.blockedAttempts,
      JSON.stringify(item.resumeOn),
      JSON.stringify(item.request),
    );
  }
}

function upsertTelemetryEvents(
  db: Database.Database,
  beforeTelemetry: Map<string, TelemetryEvent>,
  afterTelemetry: Map<string, TelemetryEvent>,
): void {
  const upsertTelemetry = db.prepare(`
    INSERT INTO telemetry_events (
      event_id, type, task_id, worker_id, provider, family, role, timestamp, detail_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO UPDATE SET
      type = excluded.type,
      task_id = excluded.task_id,
      worker_id = excluded.worker_id,
      provider = excluded.provider,
      family = excluded.family,
      role = excluded.role,
      timestamp = excluded.timestamp,
      detail_json = excluded.detail_json
  `);
  for (const [eventId, event] of afterTelemetry) {
    if (sameJson(event, beforeTelemetry.get(eventId))) continue;
    upsertTelemetry.run(
      event.eventId,
      event.type,
      event.taskId ?? null,
      event.workerId ?? null,
      event.provider ?? null,
      event.family ?? null,
      event.role ?? null,
      event.timestamp,
      event.detail ? JSON.stringify(event.detail) : null,
    );
  }
}

function loadLeases(db: Database.Database): Lease[] {
  const rows = db.prepare(`
    SELECT * FROM leases ORDER BY started_at, lease_id
  `).all() as LeaseRow[];
  return rows.map(rowToLease);
}

function loadAllocations(db: Database.Database, leaseById: Map<string, Lease>): Allocation[] {
  const rows = db.prepare(`
    SELECT * FROM allocations ORDER BY created_at, allocation_id
  `).all() as AllocationRow[];
  const leaseIdsForAllocation = db.prepare(`
    SELECT lease_id FROM allocation_leases WHERE allocation_id = ? ORDER BY lease_id
  `);
  return rows.map((row) => {
    const leaseIds = leaseIdsForAllocation.all(row.allocation_id) as AllocationLeaseRow[];
    return {
      allocationId: row.allocation_id,
      taskId: row.task_id,
      coordinatorId: row.coordinator_id,
      state: row.state,
      optionalRolesSkipped: parseDbJson<string[]>(row.optional_roles_skipped_json, "allocation optional roles"),
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? row.created_at,
      leases: leaseIds.map((leaseRow) => {
        const lease = leaseById.get(leaseRow.lease_id);
        if (!lease) throw new Error(`orchestration DB references missing lease ${leaseRow.lease_id}`);
        return { ...lease };
      }),
    };
  });
}

function loadQueue(db: Database.Database): QueueItem[] {
  const rows = db.prepare(`
    SELECT * FROM queue_items ORDER BY blocked_since, task_id, coordinator_id
  `).all() as QueueRow[];
  return rows.map((row) => ({
    taskId: row.task_id,
    coordinatorId: row.coordinator_id,
    state: row.state,
    missingRoles: parseDbJson<string[]>(row.missing_roles_json, "queue missing roles"),
    priority: row.priority,
    blockedSince: row.blocked_since,
    lastBlockedAt: row.last_blocked_at ?? row.blocked_since,
    blockedAttempts: row.blocked_attempts ?? 1,
    resumeOn: parseDbJson<QueueItem["resumeOn"]>(row.resume_on_json, "queue resume triggers"),
    request: parseDbJson<QueueItem["request"]>(row.request_json, "queue allocation request"),
  }));
}

function loadTelemetry(db: Database.Database): TelemetryEvent[] {
  const rows = db.prepare(`
    SELECT * FROM telemetry_events ORDER BY timestamp, event_id
  `).all() as TelemetryRow[];
  return rows.map((row) => ({
    eventId: row.event_id,
    type: row.type,
    taskId: row.task_id ?? undefined,
    workerId: row.worker_id ?? undefined,
    provider: row.provider ?? undefined,
    family: row.family ?? undefined,
    role: row.role ?? undefined,
    timestamp: row.timestamp,
    detail: row.detail_json ? parseDbJson<Record<string, unknown>>(row.detail_json, "telemetry detail") : undefined,
  }));
}

function loadNextSeq(db: Database.Database): number | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(NEXT_SEQ_META_KEY) as { value: string } | undefined;
  if (!row) return null;
  const value = Number.parseInt(row.value, 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function rowToLease(row: LeaseRow): Lease {
  return {
    leaseId: row.lease_id,
    workerId: row.worker_id,
    taskId: row.task_id,
    coordinatorId: row.coordinator_id,
    role: row.role,
    state: row.state,
    startedAt: row.started_at,
    leaseExpiresAt: row.lease_expires_at,
    leaseDurationMs: row.lease_duration_ms ?? DEFAULT_LEASE_DURATION_MS,
    heartbeatAt: row.heartbeat_at,
  };
}

function queueKey(item: Pick<QueueItem, "taskId" | "coordinatorId">): string {
  return `${encodeURIComponent(item.taskId)}\t${encodeURIComponent(item.coordinatorId)}`;
}

function splitQueueKey(key: string): [string, string] {
  const [taskId, coordinatorId] = key.split("\t");
  return [decodeURIComponent(taskId), decodeURIComponent(coordinatorId)];
}

function sameJson(left: unknown, right: unknown): boolean {
  if (right === undefined) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameAllocationRecord(left: Allocation, right: Allocation | undefined): boolean {
  if (!right) return false;
  return JSON.stringify(allocationRecord(left)) === JSON.stringify(allocationRecord(right));
}

function allocationRecord(allocation: Allocation): unknown {
  return {
    allocationId: allocation.allocationId,
    taskId: allocation.taskId,
    coordinatorId: allocation.coordinatorId,
    state: allocation.state,
    optionalRolesSkipped: allocation.optionalRolesSkipped,
    createdAt: allocation.createdAt,
    updatedAt: allocation.updatedAt,
    leaseIds: allocation.leases.map((lease) => lease.leaseId),
  };
}

function inferNextSeq(snapshot: SchedulerSnapshot): number {
  let max = 0;
  for (const id of [
    ...snapshot.allocations.map((allocation) => allocation.allocationId),
    ...snapshot.leases.map((lease) => lease.leaseId),
    ...snapshot.telemetry.map((event) => event.eventId),
  ]) {
    const match = id.match(/_(\d+)$/);
    if (!match) continue;
    max = Math.max(max, Number.parseInt(match[1], 10));
  }
  return Math.max(1, max + 1);
}
