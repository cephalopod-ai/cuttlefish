import { describe, expect, it } from "vitest";
import { modelInfoFromOllamaShow, parseOllamaList } from "../ollama-models.js";

describe("parseOllamaList", () => {
  it("returns exact installed tags from the NAME column", () => {
    expect(parseOllamaList(`
NAME                  ID              SIZE      MODIFIED
gemma4:26b            5571076f3d70    17 GB     4 weeks ago
qwen3-embedding:8b    64b933495768    4.7 GB    4 weeks ago
`)).toEqual(["gemma4:26b", "qwen3-embedding:8b"]);
  });
});

describe("modelInfoFromOllamaShow", () => {
  it("keeps completion models and carries their context length", () => {
    expect(modelInfoFromOllamaShow("gemma4:26b", `
  Model
    context length      262144

  Capabilities
    completion
    vision
    tools

  Parameters
    temperature 1
`)).toEqual({
      id: "gemma4:26b",
      label: "gemma4:26b",
      supportsEffort: false,
      effortLevels: [],
      contextWindow: 262144,
    });
  });

  it("excludes embedding-only models from chat selectors", () => {
    expect(modelInfoFromOllamaShow("qwen3-embedding:8b", `
  Capabilities
    tools
    embedding
`)).toBeNull();
  });
});
