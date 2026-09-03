import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CuttlefishConfig } from "../types.js";

const discoverAntigravityModels = vi.fn();
const isInstalled = vi.fn();
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

vi.mock("../antigravity-models.js", async () => {
  const actual = await vi.importActual<typeof import("../antigravity-models.js")>("../antigravity-models.js");
  return { ...actual, discoverAntigravityModels };
});

vi.mock("../resolve-bin.js", async () => {
  const actual = await vi.importActual<typeof import("../resolve-bin.js")>("../resolve-bin.js");
  return { ...actual, isInstalled, resolveBin: vi.fn(() => "/usr/local/bin/agy") };
});

vi.mock("../logger.js", () => ({ logger }));

function config(): CuttlefishConfig {
  return {
    gateway: { port: 8888, host: "127.0.0.1" },
    engines: {
      default: "antigravity",
      claude: { bin: "claude", model: "opus" },
      codex: { bin: "codex", model: "gpt-5.6-sol" },
      antigravity: { bin: "agy", model: "Gemini 3.5 Flash (Medium)" },
    },
    models: {
      antigravity: {
        default: "Gemini 3.5 Flash (Medium)",
        models: [
          { id: "Gemini 3.5 Flash (Medium)", label: "stale", supportsEffort: false, effortLevels: [] },
          { id: "gemini-3.8-flash-medium", label: "configured", supportsEffort: false, effortLevels: [], contextWindow: 1_000_000 },
        ],
      },
    },
    connectors: {},
    logging: { file: false, stdout: false, level: "info" },
  };
}

describe("Antigravity model registry refresh", () => {
  beforeEach(() => {
    vi.resetModules();
    discoverAntigravityModels.mockReset();
    isInstalled.mockImplementation((bin: string) => bin === "agy" || bin === "claude" || bin === "codex");
  });

  it("replaces stale display-name ids with the canonical ids exposed by the CLI", async () => {
    discoverAntigravityModels.mockResolvedValue({
      models: [
        { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)", supportsEffort: false, effortLevels: [] },
        { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)", supportsEffort: false, effortLevels: [] },
      ],
    });

    const { getModelRegistry, invalidateModelRegistry, refreshAntigravityModels } = await import("../models.js");
    const cfg = config();
    invalidateModelRegistry();
    await refreshAntigravityModels(cfg);
    const entry = getModelRegistry(cfg).antigravity;

    expect(entry.defaultModel).toBe("gemini-3.8-flash-medium");
    expect(entry.models.map((model) => model.id)).toEqual(["gemini-3.8-flash-high", "gemini-3.8-flash-medium"]);
    expect(entry.models[1].contextWindow).toBe(1_000_000);
    expect(logger.info).toHaveBeenCalledWith("Antigravity model discovery: 2 model(s)");
  });
});
