import { describe, it, expect, beforeEach } from "vitest";
import type { CuttlefishConfig } from "../types.js";
import { registryAdvertisesModel, invalidateModelRegistry } from "../models.js";

/** Config with an operator-declared `models:` block — an authoritative registry. */
function declaredCfg(): CuttlefishConfig {
  return {
    gateway: { port: 8888, host: "127.0.0.1" },
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "opus" },
      codex: { bin: "codex", model: "gpt-5.5" },
    },
    models: {
      claude: {
        default: "opus",
        models: [
          { id: "opus", label: "Opus", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
          { id: "claude-haiku-4-5", label: "Haiku 4.5", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
        ],
      },
    },
    connectors: {},
  } as unknown as CuttlefishConfig;
}

/** Config with NO `models:` block — the registry is back-compat synthesis. */
function synthesizedCfg(): CuttlefishConfig {
  return {
    gateway: { port: 8888, host: "127.0.0.1" },
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "claude-fable-5" },
      codex: { bin: "codex", model: "gpt-5.4" },
    },
    connectors: {},
  } as unknown as CuttlefishConfig;
}

beforeEach(() => invalidateModelRegistry());

describe("registryAdvertisesModel", () => {
  it("rejects a model the declared registry does not list", () => {
    // The case this gate exists for: an upgraded install whose Claude registry
    // still carries only the `opus` alias must not have a fallback ladder
    // dispatch `--model claude-opus-5` at it.
    expect(registryAdvertisesModel(declaredCfg(), "claude", "claude-opus-5")).toBe(false);
  });

  it("accepts a model the declared registry lists", () => {
    expect(registryAdvertisesModel(declaredCfg(), "claude", "opus")).toBe(true);
    expect(registryAdvertisesModel(declaredCfg(), "claude", "claude-haiku-4-5")).toBe(true);
  });

  it("does not gate an engine the block omits, even when other engines declare one", () => {
    // `models.codex` is absent here, so codex rungs stay engine-only.
    expect(registryAdvertisesModel(declaredCfg(), "codex", "gpt-5.5")).toBe(true);
    expect(registryAdvertisesModel(declaredCfg(), "codex", "gpt-5.4-mini")).toBe(true);
  });

  it("does not gate at all when config declares no models: block", () => {
    // Regression guard. Without a block, getModelRegistry synthesizes exactly
    // ONE entry per engine from engines.<name>.model — a default, not a
    // capability list. Enforcing it would filter out every built-in ladder rung
    // except that one and strand configs that relied on engine-only fallback.
    const cfg = synthesizedCfg();
    expect(registryAdvertisesModel(cfg, "claude", "claude-fable-5")).toBe(true);
    expect(registryAdvertisesModel(cfg, "claude", "claude-opus-5")).toBe(true);
    expect(registryAdvertisesModel(cfg, "claude", "claude-sonnet-5")).toBe(true);
    expect(registryAdvertisesModel(cfg, "codex", "gpt-5.5")).toBe(true);
    expect(registryAdvertisesModel(cfg, "codex", "gpt-5.4")).toBe(true);
  });

  it("does not gate an engine with no registry entry at all", () => {
    expect(registryAdvertisesModel(declaredCfg(), "not-a-real-engine", "whatever")).toBe(true);
  });
});
