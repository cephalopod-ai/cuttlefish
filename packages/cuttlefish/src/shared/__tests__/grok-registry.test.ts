import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CuttlefishConfig } from "../types.js";

const discoverGrokModels = vi.fn();
const isInstalled = vi.fn();

vi.mock("../grok-models.js", async () => {
  const actual = await vi.importActual<typeof import("../grok-models.js")>("../grok-models.js");
  return { ...actual, discoverGrokModels };
});

vi.mock("../resolve-bin.js", async () => {
  const actual = await vi.importActual<typeof import("../resolve-bin.js")>("../resolve-bin.js");
  return { ...actual, isInstalled, resolveBin: vi.fn(() => "/usr/local/bin/grok") };
});

function config(): CuttlefishConfig {
  return {
    gateway: { port: 8888, host: "127.0.0.1" },
    engines: {
      default: "grok",
      claude: { bin: "claude", model: "opus" },
      codex: { bin: "codex", model: "gpt-5.6-sol" },
      grok: { bin: "grok", model: "grok-build" },
    },
    models: {
      grok: {
        default: "grok-build",
        models: [
          { id: "grok-build", label: "stale", supportsEffort: true, effortLevels: ["high"] },
          { id: "grok-composer-2.5-fast", label: "removed", supportsEffort: true, effortLevels: ["high"] },
        ],
      },
    },
    connectors: {},
    logging: { file: false, stdout: false, level: "info" },
  };
}

describe("Grok model registry refresh", () => {
  beforeEach(() => {
    vi.resetModules();
    discoverGrokModels.mockReset();
    isInstalled.mockImplementation((bin: string) => ["grok", "claude", "codex"].includes(bin));
  });

  it("does not append stale configured ids omitted by live discovery", async () => {
    discoverGrokModels.mockResolvedValue({
      defaultModel: "grok-4.6",
      models: [
        { id: "grok-4.6", label: "Grok 4.6", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh", "max"] },
        { id: "grok-4.5", label: "Grok 4.5", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh", "max"] },
      ],
    });

    const { getModelRegistry, invalidateModelRegistry, refreshGrokModels } = await import("../models.js");
    const cfg = config();
    invalidateModelRegistry();
    await refreshGrokModels(cfg, { quiet: true });
    const entry = getModelRegistry(cfg).grok;

    expect(entry.defaultModel).toBe("grok-4.6");
    expect(entry.models.map((model) => model.id)).toEqual(["grok-4.6", "grok-4.5"]);
  });
});
