const BASE =
  typeof window !== "undefined"
    ? window.location.origin
    : "http://127.0.0.1:8888"

export interface OrchestrationStatus {
  enabled: boolean
  runtimeBound: boolean
  degraded: boolean
  queuePaused: boolean
  pausedAt: string | null
  pauseReason: string | null
  disabledReason: string | null
  degradedReason: string | null
  recoveryNotices?: Array<{
    recoveredAt: string
    manifestPath: string
    corruptDbPath: string
    message: string
  }>
  counts: {
    workers: number
    runningLeases: number
    queueItems: number
    allocations: number
    continuations: number
    activeWork: boolean
  }
}

export interface WorkerSummary {
  id: string
  provider: string
  family: string
  tier: string
  capabilities: string[]
  tools: string[]
  maxConcurrentTasks: number
  costClass: string
  workspacePolicy: string
}

export interface LeaseSummary {
  leaseId: string
  taskId: string
  coordinatorId: string
  workerId: string
  role: string
  state: string
  leaseExpiresAt?: string
}

export interface QueueSummary {
  taskId: string
  coordinatorId: string
  missingRoles?: string[]
  priority?: string
  state?: string
  reason?: string
}

export interface TaskPauseSummary {
  taskId: string
  coordinatorId: string
  pausedAt: string
  pauseReason: string | null
  managerName: string | null
}

export interface HoldSummary {
  holdId: string
  managerName: string
  state: string
  roles: string[]
  workerIds: string[]
  taskId: string | null
  coordinatorId: string | null
  reason: string | null
  createdAt: string
  updatedAt: string
  expiresAt: string
}

export interface AllocationSummary {
  allocationId: string
  taskId: string
  coordinatorId: string
  state: string
  createdAt?: string
}

export interface ContinuationSummary {
  taskId: string
  coordinatorId: string
  mode: string
  state: string
  retryCount: number
  updatedAt: string
  allocationId?: string | null
  lastError?: string | null
}

export interface TelemetryBucket {
  count: number
  dispositions: Record<string, number>
  totalCost: number
  avgCost: number | null
  totalLatencyMs: number
  avgLatencyMs: number | null
  totalTokens: number
  avgTokens: number | null
  filesChanged: number
  testsAdded: number
  testsPassed: number
  reviewBlockers: number
  humanEdits: number
  regressions: number
  score: number
}

export interface TelemetrySummaryResponse {
  maxBytes: number
  maxRecords: number
  summary: {
    totals: TelemetryBucket
    byProvider: Record<string, TelemetryBucket>
    byFamily: Record<string, TelemetryBucket>
    byRole: Record<string, TelemetryBucket>
    byWorker: Record<string, TelemetryBucket>
    skippedLines: number
  }
}

export interface WorktreeSummary {
  taskId: string
  lane: string
  path: string
  baseCwd: string
  gitRoot: string
  branch: string
  createdAt: string
}

export interface DualLaneSummary {
  taskId: string
  coordinatorId: string
  state: "selection_required" | "selected" | "failed" | string
  createdAt: string
  updatedAt: string
  baseCwd: string
  selectedLane: "openai" | "anthropic" | null
  archivedLane: "openai" | "anthropic" | null
  lanes: Array<{
    id: "openai" | "anthropic"
    role: string
    family: string
    workerId: string
    leaseId: string
    sessionId: string
    sessionStatus: string
    sessionError: string | null
    worktreePath: string
    archive: { diffPath: string; metadataPath: string; archivedAt: string } | null
  }>
  comparisonReport: {
    taskId: string
    generatedAt: string
    laneSummaries: Array<{
      laneId: "openai" | "anthropic"
      changedFiles: string[]
      addedLines: number
      removedLines: number
      status: string
      error: string | null
    }>
    commonFiles: string[]
    uniqueFiles: Record<"openai" | "anthropic", string[]>
    majorDifferences: string[]
  }
}

export interface OrchestrationDashboardData {
  status: OrchestrationStatus
  workers: WorkerSummary[]
  leases: LeaseSummary[]
  queue: QueueSummary[]
  taskPauses: TaskPauseSummary[]
  holds: HoldSummary[]
  allocations: AllocationSummary[]
  continuations: ContinuationSummary[]
  telemetry: TelemetrySummaryResponse
  worktrees: WorktreeSummary[]
  dualLane: DualLaneSummary[]
}

