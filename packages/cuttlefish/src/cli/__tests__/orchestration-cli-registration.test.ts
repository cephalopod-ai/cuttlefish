import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, "../../../../..");
const cliEntry = join(repoRoot, "packages/cuttlefish/dist/bin/cuttlefish.js");
const orchestrationExamples = join(repoRoot, "docs/orchestration/examples");

function runCli(args: string[]) {
  return spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: repoRoot,
    encoding: "utf-8",
  });
}

describe("shipped orchestration CLI registration (TS-RIG-001)", () => {
  beforeAll(() => {
    execFileSync("pnpm", ["--filter", "cuttlefish-cli", "build"], {
      cwd: repoRoot,
      stdio: "pipe",
    });
    expect(existsSync(cliEntry)).toBe(true);
  }, 60_000);

  it("exposes every documented orchestration command group in shipped help", () => {
    const result = runCli(["--help"]);

    expect(result.status).toBe(0);
    for (const command of [
      "workers", "scheduler", "leases", "queue", "run", "dual-lane",
      "holds", "artifacts", "continuations", "recovery", "worktree",
    ]) {
      expect(result.stdout).toContain(command);
    }
  });

  it("treats a bare invocation as the successful discovery path", () => {
    const result = runCli([]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: cuttlefish");
    expect(result.stderr).toBe("");
  });

  it("prints usage errors once and preserves JSON error output", () => {
    for (const args of [["start", "--bogus-flag"], ["status", "extra"], ["skills", "add"]]) {
      const result = runCli(args);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.trim().split("\n")).toHaveLength(1);
      expect(result.stderr).toContain("error:");
    }
    const jsonResult = runCli(["limits", "--bogus-flag", "--json"]);
    expect(jsonResult.status).toBe(1);
    expect(jsonResult.stderr).toBe("");
    expect(JSON.parse(jsonResult.stdout)).toEqual(expect.objectContaining({ status: "error" }));
  });

  it("runs workers, allocation dry-run, and simulation commands as JSON without durable scheduler state", () => {
    const workers = runCli(["workers", "list", "--config-dir", orchestrationExamples, "--json"]);
    const allocation = runCli([
      "scheduler", "allocate", join(orchestrationExamples, "task-standard.yaml"),
      "--config-dir", orchestrationExamples, "--dry-run", "--json",
    ]);
    const simulation = runCli([
      "scheduler", "simulate", join(orchestrationExamples, "scenario-blocked-resource.yaml"),
      "--config-dir", orchestrationExamples, "--json",
    ]);

    expect(workers.status).toBe(0);
    expect(JSON.parse(workers.stdout)).toEqual(expect.objectContaining({ workers: expect.any(Array) }));
    expect(allocation.status).toBe(0);
    expect(JSON.parse(allocation.stdout)).toEqual(expect.objectContaining({ ok: expect.any(Boolean) }));
    expect(simulation.status).toBe(0);
    expect(JSON.parse(simulation.stdout)).toEqual(expect.objectContaining({ steps: expect.any(Array) }));
  });

  it("fails closed when the required allocation dry-run guard is omitted", () => {
    const result = runCli([
      "scheduler", "allocate", join(orchestrationExamples, "task-standard.yaml"),
      "--config-dir", orchestrationExamples,
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--dry-run");
  });

  it("returns structured stdout for errors from --json actions", () => {
    const result = runCli([
      "scheduler", "allocate", join(orchestrationExamples, "task-standard.yaml"),
      "--config-dir", orchestrationExamples, "--json",
    ]);

    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      status: "error",
      message: expect.stringContaining("--dry-run"),
    });
  });

  it("returns structured stdout for global validation failures under --json", () => {
    const result = runCli(["--instance", "not-cuttlefish", "unpair", "--json"]);

    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      status: "error",
      message: expect.stringContaining("one local instance"),
    });
    expect(result.stderr).toBe("");
  });

  it("advertises the managed worktree command surface without executing it", () => {
    const result = runCli(["worktree", "--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("create [options] <taskFile>");
    expect(result.stdout).toContain("diff [options] <taskFile>");
    expect(result.stdout).toContain("cleanup [options] <taskFile>");
  });
});
