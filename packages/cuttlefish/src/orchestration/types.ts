export type ProviderLane = string;
export type Capability = string;

export type CostClass = "near_zero" | "low" | "medium" | "high";
export type LeaseState = "running" | "released" | "expired";
export type QueueState = "blocked_resource";
export type AllocationState = "allocated" | "completed" | "expired" | "blocked_resource";
export type TaskPriority = "low" | "normal" | "high";
export type FamilyConstraint = "opposite_of_implementer" | "same_as_implementer";
export type WorkspacePolicy = "shared" | "read_only" | "isolated_worktree";

export const DEFAULT_LEASE_DURATION_MS = 60 * 60 * 1000;

export interface Worker {
  id: string;
  provider: ProviderLane;
  family: string;
  tier: string;
  capabilities: Capability[];
  tools: string[];
  maxConcurrentTasks: number;
  costClass: CostClass;
  workspacePolicy: WorkspacePolicy;
}

export interface RoleDefinition {
  id: string;
  requiredCapabilities: Capability[];
  requiredTools: string[];
  allowedFamilies?: string[];
  preferredTiers?: string[];
  preferredCostClasses?: CostClass[];
  familyConstraint?: FamilyConstraint;
  deterministicPreferred?: boolean;
}

export interface CoordinatorTemplate {
  id: string;
  purpose: string;
  requiredRoles: string[];
  optionalRoles: string[];
}

export interface QuotaLimit {
  maxActiveLeases: number;
}

export interface QuotaPolicy {
  providers: Record<string, QuotaLimit>;
  families: Record<string, QuotaLimit>;
}

export interface AllocationRequest {
  taskId: string;
  coordinatorId: string;
  coordinatorTemplate?: string;
  requiredRoles: string[];
  optionalRoles: string[];
  allowedWorkerIds?: string[];
  priority: TaskPriority;
  leaseDurationMs: number;
}

export interface Lease {
  leaseId: string;
  workerId: string;
  taskId: string;
  coordinatorId: string;
  role: string;
  state: LeaseState;
  startedAt: string;
  leaseExpiresAt: string;
  leaseDurationMs: number;
  heartbeatAt: string;
}

export interface LeaseValidationResult {
  ok: boolean;
  reason?: string;
}

export interface Allocation {
  allocationId: string;
  taskId: string;
  coordinatorId: string;
  state: AllocationState;
  leases: Lease[];
  optionalRolesSkipped: string[];
  createdAt: string;
  updatedAt: string;
  runId?: string;
}

export type ReviewPolicyDecision =
  | "opposite_family_selected"
  | "same_family_fallback_used"
  | "same_family_fallback_forbidden"
  | "no_qualified_reviewer";

export interface ReviewPolicyExplanation {
  role: string;
  familyConstraint: "opposite_of_implementer";
  sameFamilyReviewerFallback: boolean;
  implementerFamilies: string[];
  selectedWorkerId?: string;
  selectedWorkerFamily?: string;
  oppositeFamilyCandidateIds: string[];
  sameFamilyCandidateIds: string[];
  decision: ReviewPolicyDecision;
  detail: string;
}

export interface ReviewPolicySummary {
  explanations: ReviewPolicyExplanation[];
}

export interface QueueItem {
  taskId: string;
  coordinatorId: string;
  state: QueueState;
  missingRoles: string[];
  priority: TaskPriority;
  blockedSince: string;
  lastBlockedAt: string;
  blockedAttempts: number;
  resumeOn: Array<"worker_released" | "quota_available" | "lease_expired">;
  request: AllocationRequest;
}

export interface TelemetryEvent {
  eventId: string;
  type:
    | "allocation_created"
    | "task_blocked_resource"
    | "lease_heartbeat"
    | "lease_released"
    | "lease_expired"
    | "store_corrupt_recovered";
  taskId?: string;
  workerId?: string;
  provider?: string;
  family?: string;
  role?: string;
  timestamp: string;
  detail?: Record<string, unknown>;
}

export interface OrchestrationConfig {
  workers: Worker[];
  roles: RoleDefinition[];
  coordinatorTemplates: CoordinatorTemplate[];
  quotas: QuotaPolicy;
}

export interface SchedulerSnapshot {
  allocations: Allocation[];
  leases: Lease[];
  queue: QueueItem[];
  telemetry: TelemetryEvent[];
  nextSeq: number;
}

export type AllocationResult =
  | { ok: true; allocation: Allocation; reviewPolicy: ReviewPolicySummary }
  | { ok: false; queueItem: QueueItem; reviewPolicy: ReviewPolicySummary };

export interface SimulationStepResult {
  step: number;
  action: string;
  result: unknown;
}
