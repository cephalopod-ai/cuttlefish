import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CuttlefishConfig } from "../types.js";

const discoverOllamaModels = vi.fn();
const isInstalled = vi.fn();

vi.mock("../ollama-models.js", () => ({ discoverOllamaModels }));
vi.mock("../resolve-bin.js", async () => {
  const actual = await vi.importActual<typeof import("../resolve-bin.js")>("../resolve-bin.js");
  return { ...actual, isInstalled, resolveBin: vi.fn(() => "/usr/local/bin/ollama") };
});

function config(): CuttlefishConfig {
  return {
    gateway: { port: 8888, host: "127.0.0.1" },
    engines: {
      default: "ollama",
      claude: { bin: "claude", model: "opus" },
      codex: { bin: "codex", model: "gpt-5.6-sol" },
      ollama: { bin: "ollama", model: "gemma4" },
    },
    models: {
      ollama: {
        default: "gemma4",
        models: [{ id: "gemma4", label: "stale tag", supportsEffort: false, effortLevels: [] }],
      },
    },
    connectors: {},
    logging: { file: false, stdout: false, level: "info" },
  };
}

describe("Ollama model registry refresh", () => {
  beforeEach(() => {
    vi.resetModules();
    discoverOllamaModels.mockReset();
    isInstalled.mockImplementation((bin: string) => ["ollama", "claude", "codex"].includes(bin));
  });

  it("replaces a stale untagged pin with the exact locally installed tag", async () => {
    discoverOllamaModels.mockResolvedValue({
      models: [{ id: "gemma4:26b", label: "gemma4:26b", supportsEffort: false, effortLevels: [], contextWindow: 262144 }],
    });
    const { getModelRegistry, invalidateModelRegistry, refreshOllamaModels } = await import("../models.js");
    const cfg = config();
    invalidateModelRegistry();
    await refreshOllamaModels(cfg, { quiet: true });

    expect(getModelRegistry(cfg).ollama).toMatchObject({
      defaultModel: "gemma4:26b",
      models: [{ id: "gemma4:26b", contextWindow: 262144 }],
    });
  });
});
