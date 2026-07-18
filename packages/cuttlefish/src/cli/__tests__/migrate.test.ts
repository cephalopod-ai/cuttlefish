import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock child_process before importing the module under test
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

// Mock fs to control filesystem responses
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      copyFileSync: vi.fn(),
      readdirSync: vi.fn(() => []),
      rmSync: vi.fn(),
    },
  };
});

// Mock shared modules
vi.mock("../../shared/config.js", () => ({
  loadConfig: vi.fn(() => ({
    engines: {
      default: "claude",
      claude: { bin: "/usr/local/bin/claude" },
    },
  })),
}));

// getInstanceVersion is called twice by runMigrate on the AI-migration path:
// once up front (to compute `pending`) and once again after the engine process
// exits, to verify the migration actually stamped the new version. Real
// semantics: it reads whatever is currently on disk, so model it with a
// mutable variable that execFileSync's mock implementation can flip — just
// like the real `claude` CLI writes config.yaml as a side effect of the run.
let instanceVersionOnDisk = "1.0.0";

vi.mock("../../shared/version.js", () => ({
  compareSemver: vi.fn((a: string, b: string) => {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }),
  getPackageVersion: vi.fn(() => "1.1.0"),
  getInstanceVersion: vi.fn(() => instanceVersionOnDisk),
  getPendingMigrations: vi.fn(() => ["1.1.0"]),
}));

import { execFileSync } from "node:child_process";
import fs from "node:fs";

const mockExecFileSync = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockReaddirSync = vi.mocked(fs.readdirSync);

describe("migrate: AI session launcher", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: all paths exist
    mockExistsSync.mockReturnValue(true);
    // Empty directories (no files to copy)
    mockReaddirSync.mockReturnValue([]);

    // Instance starts behind package version (1.0.0 -> 1.1.0 pending).
    instanceVersionOnDisk = "1.0.0";

    // Default execFileSync behavior: simulate the AI session actually applying
    // the migration and stamping cuttlefish.version to the package version,
    // like the migrate skill instructs it to. Individual tests override this
    // to simulate a session that exits 0 without applying anything.
    mockExecFileSync.mockImplementation(() => {
      instanceVersionOnDisk = "1.1.0";
      return Buffer.from("");
    });

    // process.exit would otherwise kill the test worker; make it a no-op spy
    // so post-exit control flow (the `return` after each exit(1) call) is
    // exercised instead, and assert on the exit code via the spy.
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });

  it("should NOT pass --cwd as a CLI argument to the engine binary", async () => {
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({});

    // execFileSync should have been called (AI session launched)
    expect(mockExecFileSync).toHaveBeenCalled();

    const [bin, args] = mockExecFileSync.mock.calls[0];

    // The args array must NOT contain "--cwd"
    expect(args).not.toContain("--cwd");
  });

  it("should set cwd via execFileSync options, not as a CLI flag", async () => {
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({});

    expect(mockExecFileSync).toHaveBeenCalled();

    const [_bin, _args, options] = mockExecFileSync.mock.calls[0];

    // The cwd should be set in the options object
    expect(options).toBeDefined();
    expect((options as any).cwd).toBeDefined();
    expect(typeof (options as any).cwd).toBe("string");
  });

  it("should NOT pass -p (subsidy-safe interactive spawn, no headless print mode)", async () => {
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({});

    expect(mockExecFileSync).toHaveBeenCalled();

    const [_bin, args] = mockExecFileSync.mock.calls[0];
    const argsArray = args as string[];

    // `cuttlefish migrate` (claude) now launches the interactive TUI (cc_entrypoint=cli)
    // instead of the headless `-p`/`--print` Agent-SDK pool.
    expect(argsArray).not.toContain("-p");
    expect(argsArray).not.toContain("--print");
  });

  it("should still pass --dangerously-skip-permissions, consent-skip settings, and the migration prompt", async () => {
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({});

    expect(mockExecFileSync).toHaveBeenCalled();

    const [_bin, args] = mockExecFileSync.mock.calls[0];
    const argsArray = args as string[];

    expect(argsArray).toContain("--dangerously-skip-permissions");
    const settingsIndex = argsArray.indexOf("--settings");
    expect(settingsIndex).toBeGreaterThan(-1);
    expect(argsArray[settingsIndex + 1]).toContain("settings.json");
    const settingsWrite = vi.mocked(fs.writeFileSync).mock.calls.find(([file]) => String(file).endsWith("settings.json"));
    expect(settingsWrite?.[1]).toContain("skipDangerousModePermissionPrompt");
    // The prompt is the last positional arg and references the migration.
    expect(argsArray[argsArray.length - 1]).toContain("migration");
  });
});

describe("migrate: post-run verification (FSR-CF-018)", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([]);
    instanceVersionOnDisk = "1.0.0";
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("reports success only after re-reading the on-disk version and confirming it advanced", async () => {
    const { getInstanceVersion } = await import("../../shared/version.js");

    // Simulate the engine process exiting 0 *and* actually stamping the new
    // version via config.yaml, mirroring what the migrate skill instructs.
    mockExecFileSync.mockImplementation(() => {
      instanceVersionOnDisk = "1.1.0";
      return Buffer.from("");
    });

    const { runMigrate } = await import("../migrate.js");
    await runMigrate({});

    // The verification step must have actually re-read the version from disk
    // after the engine process returned, not merely trusted the exit code.
    // getInstanceVersion is called once up front and once again for verification.
    expect(vi.mocked(getInstanceVersion).mock.calls.length).toBeGreaterThanOrEqual(2);

    expect(exitSpy).not.toHaveBeenCalledWith(1);
    const successLog = logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(successLog).toContain("Migration complete");
    expect(successLog).toContain("1.1.0");
  });

  it("reports failure and exits non-zero when the engine exits 0 but never advances the version (silent no-op)", async () => {
    // Simulate an engine process that exits cleanly (e.g. operator closed the
    // TUI, or the AI never actually followed the migrate skill) without
    // stamping cuttlefish.version — the pre-fix bug reported success here.
    mockExecFileSync.mockImplementation(() => {
      // instanceVersionOnDisk intentionally left unchanged (still "1.0.0").
      return Buffer.from("");
    });

    const { runMigrate } = await import("../migrate.js");
    await runMigrate({});

    expect(mockExecFileSync).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);

    const errorOutput = errorSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(errorOutput).toContain("verification failed");
    // Actionable detail: expected vs. observed version.
    expect(errorOutput).toContain("1.1.0");
    expect(errorOutput).toContain("1.0.0");

    // Must NOT print the false-success message.
    const successLog = logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(successLog).not.toContain("Migration complete");
  });
});
