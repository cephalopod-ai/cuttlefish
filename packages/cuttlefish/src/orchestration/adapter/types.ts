import type {
  EngineFailureReason,
  EngineResult,
  EngineRunOpts,
  ModelInfo,
  StreamDelta,
} from "../../shared/types.js";
import type { Lease, LeaseValidationResult, RoleDefinition, Worker } from "../types.js";

export type ProviderAdapterErrorCode =
  | "lease_invalid"
  | "adapter_not_found"
  | "engine_unavailable"
  | "invalid_request"
  | "unsupported_operation"
  | "manual_required"
  | "engine_failed"
  | "cancel_not_supported";

export interface ProviderAdapterError {
  code: ProviderAdapterErrorCode;
  message: string;
  reason?: string;
  engineFailureReason?: EngineFailureReason;
  detail?: Record<string, unknown>;
}

export type ProviderAdapterResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ProviderAdapterError };

export interface LeaseValidationRequest {
  workerId: string;
  leaseId: string;
  taskId: string;
  coordinatorId: string;
}

export type LeaseValidator = (request: LeaseValidationRequest) => LeaseValidationResult | Promise<LeaseValidationResult>;

export type ProviderLease = Pick<Lease, "leaseId" | "workerId" | "taskId" | "coordinatorId" | "role">;

export interface ProviderCanExecuteRequest {
  worker: Worker;
  role?: RoleDefinition;
  requiredCapabilities?: string[];
  requiredTools?: string[];
}

export interface ProviderCapabilityCheck {
  canExecute: boolean;
  reasons: string[];
}

export interface ProviderEstimateRequest {
  worker: Worker;
  model?: ModelInfo;
  prompt?: string;
}

export interface ProviderCostEstimate {
  costClass: Worker["costClass"];
  estimatedUsd?: number;
  note?: string;
}

export interface ProviderContextEstimate {
  contextWindow?: number;
  promptChars?: number;
  note?: string;
}

export interface ProviderStartTaskRequest {
  worker: Worker;
  lease: ProviderLease;
  run: EngineRunOpts;
  validateLease: LeaseValidator;
}

export type ProviderRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "manual_required";

export interface ProviderRun {
  runId: string;
  adapterId: string;
  workerId: string;
  leaseId: string;
  taskId: string;
  status: ProviderRunStatus;
  startedAt: string;
  completedAt?: string;
  engineSessionId?: string;
  result?: EngineResult;
  error?: ProviderAdapterError;
}

export interface ProviderArtifact {
  id: string;
  kind: "text" | "file" | "diff" | "metadata";
  label: string;
  path?: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

export interface ProviderAdapter {
  id: string;
  canExecute(request: ProviderCanExecuteRequest): ProviderAdapterResult<ProviderCapabilityCheck>;
  estimateCost(request: ProviderEstimateRequest): ProviderAdapterResult<ProviderCostEstimate>;
  estimateContext(request: ProviderEstimateRequest): ProviderAdapterResult<ProviderContextEstimate>;
  startTask(request: ProviderStartTaskRequest): Promise<ProviderAdapterResult<ProviderRun>>;
  streamOutput(runId: string, onStream: (delta: StreamDelta) => void): Promise<ProviderAdapterResult<void>>;
  cancel(runId: string, reason?: string): Promise<ProviderAdapterResult<void>>;
  getStatus(runId: string): Promise<ProviderAdapterResult<ProviderRunStatus>>;
  collectArtifacts(runId: string): Promise<ProviderAdapterResult<ProviderArtifact[]>>;
}

export function providerOk<T>(value: T): ProviderAdapterResult<T> {
  return { ok: true, value };
}

export function providerFail<T>(error: ProviderAdapterError): ProviderAdapterResult<T> {
  return { ok: false, error };
}

export function unsupported<T>(message: string, detail?: Record<string, unknown>): ProviderAdapterResult<T> {
  return providerFail({ code: "unsupported_operation", message, detail });
}

export function adapterNotFound(provider: string): ProviderAdapterResult<ProviderAdapter> {
  return providerFail({
    code: "adapter_not_found",
    message: `provider adapter not found: ${provider}`,
    reason: provider,
  });
}

export async function validateStartLease(request: ProviderStartTaskRequest): Promise<ProviderAdapterResult<void>> {
  const result = await request.validateLease({
    workerId: request.worker.id,
    leaseId: request.lease.leaseId,
    taskId: request.lease.taskId,
    coordinatorId: request.lease.coordinatorId,
  });
  if (!result.ok) {
    return providerFail({
      code: "lease_invalid",
      message: `invalid lease ${request.lease.leaseId}: ${result.reason ?? "unknown"}`,
      reason: result.reason,
      detail: {
        workerId: request.worker.id,
        taskId: request.lease.taskId,
        coordinatorId: request.lease.coordinatorId,
      },
    });
  }
  return providerOk(undefined);
}

export function basicCapabilityCheck(request: ProviderCanExecuteRequest): ProviderCapabilityCheck {
  const requiredCapabilities = request.requiredCapabilities ?? request.role?.requiredCapabilities ?? [];
  const requiredTools = request.requiredTools ?? request.role?.requiredTools ?? [];
  const reasons: string[] = [];
  for (const capability of requiredCapabilities) {
    if (!request.worker.capabilities.includes(capability)) reasons.push(`missing_capability:${capability}`);
  }
  for (const tool of requiredTools) {
    if (!request.worker.tools.includes(tool)) reasons.push(`missing_tool:${tool}`);
  }
  return { canExecute: reasons.length === 0, reasons };
}

export function runIdFor(adapterId: string, leaseId: string): string {
  const safeAdapter = adapterId.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "adapter";
  const safeLease = leaseId.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "lease";
  return `run_${safeAdapter}_${safeLease}`;
}
