import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: { gateway: { port: 8888, host: "127.0.0.1" }, engines: { default: "codex" } },
  snapshot: { generatedAt: "2026-07-21T00:00:00.000Z", engines: {} },
  refreshCodexModels: vi.fn(async () => {}),
  refreshAntigravityModels: vi.fn(async () => {}),
  refreshPiModels: vi.fn(async () => {}),
  refreshGrokModels: vi.fn(async () => {}),
  refreshHermesModels: vi.fn(async () => {}),
  refreshOllamaModels: vi.fn(async () => {}),
  existsSync: vi.fn(() => true),
}));

vi.mock("node:fs", () => ({ default: { existsSync: mocks.existsSync } }));
vi.mock("../../shared/paths.js", () => ({ CUTTLEFISH_HOME: process.cwd() }));
vi.mock("../../shared/config.js", () => ({ loadConfig: () => mocks.config }));
vi.mock("../../shared/engine-limits.js", () => ({ collectEngineLimits: async () => mocks.snapshot }));
vi.mock("../../shared/models.js", () => ({
  refreshCodexModels: mocks.refreshCodexModels,
  refreshAntigravityModels: mocks.refreshAntigravityModels,
  refreshPiModels: mocks.refreshPiModels,
  refreshGrokModels: mocks.refreshGrokModels,
  refreshHermesModels: mocks.refreshHermesModels,
  refreshOllamaModels: mocks.refreshOllamaModels,
}));

import { runLimits } from "../limits.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.existsSync.mockReturnValue(true);
});

describe("limits JSON output", () => {
  it("suppresses discovery diagnostics and writes exactly one JSON document", async () => {
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});

    await runLimits({ json: true });

    expect(mocks.refreshCodexModels).toHaveBeenCalledWith(mocks.config, { quiet: true });
    expect(mocks.refreshAntigravityModels).toHaveBeenCalledWith(mocks.config, { quiet: true });
    expect(mocks.refreshPiModels).toHaveBeenCalledWith(mocks.config, { quiet: true });
    expect(mocks.refreshGrokModels).toHaveBeenCalledWith(mocks.config, { quiet: true });
    expect(mocks.refreshHermesModels).toHaveBeenCalledWith(mocks.config, { quiet: true });
    expect(mocks.refreshOllamaModels).toHaveBeenCalledWith(mocks.config, { quiet: true });
    expect(stdout).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual(mocks.snapshot);

    stdout.mockRestore();
  });

  it("returns a structured nonzero error when setup is missing", async () => {
    mocks.existsSync.mockReturnValue(false);
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    try {
      await runLimits({ json: true });
      expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual({
        status: "error",
        message: "Gateway is not set up. Run \"cuttlefish setup\" first.",
      });
      expect(stderr).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});