async function extractErrorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json()
    if (body.error) return String(body.error)
    if (body.message) return String(body.message)
  } catch {
    // Response was not JSON.
  }
  return `API error: ${res.status}`
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { credentials: "include" })
  if (!res.ok) throw new Error(await extractErrorMessage(res))
  return res.json()
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await extractErrorMessage(res))
  return res.json()
}

export async function loadOrchestrationDashboard(): Promise<OrchestrationDashboardData> {
  const [
    status,
    workers,
    leases,
    queue,
    holds,
    allocations,
    continuations,
    telemetry,
    worktrees,
    dualLane,
  ] = await Promise.all([
    get<OrchestrationStatus>("/api/orchestration/status"),
    get<{ workers: WorkerSummary[] }>("/api/orchestration/workers"),
    get<{ leases: LeaseSummary[] }>("/api/orchestration/leases"),
    get<{ queue: QueueSummary[]; pauses?: TaskPauseSummary[] }>("/api/orchestration/queue"),
    get<{ holds: HoldSummary[] }>("/api/orchestration/holds"),
    get<{ allocations: AllocationSummary[] }>("/api/orchestration/allocations"),
    get<{ continuations: ContinuationSummary[] }>("/api/orchestration/continuations"),
    get<TelemetrySummaryResponse>("/api/orchestration/telemetry/summary"),
    get<{ worktrees: WorktreeSummary[] }>("/api/orchestration/worktrees"),
    get<{ manifests: DualLaneSummary[] }>("/api/orchestration/dual-lane"),
  ])

  return {
    status,
    workers: workers.workers,
    leases: leases.leases,
    queue: queue.queue,
    taskPauses: queue.pauses ?? [],
    holds: holds.holds,
    allocations: allocations.allocations,
    continuations: continuations.continuations,
    telemetry,
    worktrees: worktrees.worktrees,
    dualLane: dualLane.manifests,
  }
}

export async function retryContinuation(taskId: string, coordinatorId: string) {
  return post("/api/orchestration/continuations/retry", { taskId, coordinatorId })
}

export async function selectDualLaneWinner(taskId: string, coordinatorId: string, winnerLane: "openai" | "anthropic") {
  return post("/api/orchestration/dual-lane/select", { taskId, coordinatorId, winnerLane })
}

export async function applyDualLaneWinner(taskId: string, coordinatorId: string, winnerLane: "openai" | "anthropic") {
  return post("/api/orchestration/dual-lane/apply", { taskId, coordinatorId, winnerLane })
}

export async function pauseQueuedTask(taskId: string, coordinatorId: string) {
  return post("/api/orchestration/queue/pause-task", { taskId, coordinatorId, reason: "Paused from dashboard" })
}

export async function resumeQueuedTask(taskId: string, coordinatorId: string) {
  return post("/api/orchestration/queue/resume-task", { taskId, coordinatorId })
}

export async function createHold(input: { managerName: string; roles: string[]; workerIds: string[]; ttlMs: number; reason?: string }) {
  return post("/api/orchestration/holds", input)
}

export async function extendHold(holdId: string, managerName: string, ttlMs: number) {
  return post(`/api/orchestration/holds/${encodeURIComponent(holdId)}/extend`, { managerName, ttlMs })
}

export async function cancelHold(holdId: string, managerName: string) {
  return post(`/api/orchestration/holds/${encodeURIComponent(holdId)}/cancel`, { managerName })
}

export async function viewArtifact(taskId: string, coordinatorId: string, kind: "diff" | "prompt" | "output") {
  return get<{ taskId: string; coordinatorId: string | null; kind: string; artifacts: Array<{ record: { lane: string | null; path: string }; content: string }> }>(
    `/api/orchestration/artifacts/${encodeURIComponent(taskId)}/${kind}?coordinatorId=${encodeURIComponent(coordinatorId)}`,
  )
}

export async function requeueRecoveredTask(manifestPath: string, taskId: string, coordinatorId: string, managerName: string) {
  return post("/api/orchestration/recovery/requeue", { manifestPath, taskId, coordinatorId, managerName })
}

export async function pauseOrchestrationQueue(reason?: string) {
  return post("/api/orchestration/queue/pause", reason ? { reason } : {})
}

export async function resumeOrchestrationQueue() {
  return post("/api/orchestration/queue/resume", {})
}

export async function stopOrchestrationLease(leaseId: string, reason?: string) {
  return post("/api/orchestration/leases/stop", reason ? { leaseId, reason } : { leaseId })
}
