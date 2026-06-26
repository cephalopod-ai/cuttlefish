// packages/cuttlefish/src/shared/__tests__/hermes-registry.test.ts
import { describe, it, expect } from "vitest";
import { buildRegistry } from "../models.js";

const cfg: any = {
  engines: { default: "claude", claude: { bin: "claude", model: "opus" }, hermes: { bin: "hermes", model: "openai-codex:gpt-5.5" } },
};

describe("hermes registry entry", () => {
  it("exists with effortMechanism none and a default model", () => {
    const reg = buildRegistry(cfg);
    expect(reg.hermes).toBeDefined();
    expect(reg.hermes.effortMechanism).toBe("none");
    expect(reg.hermes.defaultModel).toBeTruthy();
    expect(reg.hermes.models.every((m) => m.supportsEffort === false)).toBe(true);
  });
});
