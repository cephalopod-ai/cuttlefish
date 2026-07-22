import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: { gateway: { port: 8888, host: "127.0.0.1" }, engines: { default: "codex" } },
  snapshot: { generatedAt: "2026-07-21T00:00:00.000Z", engines: {} },
  refreshCodexModels: vi.fn(async () => {}),
  refreshPiModels: vi.fn(async () => {}),
  refreshGrokModels: vi.fn(async () => {}),
  refreshHermesModels: vi.fn(async () => {}),
}));

vi.mock("../../shared/paths.js", () => ({ CUTTLEFISH_HOME: process.cwd() }));
vi.mock("../../shared/config.js", () => ({ loadConfig: () => mocks.config }));
vi.mock("../../shared/engine-limits.js", () => ({ collectEngineLimits: async () => mocks.snapshot }));
vi.mock("../../shared/models.js", () => ({
  refreshCodexModels: mocks.refreshCodexModels,
  refreshPiModels: mocks.refreshPiModels,
  refreshGrokModels: mocks.refreshGrokModels,
  refreshHermesModels: mocks.refreshHermesModels,
}));

import { runLimits } from "../limits.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("limits JSON output", () => {
  it("suppresses discovery diagnostics and writes exactly one JSON document", async () => {
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});

    await runLimits({ json: true });

    expect(mocks.refreshCodexModels).toHaveBeenCalledWith(mocks.config, { quiet: true });
    expect(mocks.refreshPiModels).toHaveBeenCalledWith(mocks.config, { quiet: true });
    expect(mocks.refreshGrokModels).toHaveBeenCalledWith(mocks.config, { quiet: true });
    expect(mocks.refreshHermesModels).toHaveBeenCalledWith(mocks.config, { quiet: true });
    expect(stdout).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual(mocks.snapshot);

    stdout.mockRestore();
  });
});
