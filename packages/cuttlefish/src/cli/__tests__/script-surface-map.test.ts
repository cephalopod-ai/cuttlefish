import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../../../../..");

function readPkg(rel: string): { scripts?: Record<string, string> } {
  return JSON.parse(readFileSync(join(REPO_ROOT, rel), "utf-8"));
}

// Regression fixture for docs/script-surface-map.md classifications.
// These tests verify that the scripts named in the surface map have the
// command strings that justify their risk classifications. A failing test
// means either the script changed without updating the surface map, or the
// surface map classification needs to be re-evaluated.
describe("script surface classification regression (see docs/script-surface-map.md)", () => {
  describe("SCRIPT-001 — root setup:force is destructive", () => {
    it("setup:force delegates to cuttlefish setup --force (deletes CUTTLEFISH_HOME before reinitializing)", () => {
      const { scripts } = readPkg("package.json");
      expect(scripts!["setup:force"]).toContain("setup --force");
    });
  });

  describe("SCRIPT-002 — root nuke is destructive and interactive", () => {
    it("nuke delegates to cuttlefish nuke (permanently deletes instance home and registry entry)", () => {
      const { scripts } = readPkg("package.json");
      const nukeCmd = scripts!["nuke"];
      expect(nukeCmd).toContain("nuke");
    });

    it("nuke is not aliased to a dry-run or safe variant", () => {
      const { scripts } = readPkg("package.json");
      const nukeCmd = scripts!["nuke"];
      expect(nukeCmd).not.toContain("--dry-run");
      expect(nukeCmd).not.toContain("--check");
    });
  });

  describe("SCRIPT-003 — packages/web clean must be cross-platform", () => {
    it("packages/web clean does not use POSIX-only rm -rf (replaced with Node.js cross-platform command)", () => {
      const { scripts } = readPkg("packages/web/package.json");
      expect(scripts!["clean"]).not.toMatch(/^rm\s+-rf/);
    });

    it("packages/web clean uses a Node.js rmSync-based command", () => {
      const { scripts } = readPkg("packages/web/package.json");
      expect(scripts!["clean"]).toContain("rmSync");
    });
  });

  describe("SCRIPT-004 — test:watch scripts are interactive and unbounded", () => {
    it("packages/cuttlefish test uses vitest run (bounded — safe for deterministic sweeps)", () => {
      const { scripts } = readPkg("packages/cuttlefish/package.json");
      expect(scripts!["test"]).toContain("vitest run");
    });

    it("packages/web test uses vitest run (bounded — safe for deterministic sweeps)", () => {
      const { scripts } = readPkg("packages/web/package.json");
      expect(scripts!["test"]).toContain("vitest run");
    });

    it("packages/cuttlefish test:watch is bare vitest without run (interactive watch mode — excluded from sweeps)", () => {
      const { scripts } = readPkg("packages/cuttlefish/package.json");
      expect(scripts!["test:watch"]).toBe("vitest");
    });

    it("packages/web test:watch is bare vitest without run (interactive watch mode — excluded from sweeps)", () => {
      const { scripts } = readPkg("packages/web/package.json");
      expect(scripts!["test:watch"]).toBe("vitest");
    });
  });

  describe("SCRIPT-005 — coverage scripts write output (state-mutating)", () => {
    it("packages/cuttlefish coverage uses vitest run --coverage (bounded; writes coverage/ directory)", () => {
      const { scripts } = readPkg("packages/cuttlefish/package.json");
      expect(scripts!["coverage"]).toContain("vitest run --coverage");
    });

    it("root coverage delegates through turbo (not a direct vitest run)", () => {
      const { scripts } = readPkg("package.json");
      expect(scripts!["coverage"]).toContain("turbo");
    });
  });

  describe("SCRIPT-006 — root cuttlefish is a dispatcher, not an atomic probe target", () => {
    it("root status script invokes a safe read-only subcommand (not the bare dispatcher)", () => {
      const { scripts } = readPkg("package.json");
      expect(scripts!["status"]).toContain("status");
    });

    it("root nuke and setup:force are separate named scripts, not hidden inside a safe-looking name", () => {
      const { scripts } = readPkg("package.json");
      expect(Object.keys(scripts!)).toContain("nuke");
      expect(Object.keys(scripts!)).toContain("setup:force");
    });
  });
});
