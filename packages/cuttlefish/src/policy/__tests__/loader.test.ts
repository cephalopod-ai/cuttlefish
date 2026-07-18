import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../shared/logger.js";
import { getPolicyProfile, invalidatePolicyCache, loadPolicyProfile, stopPolicyWatcher } from "../loader.js";

// Controls whether the mocked chokidar `watch()` throws, so we can exercise the
// "watcher setup failed, fall back to TTL-only" path without depending on a real
// unwatchable filesystem.
const { chokidarState } = vi.hoisted(() => ({ chokidarState: { shouldFail: false } }));

vi.mock("chokidar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("chokidar")>();
  return {
    ...actual,
    watch: (...args: Parameters<typeof actual.watch>) => {
      if (chokidarState.shouldFail) {
        throw new Error("simulated watch failure");
      }
      return actual.watch(...args);
    },
  };
});

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-policy-loader-"));
  chokidarState.shouldFail = false;
  invalidatePolicyCache();
});

afterEach(async () => {
  await stopPolicyWatcher();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  invalidatePolicyCache();
  chokidarState.shouldFail = false;
  vi.restoreAllMocks();
});

function writePolicyFile(dir: string, name: string, rules: unknown[]): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ rules }));
}

describe("loadPolicyProfile load-order logging (DAT-BUS-004)", () => {
  it("logs the effective file load order and per-file rule counts", () => {
    writePolicyFile(tmpDir, "00-a.json", [{ id: "a1", allow: true }]);
    writePolicyFile(tmpDir, "01-b.json", [
      { id: "b1", allow: true },
      { id: "b2", allow: false },
    ]);
    const debugSpy = vi.spyOn(logger, "debug");

    loadPolicyProfile(tmpDir);

    expect(debugSpy).toHaveBeenCalled();
    const message = debugSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes("effective"));
    expect(message).toBeDefined();
    expect(message).toContain("00-a.json (1 rule)");
    expect(message).toContain("01-b.json (2 rules)");
    // Order matters: 00-a.json must be reported before 01-b.json.
    expect(message!.indexOf("00-a.json")).toBeLessThan(message!.indexOf("01-b.json"));
  });
});

describe("policy cache invalidation via file watcher (DAT-BUS-003 / CAS-CF-004 / TMP-CUT-002)", () => {
  it("picks up an edited policy file well before the 60s TTL elapses", async () => {
    writePolicyFile(tmpDir, "00-rules.json", [{ id: "original", allow: true }]);

    const initial = getPolicyProfile(tmpDir);
    expect(initial.rules.map((r) => r.id)).toEqual(["original"]);

    // Let the watcher finish its initial scan before mutating the file.
    await new Promise((resolve) => setTimeout(resolve, 300));

    writePolicyFile(tmpDir, "00-rules.json", [{ id: "updated", allow: false }]);

    // Wait for chokidar's awaitWriteFinish + our debounce, but nowhere near
    // the 60s TTL, to prove the watcher (not the TTL) triggered the refresh.
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const updated = getPolicyProfile(tmpDir);
    expect(updated.rules.map((r) => r.id)).toEqual(["updated"]);
  }, 10_000);

  it("does not crash and falls back to TTL-only behavior when the watcher fails to start", () => {
    writePolicyFile(tmpDir, "00-rules.json", [{ id: "r1", allow: true }]);
    const warnSpy = vi.spyOn(logger, "warn");
    chokidarState.shouldFail = true;

    expect(() => getPolicyProfile(tmpDir)).not.toThrow();
    const profile = getPolicyProfile(tmpDir);

    expect(profile.rules.map((r) => r.id)).toEqual(["r1"]);
    expect(warnSpy).toHaveBeenCalled();
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("falling back to TTL-only");
  });
});
