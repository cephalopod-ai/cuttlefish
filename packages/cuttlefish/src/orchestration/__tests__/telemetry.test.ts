import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendOrchestrationTelemetry,
  computeWorkerScores,
  pruneOrchestrationTelemetry,
  readOrchestrationTelemetry,
  summarizeOrchestrationTelemetry,
  telemetryCountsFromDiff,
  type OrchestrationRunTelemetryRecord,
} from "../telemetry.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-orch-telemetry-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("orchestration telemetry", () => {
  it("appends sanitized JSONL with private file mode where supported", () => {
    const logPath = path.join(tmpDir, "orchestration-telemetry.jsonl");

    appendOrchestrationTelemetry({
      ...record({ worker_id: "worker-a" }),
      prompt: "do not persist raw prompt",
      cwd: "/tmp/secret-path",
    } as OrchestrationRunTelemetryRecord, { logPath });

    const raw = fs.readFileSync(logPath, "utf-8");
    expect(raw).not.toContain("raw prompt");
    expect(raw).not.toContain("secret-path");
    const parsed = JSON.parse(raw);
    expect(parsed.worker_id).toBe("worker-a");
    if (process.platform !== "win32") {
      expect((fs.statSync(logPath).mode & 0o777).toString(8)).toBe("600");
    }
  });

  it("reads corrupt-line-tolerant telemetry and summarizes by provider family role and worker", () => {
    const logPath = path.join(tmpDir, "runs.jsonl");
    fs.writeFileSync(logPath, [
      JSON.stringify(record({ provider: "mock", family: "local", role: "implementer", worker_id: "worker-a", cost: 0.25 })),
      "{not-json",
      JSON.stringify(record({ provider: "claude", family: "anthropic", role: "reviewer", worker_id: "worker-b", disposition: "failed" })),
      "",
    ].join("\n"));

    const read = readOrchestrationTelemetry(logPath);
    const summary = summarizeOrchestrationTelemetry(read);

    expect(read.skippedLines).toBe(1);
    expect(summary.totals.count).toBe(2);
    expect(summary.byProvider.mock.count).toBe(1);
    expect(summary.byFamily.anthropic.dispositions.failed).toBe(1);
    expect(summary.byRole.reviewer.score).toBeLessThan(0);
    expect(summary.byWorker["worker-a"].avgCost).toBe(0.25);
  });

  it("computes deterministic worker scores with failure degradation", () => {
    const scores = computeWorkerScores([
      record({ worker_id: "winner", disposition: "completed" }),
      record({ worker_id: "winner", disposition: "selected" }),
      record({ worker_id: "loser", disposition: "failed" }),
      record({ worker_id: "loser", disposition: "completed", regressions: 1 }),
    ]);

    expect(scores.winner).toBe(3);
    expect(scores.loser).toBe(-3);
  });

  it("decays empirical worker scores by age while clamping future timestamps", () => {
    const now = new Date("2026-06-24T00:00:00.000Z");
    const scores = computeWorkerScores([
      record({ worker_id: "recent", disposition: "completed", timestamp: "2026-06-23T00:00:00.000Z" }),
      record({ worker_id: "ancient", disposition: "selected", timestamp: "2026-01-01T00:00:00.000Z" }),
      record({ worker_id: "future", disposition: "completed", timestamp: "2026-07-01T00:00:00.000Z" }),
    ], { now });

    expect(scores.recent).toBeGreaterThan(0.9);
    expect(scores.ancient).toBeUndefined();
    expect(scores.future).toBe(1);
  });

  it("supports bounded tail reads for runtime scoring", () => {
    const logPath = path.join(tmpDir, "large-runs.jsonl");
    const lines = [
      JSON.stringify(record({ task_id: "old", worker_id: "old-worker" })),
      JSON.stringify(record({ task_id: "new", worker_id: "new-worker" })),
    ];
    fs.writeFileSync(logPath, lines.join("\n"));

    const read = readOrchestrationTelemetry(logPath, { maxBytes: lines[1].length + 8, maxRecords: 1 });

    expect(read.records).toHaveLength(1);
    expect(read.records[0].worker_id).toBe("new-worker");
  });

  it("prunes telemetry by age and record count while dropping corrupt lines", () => {
    const logPath = path.join(tmpDir, "retained-runs.jsonl");
    fs.writeFileSync(logPath, [
      JSON.stringify(record({ task_id: "old", worker_id: "old-worker", timestamp: "2026-01-01T00:00:00.000Z" })),
      "{not-json",
      JSON.stringify(record({ task_id: "new-1", worker_id: "new-worker-1", timestamp: "2026-06-22T00:00:00.000Z" })),
      JSON.stringify(record({ task_id: "new-2", worker_id: "new-worker-2", timestamp: "2026-06-23T00:00:00.000Z" })),
    ].join("\n"));

    const result = pruneOrchestrationTelemetry({
      logPath,
      now: new Date("2026-06-24T00:00:00.000Z"),
      maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
      maxRecords: 1,
    });
    const read = readOrchestrationTelemetry(logPath);

    expect(result).toEqual({ kept: 1, removed: 2, skippedLines: 1 });
    expect(read.records.map((entry) => entry.task_id)).toEqual(["new-2"]);
    expect(read.skippedLines).toBe(0);
  });

  it("treats missing telemetry logs as a prune no-op", () => {
    expect(pruneOrchestrationTelemetry({ logPath: path.join(tmpDir, "missing.jsonl") }))
      .toEqual({ kept: 0, removed: 0, skippedLines: 0 });
  });

  it("counts changed files and test files without exposing paths", () => {
    const counts = telemetryCountsFromDiff([
      "diff --git a/src/a.ts b/src/a.ts",
      "+++ b/src/a.ts",
      "diff --git a/src/a.test.ts b/src/a.test.ts",
      "+++ b/src/a.test.ts",
      "Untracked files:",
      "  docs/readme.md",
      "",
    ].join("\n"));

    expect(counts).toEqual({ filesChanged: 3, testsAdded: 1 });
  });
});

function record(overrides: Partial<OrchestrationRunTelemetryRecord> = {}): OrchestrationRunTelemetryRecord {
  return {
    task_id: "task-1",
    coordinator_id: "coord-1",
    session_id: "session-1",
    lease_id: "lease-1",
    worker_id: "worker-1",
    provider: "mock",
    family: "local",
    model: null,
    role: "implementer",
    mode: "single_worker",
    source: "orchestration",
    cost: null,
    latency_ms: 100,
    tokens: 1000,
    files_changed: null,
    tests_added: null,
    tests_passed: null,
    review_blockers: null,
    human_edits: null,
    regressions: null,
    disposition: "completed",
    timestamp: "2026-06-24T00:00:00.000Z",
    ...overrides,
  };
}
