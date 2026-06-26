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

vi.mock("../../shared/version.js", () => ({
  compareSemver: vi.fn(() => -1), // instance behind package
  getPackageVersion: vi.fn(() => "1.1.0"),
  getInstanceVersion: vi.fn(() => "1.0.0"),
  getPendingMigrations: vi.fn(() => ["1.1.0"]),
}));

import { execFileSync } from "node:child_process";
import fs from "node:fs";

const mockExecFileSync = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockReaddirSync = vi.mocked(fs.readdirSync);

describe("migrate: AI session launcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: all paths exist
    mockExistsSync.mockReturnValue(true);
    // Empty directories (no files to copy)
    mockReaddirSync.mockReturnValue([]);
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
