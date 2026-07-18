import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock the paths module so all watched paths live under a throwaway temp home.
// Getters read top-level `let`s assigned in beforeEach (same lazy-getter trick
// org-changes.test.ts uses to keep vi.mock's factory hoist-safe).
let configPath: string;
let cronJobs: string;
let orgDir: string;
let orgChangesDir: string;
let skillsDir: string;
let claudeSkillsDir: string;
let agentsSkillsDir: string;

vi.mock("../../shared/paths.js", () => ({
  get CONFIG_PATH() {
    return configPath;
  },
  get CRON_JOBS() {
    return cronJobs;
  },
  get ORG_DIR() {
    return orgDir;
  },
  get ORG_CHANGES_DIR() {
    return orgChangesDir;
  },
  get SKILLS_DIR() {
    return skillsDir;
  },
  get CLAUDE_SKILLS_DIR() {
    return claudeSkillsDir;
  },
  get AGENTS_SKILLS_DIR() {
    return agentsSkillsDir;
  },
}));

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { startWatchers, stopWatchers } from "../watcher.js";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-watcher-test-"));
  configPath = path.join(home, "config.yaml");
  cronJobs = path.join(home, "cron", "jobs.json");
  orgDir = path.join(home, "org");
  orgChangesDir = path.join(orgDir, "_changes");
  skillsDir = path.join(home, "skills");
  claudeSkillsDir = path.join(home, ".claude", "skills");
  agentsSkillsDir = path.join(home, ".agents", "skills");

  fs.mkdirSync(path.dirname(cronJobs), { recursive: true });
  fs.writeFileSync(configPath, "engines: {}\n", "utf-8");
  fs.writeFileSync(cronJobs, "[]", "utf-8");
  fs.mkdirSync(orgChangesDir, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });
});

afterEach(async () => {
  await stopWatchers();
  fs.rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("org watcher excludes ORG_CHANGES_DIR (CON-CUT-003)", () => {
  it("does not reload org for a write under ORG_CHANGES_DIR, but does for other org/ writes", async () => {
    const onOrgChange = vi.fn();
    startWatchers({
      onConfigReload: vi.fn(),
      onCronReload: vi.fn(),
      onOrgChange,
      onSkillsChange: vi.fn(),
    });

    // Let chokidar finish its initial scan before mutating anything.
    await new Promise((resolve) => setTimeout(resolve, 300));

    // A write to the HR-pipeline's own change-log store, nested under ORG_DIR,
    // must NOT trigger a full org reload.
    fs.writeFileSync(path.join(orgChangesDir, "change-1.json"), JSON.stringify({ id: "change-1" }), "utf-8");

    // Wait past chokidar's awaitWriteFinish (300ms) + the watcher's debounce (500ms).
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(onOrgChange).not.toHaveBeenCalled();

    // A write elsewhere under org/ (actual org data) must still trigger a reload.
    fs.writeFileSync(path.join(orgDir, "engineering.yaml"), "name: engineering\n", "utf-8");

    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(onOrgChange).toHaveBeenCalled();
  }, 15_000);
});
