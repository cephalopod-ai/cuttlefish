import { describe, expect, it } from "vitest";
import { ANTIGRAVITY_DEFAULT_MODEL, knownAntigravityModels, parseAntigravityModels } from "../antigravity-models.js";

describe("parseAntigravityModels", () => {
  it("parses canonical ids and display labels from `agy models`", () => {
    const parsed = parseAntigravityModels(`
Fetching available models...
gemini-3.8-flash-high\tGemini 3.8 Flash (High)
gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)
claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)
`);

    expect(parsed.models).toEqual([
      { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)", supportsEffort: false, effortLevels: [] },
      { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)", supportsEffort: false, effortLevels: [] },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)", supportsEffort: false, effortLevels: [] },
    ]);
  });
});

describe("knownAntigravityModels", () => {
  it("uses Gemini 3.8 Flash Medium as the pre-discovery default catalog", () => {
    const known = knownAntigravityModels();
    expect(ANTIGRAVITY_DEFAULT_MODEL).toBe("gemini-3.8-flash-medium");
    expect(known.models.map((model) => model.id)).toContain(ANTIGRAVITY_DEFAULT_MODEL);
    expect(known.models.map((model) => model.id)).not.toContain("Gemini 3.5 Flash (Medium)");
  });
});
