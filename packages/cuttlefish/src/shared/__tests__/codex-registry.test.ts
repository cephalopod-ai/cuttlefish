import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CuttlefishConfig } from "../types.js";

const discoverCodexModels = vi.fn();
const isInstalled = vi.fn();

vi.mock("../codex-models.js", () => ({
  discoverCodexModels,
}));

vi.mock("../resolve-bin.js", async () => {
  const actual = await vi.importActual<typeof import("../resolve-bin.js")>("../resolve-bin.js");
  return {
    ...actual,
    isInstalled,
  };
});

function cfg(partial?: Partial<CuttlefishConfig["engines"]>, models?: CuttlefishConfig["models"]): CuttlefishConfig {
  return {
    gateway: { port: 8888, host: "127.0.0.1" },
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "opus" },
      codex: { bin: "codex", model: "gpt-5.5" },
      ...partial,
    },
    models,
    connectors: {},
  } as CuttlefishConfig;
}

describe("Codex model registry refresh", () => {
  beforeEach(() => {
    vi.resetModules();
    discoverCodexModels.mockReset();
    isInstalled.mockImplementation((bin: string) => bin === "codex" || bin === "claude");
  });

  it("refreshes the registry from discovered Codex models", async () => {
    discoverCodexModels.mockResolvedValue({
      defaultModel: "gpt-5.6",
      models: [
        { id: "gpt-5.6", label: "GPT-5.6", supportsEffort: true, effortLevels: ["low", "high"] },
        { id: "gpt-5.5", label: "GPT-5.5", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh"] },
      ],
    });

    const { refreshCodexModels, getModelRegistry, invalidateModelRegistry } = await import("../models.js");
    invalidateModelRegistry();
    const config = cfg();
    await refreshCodexModels(config);
    const entry = getModelRegistry(config).codex;

    expect(entry.defaultModel).toBe("gpt-5.5");
    expect(entry.models.map((model) => model.id)).toEqual(["gpt-5.6", "gpt-5.5"]);
  });

  it("keeps the pinned Codex model as a fallback entry when discovery omits it", async () => {
    discoverCodexModels.mockResolvedValue({
      defaultModel: "gpt-5.6",
      models: [
        { id: "gpt-5.6", label: "GPT-5.6", supportsEffort: true, effortLevels: ["low", "high"] },
      ],
    });

    const { refreshCodexModels, getModelRegistry, invalidateModelRegistry } = await import("../models.js");
    invalidateModelRegistry();
    const config = cfg({ codex: { bin: "codex", model: "gpt-5.5" } });
    await refreshCodexModels(config);
    const entry = getModelRegistry(config).codex;

    expect(entry.defaultModel).toBe("gpt-5.5");
    expect(entry.models).toEqual([
      { id: "gpt-5.6", label: "GPT-5.6", supportsEffort: true, effortLevels: ["low", "high"] },
      { id: "gpt-5.5", label: "gpt-5.5", supportsEffort: false, effortLevels: [] },
    ]);
  });

  it("preserves explicit pinned Codex capabilities from config when discovery omits that model", async () => {
    discoverCodexModels.mockResolvedValue({
      defaultModel: "gpt-5.6",
      models: [
        { id: "gpt-5.6", label: "GPT-5.6", supportsEffort: true, effortLevels: ["low", "high"] },
      ],
    });

    const { refreshCodexModels, getModelRegistry, invalidateModelRegistry } = await import("../models.js");
    invalidateModelRegistry();
    const config = cfg(
      { codex: { bin: "codex", model: "gpt-5.5" } },
      {
        codex: {
          default: "gpt-5.5",
          models: [{ id: "gpt-5.5", label: "Pinned GPT-5.5", supportsEffort: true, effortLevels: ["medium"] }],
        },
      },
    );
    await refreshCodexModels(config);
    const entry = getModelRegistry(config).codex;

    expect(entry.defaultModel).toBe("gpt-5.5");
    expect(entry.models).toEqual([
      { id: "gpt-5.6", label: "GPT-5.6", supportsEffort: true, effortLevels: ["low", "high"] },
      { id: "gpt-5.5", label: "Pinned GPT-5.5", supportsEffort: true, effortLevels: ["medium"] },
    ]);
  });

  it("falls back to the configured/synthesized Codex entry when discovery fails", async () => {
    discoverCodexModels.mockRejectedValue(new Error("boom"));

    const { refreshCodexModels, getModelRegistry, invalidateModelRegistry } = await import("../models.js");
    invalidateModelRegistry();
    const config = cfg(undefined, {
      codex: {
        default: "gpt-5.5",
        models: [{ id: "gpt-5.5", label: "Pinned GPT-5.5", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh"] }],
      },
    });
    await refreshCodexModels(config);
    const entry = getModelRegistry(config).codex;

    expect(entry.defaultModel).toBe("gpt-5.5");
    expect(entry.models).toEqual([
      { id: "gpt-5.5", label: "Pinned GPT-5.5", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh"] },
    ]);
  });
});
