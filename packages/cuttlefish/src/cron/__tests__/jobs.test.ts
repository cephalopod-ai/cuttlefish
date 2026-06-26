import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { CronJob } from "../../shared/types.js";
import { withTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import { appendRunLog, loadJobs, saveJobs } from "../jobs.js";

// Stub logger so tests don't touch the real log files
vi.mock("../../shared/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

let tmpHome: string;
const testHome = withTempCuttlefishHome("cuttlefish-cron-jobs-");

beforeEach(() => {
  tmpHome = testHome.home();
});

afterEach(() => {
  vi.clearAllMocks();
});

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "test-job",
    name: "Test Job",
    enabled: true,
    schedule: "0 * * * *",
    prompt: "do something",
    ...overrides,
  };
}

describe("loadJobs", () => {
  it("returns [] silently when jobs.json is missing", async () => {
    const { logger } = await import("../../shared/logger.js");
    expect(loadJobs()).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs an error and backs up the corrupt file on parse failure", async () => {
    const cronDir = path.join(tmpHome, "cron");
    fs.mkdirSync(cronDir, { recursive: true });
    const jobsPath = path.join(cronDir, "jobs.json");
    fs.writeFileSync(jobsPath, "{ not valid json", "utf-8");

    const { logger } = await import("../../shared/logger.js");
    expect(loadJobs()).toEqual([]);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(logger.error).mock.calls[0][0])).toContain("Failed to parse");

    // Corrupt copy is preserved next to the original
    const backups = fs.readdirSync(cronDir).filter((f) => f.startsWith("jobs.json.corrupt-"));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(cronDir, backups[0]), "utf-8")).toBe("{ not valid json");
    // Original file is left in place
    expect(fs.existsSync(jobsPath)).toBe(true);
  });
});

describe("saveJobs", () => {
  it("round-trips jobs through loadJobs and leaves no tmp file behind", () => {
    const jobs = [makeJob(), makeJob({ id: "other-job", name: "Other Job", enabled: false })];

    saveJobs(jobs);
    expect(loadJobs()).toEqual(jobs);

    const cronDir = path.join(tmpHome, "cron");
    const leftovers = fs.readdirSync(cronDir).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });
});

describe("appendRunLog", () => {
  it("retains only the newest configured number of run-log entries", () => {
    for (let i = 0; i < 3; i += 1) {
      appendRunLog("test-job", {
        runId: `run-${i}`,
        timestamp: `2026-06-22T00:00:0${i}.000Z`,
        status: "success",
        trigger: "manual",
        resultPreview: null,
      }, { maxEntries: 2 });
    }

    const logPath = path.join(tmpHome, "cron", "runs", "test-job.jsonl");
    const entries = fs.readFileSync(logPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    expect(entries.map((entry) => entry.runId)).toEqual(["run-1", "run-2"]);
  });
});
