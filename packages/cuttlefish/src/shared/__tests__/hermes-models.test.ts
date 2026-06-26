import { describe, it, expect } from "vitest";
import { parseHermesModels, knownHermesModels } from "../hermes-models.js";

const NEW_SESSION = {
  sessionId: "abc",
  models: {
    currentModelId: "openai-codex:gpt-5.5",
    availableModels: [
      { modelId: "openai-codex:gpt-5.5", name: "gpt-5.5", description: "Provider: OpenAI Codex • current" },
      { modelId: "openai-codex:gpt-5.4", name: "gpt-5.4", description: "Provider: OpenAI Codex" },
    ],
  },
};

describe("parseHermesModels", () => {
  it("extracts models + default from a session/new result", () => {
    const r = parseHermesModels(NEW_SESSION);
    expect(r.defaultModel).toBe("openai-codex:gpt-5.5");
    expect(r.models.map((m) => m.id)).toEqual(["openai-codex:gpt-5.5", "openai-codex:gpt-5.4"]);
    expect(r.models[0]).toMatchObject({ id: "openai-codex:gpt-5.5", label: "gpt-5.5", supportsEffort: false, effortLevels: [] });
  });
  it("returns empty discovery when models block is absent", () => {
    expect(parseHermesModels({ sessionId: "x" })).toEqual({ defaultModel: undefined, models: [] });
  });
});

describe("knownHermesModels", () => {
  it("provides a non-empty static fallback and honors a pinned id", () => {
    const r = knownHermesModels("openai-codex:gpt-5.4");
    expect(r.defaultModel).toBe("openai-codex:gpt-5.4");
    expect(r.models.length).toBeGreaterThan(0);
    expect(r.models.every((m) => m.supportsEffort === false)).toBe(true);
  });
});
