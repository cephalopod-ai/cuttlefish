import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

let tmpHome: string;
const testHome = withTempCuttlefishHome("cuttlefish-orch-run-cli-");
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpHome = testHome.home();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  writeGatewayFiles(tmpHome);
});

afterEach(() => {
  logSpy.mockRestore();
  vi.unstubAllGlobals();
});

describe("cuttlefish run orchestration client", () => {
  it("prints read-only recovery notices from the local recovery directory", async () => {
    const recoveryDir = path.join(tmpHome, "orchestration-recovery");
    fs.mkdirSync(recoveryDir, { recursive: true });
    fs.writeFileSync(path.join(recoveryDir, "2026-06-24T12-00-00-000Z-orchestration-db-recovery.json"), JSON.stringify({
      recoveredAt: "2026-06-24T12:00:00.000Z",
      originalDbPath: path.join(tmpHome, "orchestration.db"),
      corruptDbPath: path.join(tmpHome, "orchestration.db.corrupt-20260624T120000000Z"),
      message: "orchestration state could not be trusted",
      operatorGuidance: "Inspect the quarantined database manually.",
    }));

    const { runRecoveryNotices } = await import("../orchestration.js");
    await runRecoveryNotices({ json: true });

    expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({
      recoveryNotices: [{
        recoveredAt: "2026-06-24T12:00:00.000Z",
        corruptDbPath: path.join(tmpHome, "orchestration.db.corrupt-20260624T120000000Z"),
      }],
    });
  });

  it("posts a task file to the running gateway with token auth", async () => {
    const taskFile = path.join(tmpHome, "task.yaml");
    fs.writeFileSync(taskFile, [
      "taskId: cli-task",
      "coordinatorId: cli-coord",
      "requiredRoles: [seniorImplementer]",
      "prompt: Implement a small task",
    ].join("\n"));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      state: "completed",
      mode: "single_worker",
      allocation: { allocationId: "alloc-cli" },
      sessions: [{ role: "seniorImplementer", workerId: "mock", sessionId: "s1", status: "idle", error: null }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const { runOrchestrationRun } = await import("../orchestration.js");
    await runOrchestrationRun({ mode: "single_worker", task: taskFile, json: true });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8899/api/orchestration/run");
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-token" });
    expect(JSON.parse(String(init.body))).toMatchObject({
      mode: "single_worker",
      task: { taskId: "cli-task", coordinatorId: "cli-coord", prompt: "Implement a small task" },
    });
    expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({ state: "completed" });
  }, 15_000);

  it("prints review-policy explanations for text run output", async () => {
    const taskFile = path.join(tmpHome, "task.yaml");
    fs.writeFileSync(taskFile, [
      "taskId: cli-task",
      "coordinatorId: cli-coord",
      "requiredRoles: [seniorImplementer, independentReviewer]",
      "prompt: Implement and review a small task",
    ].join("\n"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      state: "blocked_resource",
      mode: "single_worker_with_review",
      queueItem: {
        taskId: "cli-task",
        missingRoles: ["independentReviewer"],
        resumeOn: ["worker_released", "quota_available", "lease_expired"],
      },
      reviewPolicy: {
        explanations: [{
          role: "independentReviewer",
          decision: "same_family_fallback_forbidden",
          detail: "independentReviewer blocked because only same-family reviewers were qualified and fallback is disabled.",
        }],
      },
    }), { status: 409, headers: { "Content-Type": "application/json" } })));

    const { runOrchestrationRun } = await import("../orchestration.js");
    await runOrchestrationRun({ mode: "single_worker_with_review", task: taskFile });

    expect(String(logSpy.mock.calls[0][0])).toContain("Review policy: same_family_fallback_forbidden");
  });

  it("prints failed orchestration state instead of completed when the gateway reports a role failure", async () => {
    const taskFile = path.join(tmpHome, "task.yaml");
    fs.writeFileSync(taskFile, [
      "taskId: cli-task-failed",
      "coordinatorId: cli-coord-failed",
      "requiredRoles: [seniorImplementer, independentReviewer]",
      "prompt: Implement and review with a failure",
    ].join("\n"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      state: "failed",
      mode: "single_worker_with_review",
      allocation: { allocationId: "alloc-failed" },
      sessions: [
        { role: "seniorImplementer", workerId: "mock", sessionId: "s1", status: "idle", error: null },
        { role: "independentReviewer", workerId: "mock", sessionId: "s2", status: "error", error: "forced engine failure" },
      ],
      errorSummary: "independentReviewer failed: forced engine failure",
      reviewPolicy: { explanations: [] },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    const { runOrchestrationRun } = await import("../orchestration.js");
    await runOrchestrationRun({ mode: "single_worker_with_review", task: taskFile });

    expect(String(logSpy.mock.calls[0][0])).toContain("Orchestration run failed");
    expect(String(logSpy.mock.calls[0][0])).toContain("independentReviewer failed");
  });

  it("prints dual-lane selection-required output", async () => {
    const taskFile = path.join(tmpHome, "task.yaml");
    fs.writeFileSync(taskFile, [
      "taskId: cli-dual",
      "coordinatorId: cli-dual-coord",
      "mode: dual_lane",
      "prompt: Implement the same task in both lanes",
    ].join("\n"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      state: "selection_required",
      mode: "dual_lane",
      taskId: "cli-dual",
      coordinatorId: "cli-dual-coord",
      lanes: [
        { id: "openai", workerId: "mockOpenAI", state: "completed", worktreePath: "/tmp/openai" },
        { id: "anthropic", workerId: "mockAnthropic", state: "completed", worktreePath: "/tmp/anthropic" },
      ],
      comparisonReport: { majorDifferences: ["OpenAI-only files: openai.txt"] },
      selection: { required: true, default: "human", options: ["openai", "anthropic"] },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    const { runOrchestrationRun } = await import("../orchestration.js");
    await runOrchestrationRun({ mode: "dual_lane", task: taskFile });

    expect(String(logSpy.mock.calls[0][0])).toContain("Dual-lane run requires selection");
    expect(String(logSpy.mock.calls[0][0])).toContain("Difference: OpenAI-only files");
  });

  it("lists durable continuations through the gateway", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      continuations: [{
        taskId: "cli-task-queued",
        coordinatorId: "cli-coord-queued",
        mode: "single_worker",
        state: "failed",
        retryCount: 2,
        updatedAt: "2026-06-24T12:00:00.000Z",
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    const { runContinuationsList } = await import("../orchestration.js");
    await runContinuationsList({});

    expect(String(logSpy.mock.calls[0][0])).toContain("cli-task-queued");
    expect(String(logSpy.mock.calls[0][0])).toContain("failed");
  });

  it("retries a failed continuation through the gateway", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      state: "dispatching",
      continuation: {
        taskId: "cli-task-retry",
        coordinatorId: "cli-coord-retry",
      },
      allocation: {
        allocationId: "alloc-retry",
      },
      reviewPolicy: { explanations: [] },
    }), { status: 202, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const { runContinuationRetry } = await import("../orchestration.js");
    await runContinuationRetry({ taskId: "cli-task-retry", coordinatorId: "cli-coord-retry" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      taskId: "cli-task-retry",
      coordinatorId: "cli-coord-retry",
    });
    expect(String(logSpy.mock.calls[0][0])).toContain("Continuation cli-task-retry/cli-coord-retry dispatched");
  });

  it("selects a dual-lane winner through the gateway", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      state: "selected",
      taskId: "cli-dual-select",
      selectedLane: "openai",
      archivedLane: "anthropic",
      winnerWorktreePath: "/tmp/winner",
      archive: { diffPath: "/tmp/archive/anthropic.patch.diff" },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const { runDualLaneSelect } = await import("../orchestration.js");
    await runDualLaneSelect({ taskId: "cli-dual-select", coordinatorId: "cli-dual-coord", winner: "openai" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8899/api/orchestration/dual-lane/select");
    expect(JSON.parse(String(init.body))).toEqual({ taskId: "cli-dual-select", coordinatorId: "cli-dual-coord", winnerLane: "openai" });
    expect(String(logSpy.mock.calls[0][0])).toContain("selected openai");
  });
});

function writeGatewayFiles(dir: string): void {
  fs.writeFileSync(path.join(dir, "config.yaml"), [
    "gateway:",
    "  port: 8888",
    "  host: 127.0.0.1",
    "engines:",
    "  default: claude",
    "  claude:",
    "    bin: claude",
    "    model: opus",
    "  codex:",
    "    bin: codex",
    "    model: gpt",
    "connectors: {}",
    "logging:",
    "  file: false",
    "  stdout: false",
    "  level: error",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "gateway.json"), JSON.stringify({
    port: 8899,
    pid: 123,
    secret: "test-secret",
    token: "test-token",
  }));
}
