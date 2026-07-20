/**
 * Guards for the fail-closed resolution rules of autonomous authorization
 * mode (gateway/autonomous-mode.ts). These are the structural safety
 * properties the feature's design leans on: at most one project, valid
 * realpath'd cwd, exact cwd matching, and the verdict-session recursion
 * guard. If any of these tests fail, autonomous mode may be resolving
 * approvals for sessions/projects it was never scoped to.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isAutonomousModeEnabled,
  isAutonomousVerdictSession,
  isCwdInAutonomousProject,
  resolveAutonomousProject,
} from "../autonomous-mode.js";
import type { CuttlefishConfig } from "../../shared/types.js";

const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cf-auto-")));
const subDir = path.join(projectDir, "packages");
fs.mkdirSync(subDir, { recursive: true });
const otherDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cf-auto-other-")));

function config(input: {
  globalFlag?: boolean;
  profiles?: Record<string, Record<string, unknown>>;
}): CuttlefishConfig {
  return {
    features: input.globalFlag === undefined ? {} : { autonomousMode: input.globalFlag },
    workspaces: input.profiles ? { profiles: input.profiles } : undefined,
  } as CuttlefishConfig;
}

const enabledProfile = (cwd: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  label: "Demo",
  cwd,
  autonomousMode: { enabled: true, ...extra },
});

describe("resolveAutonomousProject — fail-closed resolution", () => {
  it("returns undefined when the global features.autonomousMode kill switch is off", () => {
    expect(resolveAutonomousProject(config({ profiles: { p: enabledProfile(projectDir) } }))).toBeUndefined();
    expect(resolveAutonomousProject(config({ globalFlag: false, profiles: { p: enabledProfile(projectDir) } }))).toBeUndefined();
    expect(isAutonomousModeEnabled(config({ globalFlag: true }))).toBe(true);
  });

  it("returns undefined when no profile opted in", () => {
    expect(resolveAutonomousProject(config({ globalFlag: true }))).toBeUndefined();
    expect(resolveAutonomousProject(config({ globalFlag: true, profiles: { p: { cwd: projectDir } } }))).toBeUndefined();
  });

  it("stays fail-closed when MORE than one profile is enabled (belt-and-braces past the config-load invariant)", () => {
    const cfg = config({
      globalFlag: true,
      profiles: { a: enabledProfile(projectDir), b: enabledProfile(otherDir) },
    });
    expect(resolveAutonomousProject(cfg)).toBeUndefined();
  });

  it("returns undefined when the opted-in profile's cwd does not exist", () => {
    const cfg = config({
      globalFlag: true,
      profiles: { p: enabledProfile(path.join(projectDir, "does-not-exist")) },
    });
    expect(resolveAutonomousProject(cfg)).toBeUndefined();
  });

  it("resolves the single opted-in project with conservative defaults", () => {
    const project = resolveAutonomousProject(config({ globalFlag: true, profiles: { p: enabledProfile(projectDir) } }));
    expect(project).toBeDefined();
    expect(project?.profileId).toBe("p");
    expect(project?.label).toBe("Demo");
    expect(project?.cwd).toBe(projectDir);
    // Every capability flag defaults OFF — enabling the mode alone authorizes nothing.
    expect(project?.toolReview).toBe(false);
    expect(project?.orgChangeOverride).toBe(false);
    expect(project?.continuousDispatch).toBe(false);
    expect(project?.maxAutoDispatchesPerHour).toBe(12);
  });

  it("honors an explicit positive maxAutoDispatchesPerHour and rejects non-positive values", () => {
    const explicit = resolveAutonomousProject(
      config({ globalFlag: true, profiles: { p: enabledProfile(projectDir, { maxAutoDispatchesPerHour: 3 }) } }),
    );
    expect(explicit?.maxAutoDispatchesPerHour).toBe(3);
    const nonPositive = resolveAutonomousProject(
      config({ globalFlag: true, profiles: { p: enabledProfile(projectDir, { maxAutoDispatchesPerHour: 0 }) } }),
    );
    expect(nonPositive?.maxAutoDispatchesPerHour).toBe(12);
  });
});

describe("isCwdInAutonomousProject — deliberately exact matching", () => {
  const project = resolveAutonomousProject(config({ globalFlag: true, profiles: { p: enabledProfile(projectDir) } }))!;

  it("matches the project directory itself", () => {
    expect(isCwdInAutonomousProject(projectDir, project)).toBe(true);
  });

  it("does NOT match a subdirectory (falls through to a human checkpoint)", () => {
    expect(isCwdInAutonomousProject(subDir, project)).toBe(false);
  });

  it("does NOT match an unrelated directory, a missing path, or a null cwd", () => {
    expect(isCwdInAutonomousProject(otherDir, project)).toBe(false);
    expect(isCwdInAutonomousProject(path.join(projectDir, "nope"), project)).toBe(false);
    expect(isCwdInAutonomousProject(null, project)).toBe(false);
    expect(isCwdInAutonomousProject(undefined, project)).toBe(false);
  });
});

describe("isAutonomousVerdictSession — the recursion guard", () => {
  it("is true only for the exact boolean stamp", () => {
    expect(isAutonomousVerdictSession({ autonomousVerdictSession: true })).toBe(true);
    expect(isAutonomousVerdictSession({ autonomousVerdictSession: "true" })).toBe(false);
    expect(isAutonomousVerdictSession({ autonomousVerdictSession: 1 })).toBe(false);
    expect(isAutonomousVerdictSession({})).toBe(false);
    expect(isAutonomousVerdictSession(null)).toBe(false);
    expect(isAutonomousVerdictSession(undefined)).toBe(false);
  });
});
