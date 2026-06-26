import { describe, expect, it } from "vitest";
import { knownGrokModels, parseGrokModels } from "../grok-models.js";

describe("parseGrokModels", () => {
  it("parses the default and available model rows from `grok models`", () => {
    const parsed = parseGrokModels(`
You are logged in with grok.com.

Default model: grok-build

Available models:
  * grok-build (default)
  - grok-composer-2.5-fast
`);

    expect(parsed.defaultModel).toBe("grok-build");
    expect(parsed.models.map((m) => m.id)).toEqual(["grok-build", "grok-composer-2.5-fast"]);
    expect(parsed.models.map((m) => m.label)).toEqual(["Grok Build", "Grok Composer 2.5 Fast"]);
    expect(parsed.models[0].supportsEffort).toBe(true);
    expect(parsed.models[0].effortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});

describe("knownGrokModels", () => {
  it("keeps the known Grok catalog available before dynamic discovery completes", () => {
    const known = knownGrokModels();
    expect(known.defaultModel).toBe("grok-build");
    expect(known.models.map((m) => m.id)).toEqual(["grok-build", "grok-composer-2.5-fast"]);
  });

  it("preserves an unknown pinned model as the default", () => {
    const known = knownGrokModels("custom-grok");
    expect(known.defaultModel).toBe("custom-grok");
    expect(known.models[0].id).toBe("custom-grok");
  });
});
