import { buildCoordinatorTaskBrief, type CoordinatorMode } from "./coordinator.js";
import type { LiveRunContinuationRecord } from "./live-run.js";
import type { AllocationRequest, OrchestrationConfig } from "./types.js";

export function buildContinuationRequest(record: LiveRunContinuationRecord, config: OrchestrationConfig): AllocationRequest {
  if (record.mode === "dual_lane") {
    return {
      taskId: record.task.taskId,
      coordinatorId: record.task.coordinatorId,
      requiredRoles: [record.task.openaiRole ?? "openaiImplementer", record.task.anthropicRole ?? "anthropicImplementer"],
      optionalRoles: [],
      allowedWorkerIds: record.task.allowedWorkerIds,
      priority: record.task.priority,
      leaseDurationMs: record.task.leaseDurationMs,
    };
  }
  const brief = buildCoordinatorTaskBrief({
    taskId: record.task.taskId,
    coordinatorId: record.task.coordinatorId,
    coordinatorTemplate: record.task.coordinatorTemplate ?? record.task.template,
    requiredRoles: record.task.requiredRoles,
    optionalRoles: record.task.optionalRoles,
    allowedWorkerIds: record.task.allowedWorkerIds,
    priority: record.task.priority,
    leaseDurationMs: record.task.leaseDurationMs,
    mode: record.mode as CoordinatorMode,
  }, config);
  return brief.request;
}

