import fs from "node:fs";
import path from "node:path";
import type { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

const { home } = withStaticTempCuttlefishHome("cuttlefish-skills-update-");
const { SKILLS_JSON, skillsUpdate, writeManifest } = await import("../skills.js");
const localFile = path.join(home, "skills", "example", "SKILL.md");
const sourceDir = path.join(home, "download", "example");
const result = (status: number) => ({ status }) as ReturnType<typeof spawnSync>;

beforeEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(localFile), { recursive: true });
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(localFile, "Local edit\n");
  fs.writeFileSync(path.join(sourceDir, "SKILL.md"), "Source version\n");
  writeManifest([{ name: "example", source: "owner/repo@example", installedAt: "2026-09-04T00:00:00Z" }]);
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("skills update playtest regressions", () => {
  it("warns before replacing local edits with the source version", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    skillsUpdate({
      runInstaller: () => {
        expect(log).toHaveBeenCalledWith(expect.stringContaining("local edits may be overwritten"));
        expect(fs.readFileSync(localFile, "utf8")).toBe("Local edit\n");
        return result(0);
      },
      snapshot: () => new Map(),
      findGlobalSkill: () => ({ name: "example", dir: sourceDir }),
    });
    expect(fs.readFileSync(localFile, "utf8")).toBe("Source version\n");
    expect(process.exitCode).toBeUndefined();
  });

  it("exits nonzero and preserves files and manifest when the installer fails", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const before = fs.readFileSync(SKILLS_JSON, "utf8");
    skillsUpdate({ runInstaller: () => result(1), snapshot: () => new Map() });
    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(localFile, "utf8")).toBe("Local edit\n");
    expect(fs.readFileSync(SKILLS_JSON, "utf8")).toBe(before);
  });

  it("continues independent updates while retaining the batch failure exit code", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    writeManifest([
      { name: "broken", source: "bad/source", installedAt: "2026-09-04T00:00:00Z" },
      { name: "example", source: "owner/repo@example", installedAt: "2026-09-04T00:00:00Z" },
    ]);
    skillsUpdate({
      runInstaller: (args) => result(args[1] === "bad/source" ? 1 : 0),
      snapshot: () => new Map(),
      findGlobalSkill: () => ({ name: "example", dir: sourceDir }),
    });
    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(localFile, "utf8")).toBe("Source version\n");
  });
});
