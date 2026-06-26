import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

let tmpHome: string;
const testHome = withTempCuttlefishHome("cuttlefish-orch-worktree-cli-");
let repoDir: string;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpHome = testHome.home();
  repoDir = path.join(tmpHome, "repo");
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  initGitRepo(repoDir);
  writeConfig(tmpHome);
});

afterEach(() => {
  logSpy.mockRestore();
});

describe("cuttlefish worktree CLI helpers", () => {
  it("creates, diffs, and cleans up a managed task worktree", async () => {
    const taskFile = path.join(tmpHome, "task.yaml");
    fs.writeFileSync(taskFile, [
      "taskId: cli-worktree-task",
      `cwd: ${repoDir}`,
    ].join("\n"));

    const { runWorktreeCreate, runWorktreeDiff, runWorktreeCleanup } = await import("../orchestration.js");
    await runWorktreeCreate(taskFile, { lane: "implementation", json: true });
    const created = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(created.mode).toBe("implementation_worktree");

    fs.writeFileSync(path.join(created.cwd, "cli.txt"), "cli change\n");
    await runWorktreeDiff(taskFile, { lane: "implementation", json: true });
    const diff = JSON.parse(String(logSpy.mock.calls[1][0]));
    expect(diff.diff).toContain("cli.txt");

    await runWorktreeCleanup(taskFile, { lane: "implementation", json: true });
    const cleanup = JSON.parse(String(logSpy.mock.calls[2][0]));
    expect(cleanup).toMatchObject({ removed: true, taskId: "cli-worktree-task", lane: "implementation" });
    expect(fs.existsSync(created.cwd)).toBe(false);
  }, 15_000);
});

function writeConfig(dir: string): void {
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
    "orchestration:",
    "  enabled: true",
    `  worktreeRoot: ${path.join(dir, "worktrees")}`,
    "  maxWorktrees: 2",
  ].join("\n"));
}

function initGitRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(["init"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test User"], dir);
  fs.writeFileSync(path.join(dir, "README.md"), "base\n");
  git(["add", "README.md"], dir);
  git(["commit", "-m", "initial"], dir);
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}
