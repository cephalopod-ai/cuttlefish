import type { JsonObject, JsonValue } from "../shared/types.js";
import type { LiveRunMode } from "./live-run.js";

export const ORCHESTRATION_LEASE_META_KEY = "orchestrationLease";

export interface OrchestrationLeaseMeta {
  leaseId: string;
  taskId: string;
  coordinatorId: string;
  workerId: string;
  role: string;
  mode: LiveRunMode;
}

export function toLeaseTransportMeta(meta: OrchestrationLeaseMeta): JsonObject {
  return {
    [ORCHESTRATION_LEASE_META_KEY]: {
      leaseId: meta.leaseId,
      taskId: meta.taskId,
      coordinatorId: meta.coordinatorId,
      workerId: meta.workerId,
      role: meta.role,
      mode: meta.mode,
    },
  };
}

export function parseLeaseTransportMeta(value: unknown): OrchestrationLeaseMeta | null {
  const record = asRecord(value);
  const raw = record ? asRecord(record[ORCHESTRATION_LEASE_META_KEY]) : null;
  if (!raw) return null;
  const mode = raw.mode;
  if (
    mode !== "single_worker"
    && mode !== "single_worker_with_review"
    && mode !== "dual_lane"
    && mode !== "architecture"
    && mode !== "local_heavy"
  ) return null;
  const leaseId = stringValue(raw.leaseId);
  const taskId = stringValue(raw.taskId);
  const coordinatorId = stringValue(raw.coordinatorId);
  const workerId = stringValue(raw.workerId);
  const role = stringValue(raw.role);
  if (!leaseId || !taskId || !coordinatorId || !workerId || !role) return null;
  return { leaseId, taskId, coordinatorId, workerId, role, mode };
}

function asRecord(value: unknown): Record<string, JsonValue> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
