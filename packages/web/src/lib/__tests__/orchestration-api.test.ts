import { afterEach, describe, expect, it, vi } from "vitest"
import {
  applyDualLaneWinner,
  cancelHold,
  createHold,
  extendHold,
  loadOrchestrationDashboard,
  pauseQueuedTask,
  pauseOrchestrationQueue,
  requeueRecoveredTask,
  resumeQueuedTask,
  retryContinuation,
  resumeOrchestrationQueue,
  selectDualLaneWinner,
  stopOrchestrationLease,
} from "../orchestration-api"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("orchestration-api", () => {
  it("loads every dashboard endpoint and normalizes payload containers", async () => {
    const fetchMock = vi.fn(async (url: string) => ok(payloadFor(url)))
    vi.stubGlobal("fetch", fetchMock)

    const data = await loadOrchestrationDashboard()

    expect(fetchMock).toHaveBeenCalledTimes(10)
    expect(data.status.enabled).toBe(true)
    expect(data.workers).toEqual([{ id: "worker-1" }])
    expect(data.leases).toEqual([{ leaseId: "lease-1" }])
    expect(data.queue).toEqual([])
    expect(data.holds).toEqual([])
    expect(data.dualLane).toEqual([{ taskId: "dual-1" }])
  })

  it("surfaces API errors from JSON bodies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: "orchestration is disabled" }),
    })))

    await expect(loadOrchestrationDashboard()).rejects.toThrow("orchestration is disabled")
  })

  it("posts every orchestration mutator with the expected path and body", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => ok({ ok: true }))
    vi.stubGlobal("fetch", fetchMock)

    const cases: Array<{
      label: string
      run: () => Promise<unknown>
      path: string
      body: unknown
    }> = [
      {
        label: "retryContinuation",
        run: () => retryContinuation("task-1", "coord-1"),
        path: "/api/orchestration/continuations/retry",
        body: { taskId: "task-1", coordinatorId: "coord-1" },
      },
      {
        label: "selectDualLaneWinner",
        run: () => selectDualLaneWinner("task-2", "coord-2", "openai"),
        path: "/api/orchestration/dual-lane/select",
        body: { taskId: "task-2", coordinatorId: "coord-2", winnerLane: "openai" },
      },
      {
        label: "applyDualLaneWinner",
        run: () => applyDualLaneWinner("task-3", "coord-3", "anthropic"),
        path: "/api/orchestration/dual-lane/apply",
        body: { taskId: "task-3", coordinatorId: "coord-3", winnerLane: "anthropic" },
      },
      {
        label: "pauseQueuedTask",
        run: () => pauseQueuedTask("task-4", "coord-4"),
        path: "/api/orchestration/queue/pause-task",
        body: { taskId: "task-4", coordinatorId: "coord-4", reason: "Paused from dashboard" },
      },
      {
        label: "resumeQueuedTask",
        run: () => resumeQueuedTask("task-5", "coord-5"),
        path: "/api/orchestration/queue/resume-task",
        body: { taskId: "task-5", coordinatorId: "coord-5" },
      },
      {
        label: "createHold",
        run: () => createHold({ managerName: "boss", roles: ["lead"], workerIds: ["w1"], ttlMs: 60000, reason: "coverage" }),
        path: "/api/orchestration/holds",
        body: { managerName: "boss", roles: ["lead"], workerIds: ["w1"], ttlMs: 60000, reason: "coverage" },
      },
      {
        label: "extendHold",
        run: () => extendHold("hold/1", "boss", 120000),
        path: "/api/orchestration/holds/hold%2F1/extend",
        body: { managerName: "boss", ttlMs: 120000 },
      },
      {
        label: "cancelHold",
        run: () => cancelHold("hold/2", "boss"),
        path: "/api/orchestration/holds/hold%2F2/cancel",
        body: { managerName: "boss" },
      },
      {
        label: "requeueRecoveredTask",
        run: () => requeueRecoveredTask("/tmp/manifest.json", "task-6", "coord-6", "boss"),
        path: "/api/orchestration/recovery/requeue",
        body: { manifestPath: "/tmp/manifest.json", taskId: "task-6", coordinatorId: "coord-6", managerName: "boss" },
      },
      {
        label: "pauseOrchestrationQueue",
        run: () => pauseOrchestrationQueue("operator hold"),
        path: "/api/orchestration/queue/pause",
        body: { reason: "operator hold" },
      },
      {
        label: "resumeOrchestrationQueue",
        run: () => resumeOrchestrationQueue(),
        path: "/api/orchestration/queue/resume",
        body: {},
      },
      {
        label: "stopOrchestrationLease",
        run: () => stopOrchestrationLease("lease-1", "operator stop"),
        path: "/api/orchestration/leases/stop",
        body: { leaseId: "lease-1", reason: "operator stop" },
      },
    ]

    for (const testCase of cases) {
      await testCase.run()
    }

    expect(fetchMock).toHaveBeenCalledTimes(cases.length)
    for (const [index, testCase] of cases.entries()) {
      expect(fetchMock.mock.calls[index]?.[0]).toContain(testCase.path)
      expect(fetchMock.mock.calls[index]?.[1]).toEqual(expect.objectContaining({
        method: "POST",
        body: JSON.stringify(testCase.body),
      }))
    }
  })
})

function ok(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response
}

function payloadFor(url: string) {
  if (url.endsWith("/status")) {
    return {
      enabled: true,
      runtimeBound: true,
      degraded: false,
      queuePaused: false,
      pausedAt: null,
      pauseReason: null,
      disabledReason: null,
      degradedReason: null,
      counts: { workers: 1, runningLeases: 0, queueItems: 0, allocations: 0, continuations: 0, activeWork: false },
    }
  }
  if (url.endsWith("/workers")) return { workers: [{ id: "worker-1" }] }
  if (url.endsWith("/leases")) return { leases: [{ leaseId: "lease-1" }] }
  if (url.endsWith("/queue")) return { queue: [] }
  if (url.endsWith("/holds")) return { holds: [] }
  if (url.endsWith("/allocations")) return { allocations: [] }
  if (url.endsWith("/continuations")) return { continuations: [] }
  if (url.endsWith("/telemetry/summary")) {
    return {
      maxBytes: 100,
      maxRecords: 10,
      summary: {
        totals: { count: 0, dispositions: {}, totalCost: 0, avgCost: null, totalLatencyMs: 0, avgLatencyMs: null, totalTokens: 0, avgTokens: null, filesChanged: 0, testsAdded: 0, testsPassed: 0, reviewBlockers: 0, humanEdits: 0, regressions: 0, score: 0 },
        byProvider: {},
        byFamily: {},
        byRole: {},
        byWorker: {},
        skippedLines: 0,
      },
    }
  }
  if (url.endsWith("/worktrees")) return { worktrees: [] }
  if (url.endsWith("/dual-lane")) return { manifests: [{ taskId: "dual-1" }] }
  throw new Error(`unexpected url ${url}`)
}
