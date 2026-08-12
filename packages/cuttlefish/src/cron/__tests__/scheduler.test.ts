import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronJob, CronRunEntry } from "../../shared/types.js";

const appendRunLog = vi.hoisted(() => vi.fn());
const runCronJob = vi.hoisted(() => vi.fn());
const getSessionBySessionKey = vi.hoisted(() => vi.fn());

vi.mock("../jobs.js", () => ({
  appendRunLog,
  loadJobs: vi.fn(() => []),
  saveJobs: vi.fn(),
}));

vi.mock("../runner.js", () => ({
  runCronJob,
}));

vi.mock("../../sessions/registry.js", () => ({
  getSessionBySessionKey,
}));

vi.mock("../../shared/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

function makeJob(): CronJob {
  return {
    id: "job-1",
    name: "Overlap",
    enabled: true,
    schedule: "0 * * * *",
    prompt: "do it",
  };
}

function makeRun(status: CronRunEntry["status"]): CronRunEntry {
  return {
    runId: "run-1",
    timestamp: "2026-06-22T00:00:00.000Z",
    status,
    trigger: "manual",
    resultPreview: null,
  };
}

describe("startCronJobRun", () => {
  beforeEach(() => {
    vi.resetModules();
    appendRunLog.mockReset();
    runCronJob.mockReset();
    getSessionBySessionKey.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("requests interruption but retains overlap protection until a timed-out run settles", async () => {
    vi.useFakeTimers();
    const { startCronJobRun, isCronJobRunning } = await import("../scheduler.js");

    // The run never settles on its own — this simulates a hung PTY / stuck route.
    runCronJob.mockReturnValueOnce(new Promise<CronRunEntry>(() => {}));

    const kill = vi.fn();
    const engine = { name: "claude", run: vi.fn(), kill, isAlive: vi.fn(), killAll: vi.fn(), killIdle: vi.fn() };
    const sessionManager = { getEngine: vi.fn(() => engine) };
    getSessionBySessionKey.mockReturnValue({ id: "session-1", engine: "claude", status: "running" });

    const config = { cron: { maxRunMs: 1000 } } as any;
    const result = startCronJobRun(makeJob(), sessionManager as any, config, new Map(), "scheduled");
    expect(result.started).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);

    expect(getSessionBySessionKey).toHaveBeenCalledWith(expect.stringContaining("cron:job-1:"));
    expect(sessionManager.getEngine).toHaveBeenCalledWith("claude");
    expect(kill).toHaveBeenCalledWith("session-1", expect.stringContaining("exceeded maxRunMs"));
    expect(appendRunLog).toHaveBeenCalledWith("job-1", expect.objectContaining({
      status: "timed_out",
      error: expect.stringContaining("overlap guard retained"),
    }));

    expect(isCronJobRunning("job-1")).toBe(true);
    const overlapping = startCronJobRun(makeJob(), sessionManager as any, config, new Map(), "scheduled");
    expect(overlapping.started).toBe(false);
    if (!overlapping.started) expect(overlapping.run.status).toBe("skipped_overlap");
  });

  it("suppresses a late terminal write and releases overlap only after settlement", async () => {
    vi.useFakeTimers();
    const { startCronJobRun, isCronJobRunning } = await import("../scheduler.js");
    let resolveRun!: (entry: CronRunEntry) => void;
    const pending = new Promise<CronRunEntry>((resolve) => { resolveRun = resolve; });
    runCronJob.mockReturnValueOnce(pending);
    const config = { cron: { maxRunMs: 1000 } } as any;
    const result = startCronJobRun(makeJob(), {} as any, config, new Map(), "scheduled");
    expect(result.started).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    expect(isCronJobRunning("job-1")).toBe(true);
    const runnerOpts = runCronJob.mock.calls[0][4];
    expect(runnerOpts.shouldRecordTerminal()).toBe(false);

    resolveRun(makeRun("success"));
    if (result.started) await result.promise;
    expect(isCronJobRunning("job-1")).toBe(false);
  });

  it("logs skipped_overlap instead of starting a second run while one is in flight", async () => {
    const { startCronJobRun } = await import("../scheduler.js");
    let resolveRun!: (entry: CronRunEntry) => void;
    const inFlight = new Promise<CronRunEntry>((resolve) => {
      resolveRun = resolve;
    });
    runCronJob.mockReturnValueOnce(inFlight);

    const first = startCronJobRun(makeJob(), {} as any, {} as any, new Map(), "manual");
    const second = startCronJobRun(makeJob(), {} as any, {} as any, new Map(), "manual");

    expect(first.started).toBe(true);
    expect(second.started).toBe(false);
    expect(runCronJob).toHaveBeenCalledTimes(1);
    expect(appendRunLog).toHaveBeenCalledWith("job-1", expect.objectContaining({
      status: "skipped_overlap",
      trigger: "manual",
    }));

    resolveRun(makeRun("success"));
    if (first.started) await first.promise;
  });

  it("triggerCronJob preserves the skipped overlap result instead of collapsing it to job existence", async () => {
    const loadJobs = vi.fn(() => [makeJob()]);
    vi.doMock("../jobs.js", () => ({
      appendRunLog,
      loadJobs,
      saveJobs: vi.fn(),
    }));

    const { triggerCronJob } = await import("../scheduler.js");
    let resolveRun!: (entry: CronRunEntry) => void;
    const inFlight = new Promise<CronRunEntry>((resolve) => {
      resolveRun = resolve;
    });
    runCronJob.mockReturnValueOnce(inFlight);

    const first = triggerCronJob("job-1");
    const second = await triggerCronJob("job-1");

    expect(second).toMatchObject({
      found: true,
      started: false,
      job: expect.objectContaining({ id: "job-1", name: "Overlap" }),
      run: expect.objectContaining({
        status: "skipped_overlap",
        trigger: "manual",
      }),
    });

    resolveRun(makeRun("success"));
    await first;
  });
});
