import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CuttlefishConfig } from "../types.js";

const discoverCodexModels = vi.fn();
const isInstalled = vi.fn();
const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

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

vi.mock("../logger.js", () => ({ logger }));

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
    logger.info.mockReset();
    logger.warn.mockReset();
    isInstalled.mockImplementation((bin: string) => bin === "codex" || bin === "claude");
  });

  it("prefers Astra when discovery advertises it and no model is pinned", async () => {
    discoverCodexModels.mockResolvedValue({
      defaultModel: "gpt-5.6-sol",
      models: [
        { id: "gpt-5.6-sol", label: "Sol", supportsEffort: true, effortLevels: ["low", "high"] },
        { id: "gpt-6-astra", label: "Astra", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"] },
      ],
    });
    const { refreshCodexModels, getModelRegistry, invalidateModelRegistry } = await import("../models.js");
    const config = cfg({ codex: undefined });
    await refreshCodexModels(config);
    expect(getModelRegistry(config).codex.defaultModel).toBe("gpt-6-astra");
    // A deliberate selection of Sol must still win over the shipped default.
    const pinned = cfg({ codex: { bin: "codex", model: "gpt-5.6-sol" } });
    invalidateModelRegistry();
    expect(getModelRegistry(pinned).codex.defaultModel).toBe("gpt-5.6-sol");
  });

  it("uses Astra for an unconfigured install when discovery fails", async () => {
    discoverCodexModels.mockRejectedValue(new Error("discovery unavailable"));
    const { refreshCodexModels, getModelRegistry } = await import("../models.js");
    const config = cfg({ codex: undefined });
    await refreshCodexModels(config);
    expect(getModelRegistry(config).codex.defaultModel).toBe("gpt-6-astra");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("discovery unavailable"));
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
    expect(logger.info).toHaveBeenCalledWith("Codex model discovery: 2 model(s)");
  });

  it("can refresh without writing discovery diagnostics", async () => {
    discoverCodexModels.mockResolvedValue({
      defaultModel: "gpt-5.6",
      models: [{ id: "gpt-5.6", label: "GPT-5.6", supportsEffort: true, effortLevels: ["low", "high"] }],
    });

    const { refreshCodexModels } = await import("../models.js");
    await refreshCodexModels(cfg(), { quiet: true });

    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("overlays configured contextWindow onto a discovered Codex model while keeping discovery's effort support authoritative", async () => {
    discoverCodexModels.mockResolvedValue({
      defaultModel: "gpt-5.6",
      models: [
        { id: "gpt-5.6", label: "GPT-5.6", supportsEffort: true, effortLevels: ["low", "high"] },
        { id: "gpt-5.5", label: "GPT-5.5", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh"] },
      ],
    });

    const { refreshCodexModels, getModelRegistry, invalidateModelRegistry, contextWindowForModel } = await import("../models.js");
    invalidateModelRegistry();
    const config = cfg(undefined, {
      codex: {
        default: "gpt-5.5",
        // Discovery still wins for label/supportsEffort/effortLevels; only contextWindow overlays.
        models: [{ id: "gpt-5.5", label: "Pinned GPT-5.5", supportsEffort: true, effortLevels: ["medium"], contextWindow: 1050000 }],
      },
    });
    await refreshCodexModels(config);
    const entry = getModelRegistry(config).codex;

    const discoveredGpt55 = entry.models.find((model) => model.id === "gpt-5.5");
    expect(discoveredGpt55).toEqual({
      id: "gpt-5.5",
      label: "GPT-5.5",
      supportsEffort: true,
      effortLevels: ["low", "medium", "high", "xhigh"],
      contextWindow: 1050000,
    });
    expect(contextWindowForModel(config, "codex", "gpt-5.5")).toBe(1050000);
  });

  it("leaves a discovered Codex model's contextWindow unset when no configured entry declares one", async () => {
    discoverCodexModels.mockResolvedValue({
      defaultModel: "gpt-5.5",
      models: [
        { id: "gpt-5.5", label: "GPT-5.5", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh"] },
      ],
    });

    const { refreshCodexModels, getModelRegistry, invalidateModelRegistry, contextWindowForModel } = await import("../models.js");
    invalidateModelRegistry();
    const config = cfg();
    await refreshCodexModels(config);
    const entry = getModelRegistry(config).codex;

    expect(entry.models[0]).not.toHaveProperty("contextWindow");
    expect(contextWindowForModel(config, "codex", "gpt-5.5")).toBeUndefined();
  });

  it("does not advertise a pinned Codex model that discovery omits", async () => {
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

    expect(entry.defaultModel).toBe("gpt-5.6");
    expect(entry.models).toEqual([
      { id: "gpt-5.6", label: "GPT-5.6", supportsEffort: true, effortLevels: ["low", "high"] },
    ]);
  });

  it("does not append a configured Codex model that discovery omits", async () => {
    discoverCodexModels.mockResolvedValue({
      defaultModel: "gpt-5.6",
      models: [
        { id: "gpt-5.6", label: "GPT-5.6", supportsEffort: true, effortLevels: ["low", "high"] },
      ],
    });

    const { refreshCodexModels, getModelRegistry, invalidateModelRegistry, contextWindowForModel } = await import("../models.js");
    invalidateModelRegistry();
    const config = cfg(
      { codex: { bin: "codex", model: "gpt-5.5" } },
      {
        codex: {
          default: "gpt-5.5",
          models: [{ id: "gpt-5.5", label: "Pinned GPT-5.5", supportsEffort: true, effortLevels: ["medium"], contextWindow: 1050000 }],
        },
      },
    );
    await refreshCodexModels(config);
    const entry = getModelRegistry(config).codex;

    expect(entry.defaultModel).toBe("gpt-5.6");
    expect(entry.models).toEqual([
      { id: "gpt-5.6", label: "GPT-5.6", supportsEffort: true, effortLevels: ["low", "high"] },
    ]);
    expect(contextWindowForModel(config, "codex", "gpt-5.5")).toBeUndefined();
  });

  it("falls back to the configured/synthesized Codex entry when discovery fails, preserving contextWindow", async () => {
    discoverCodexModels.mockRejectedValue(new Error("boom"));

    const { refreshCodexModels, getModelRegistry, invalidateModelRegistry, contextWindowForModel } = await import("../models.js");
    invalidateModelRegistry();
    const config = cfg(undefined, {
      codex: {
        default: "gpt-5.5",
        models: [{ id: "gpt-5.5", label: "Pinned GPT-5.5", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh"], contextWindow: 1050000 }],
      },
    });
    await refreshCodexModels(config);
    const entry = getModelRegistry(config).codex;

    expect(entry.defaultModel).toBe("gpt-5.5");
    expect(entry.models).toEqual([
      { id: "gpt-5.5", label: "Pinned GPT-5.5", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh"], contextWindow: 1050000 },
    ]);
    expect(contextWindowForModel(config, "codex", "gpt-5.5")).toBe(1050000);
  });
});
