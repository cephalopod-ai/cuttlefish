import { describe, it, expect, beforeEach } from "vitest";
import { resolveEffort } from "../effort.js";
import { effortLevelsForModel, invalidateModelRegistry } from "../models.js";
import type { CuttlefishConfig } from "../types.js";

const CLAUDE = ["low", "medium", "high"];
const CODEX = ["low", "medium", "high", "xhigh"];

describe("resolveEffort (registry-driven validation)", () => {
  it("passes through codex xhigh (the previously silently-dropped level)", () => {
    expect(resolveEffort({}, { parentSessionId: "p", effortLevel: "xhigh" }, null, CODEX)).toBe("xhigh");
  });

  it("rejects xhigh for claude (not in its levels) and falls back to medium", () => {
    expect(resolveEffort({}, { parentSessionId: "p", effortLevel: "xhigh" }, null, CLAUDE)).toBe("medium");
  });

  it("claude still accepts low/medium/high", () => {
    expect(resolveEffort({}, { parentSessionId: "p", effortLevel: "low" }, null, CLAUDE)).toBe("low");
    expect(resolveEffort({}, { parentSessionId: "p", effortLevel: "high" }, null, CLAUDE)).toBe("high");
  });

  it("drops an unknown level and defaults (graceful degradation, no throw)", () => {
    expect(resolveEffort({ effortLevel: "ultra" }, { parentSessionId: null, effortLevel: null }, null, CLAUDE)).toBe("medium");
  });

  it("returns medium without warning when the engine has no effort concept (empty levels)", () => {
    expect(resolveEffort({ effortLevel: "high" }, { parentSessionId: "p", effortLevel: "high" }, null, [])).toBe("medium");
  });

  describe("child-effort resolution chain", () => {
    it("childEffortOverride wins over everything", () => {
      expect(resolveEffort(
        { childEffortOverride: "low" },
        { parentSessionId: "p", effortLevel: "high" },
        { effortLevel: "medium" },
        CLAUDE,
      )).toBe("low");
    });
    it("session beats employee", () => {
      expect(resolveEffort({}, { parentSessionId: "p", effortLevel: "high" }, { effortLevel: "low" }, CLAUDE)).toBe("high");
    });
    it("employee default when no session level", () => {
      expect(resolveEffort({}, { parentSessionId: "p", effortLevel: null }, { effortLevel: "low" }, CLAUDE)).toBe("low");
    });
    it("skips an invalid override and continues down the chain", () => {
      expect(resolveEffort(
        { childEffortOverride: "ultra" },
        { parentSessionId: "p", effortLevel: "high" },
        null,
        CLAUDE,
      )).toBe("high");
    });
  });

  it("non-child sessions use explicit session effort before the engine default", () => {
    expect(resolveEffort({ effortLevel: "high" }, { parentSessionId: null, effortLevel: "low" }, { effortLevel: "low" }, CLAUDE)).toBe("low");
  });

  it("non-child assigned sessions use employee default before the engine default", () => {
    expect(resolveEffort({ effortLevel: "high" }, { parentSessionId: null, effortLevel: null }, { effortLevel: "low" }, CLAUDE)).toBe("low");
  });

  it("non-child sessions fall back to engine default when no session or employee effort is set", () => {
    expect(resolveEffort({ effortLevel: "high" }, { parentSessionId: null, effortLevel: null }, null, CLAUDE)).toBe("high");
  });

  it('treats "default" as unset without warning through the resolution chain', () => {
    expect(resolveEffort(
      { effortLevel: "default", childEffortOverride: "default" },
      { parentSessionId: "p", effortLevel: "default" },
      { effortLevel: "default" },
      CLAUDE,
    )).toBe("medium");
  });
});

describe("effortLevelsForModel (registry lookup)", () => {
  function cfg(): CuttlefishConfig {
    return {
      gateway: { port: 8888, host: "127.0.0.1" },
      engines: {
        default: "claude",
        claude: { bin: "claude", model: "opus" },
        codex: { bin: "codex", model: "gpt-5.4" },
        antigravity: { model: "gemini-3-flash-preview" },
      },
      models: {
        claude: { default: "opus", models: [{ id: "opus", supportsEffort: true, effortLevels: CLAUDE }] },
        codex: { default: "gpt-5.4", models: [{ id: "gpt-5.4", supportsEffort: true, effortLevels: CODEX }] },
        antigravity: { models: [{ id: "gemini-3-flash-preview", supportsEffort: false, effortLevels: [] }] },
      },
      connectors: {},
    } as unknown as CuttlefishConfig;
  }
  beforeEach(() => invalidateModelRegistry());

  it("returns codex levels including xhigh", () => {
    expect(effortLevelsForModel(cfg(), "codex")).toContain("xhigh");
  });
  it("returns [] for antigravity (no effort support)", () => {
    expect(effortLevelsForModel(cfg(), "antigravity")).toEqual([]);
  });
  it("returns [] for an unknown engine", () => {
    expect(effortLevelsForModel(cfg(), "nope")).toEqual([]);
  });
  it("returns claude levels for its default model", () => {
    expect(effortLevelsForModel(cfg(), "claude")).toEqual(CLAUDE);
  });
});
