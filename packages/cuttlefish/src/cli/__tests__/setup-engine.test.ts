import { describe, expect, it } from "vitest";
import { selectSetupEngine, type SetupEngine } from "../setup-engine.js";

describe("selectSetupEngine", () => {
  it("uses the only verified engine for a fresh non-interactive setup", () => {
    expect(selectSetupEngine(["codex"])).toBe("codex");
  });

  it("preserves the established preference when more than one engine is usable", () => {
    expect(selectSetupEngine(["codex", "grok"])).toBe("codex");
  });

  it("retains the template fallback only when setup verifies no engine", () => {
    expect(selectSetupEngine([] as SetupEngine[])).toBe("claude");
  });
});
