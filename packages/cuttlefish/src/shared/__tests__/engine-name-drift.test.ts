/**
 * Drift guard for B-INV-001 / MOD-B-CS-01.
 *
 * `shared/models.ts` owns the canonical `ENGINE_NAMES` list. Before this guard,
 * `config-schema-engines.ts` re-declared the same eleven names as a private Set
 * and used it for the `models.<engine>` gate and for the `engines.default` error
 * text, while `engines.default` itself was gated by `isKnownEngine()` from
 * `models.ts`. Two lists that must agree, with nothing forcing them to: adding an
 * engine to `models.ts` alone would either reject a valid `models.<engine>` block
 * or tell an operator to use a value the validator would refuse.
 *
 * These cases pin the agreement through behavior, not through the internals: for
 * every canonical engine name, the config validator must accept the key, must
 * actually validate its body, and must accept it under `models`. Adding a name to
 * `ENGINE_NAMES` without wiring it into the schema fails here.
 */
import { describe, it, expect } from "vitest";
import { ENGINE_NAMES } from "../models.js";
import { validateConfigShape } from "../config-schema.js";

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gateway: { port: 8888, host: "127.0.0.1" },
    engines: { claude: { bin: "claude", model: "opus" } },
    logging: { file: true, stdout: true, level: "info" },
    ...overrides,
  };
}

describe("engine-name drift guard (B-INV-001)", () => {
  it.each(ENGINE_NAMES)("accepts engines.%s as a known per-engine config key", (engine) => {
    expect(validateConfigShape(baseConfig({
      engines: { claude: { bin: "claude", model: "opus" }, [engine]: { bin: engine, model: "m" } },
    }))).toEqual([]);
  });

  it.each(ENGINE_NAMES)("actually validates the engines.%s body rather than only allowing the key", (engine) => {
    // A key that is allowed but never routed to validateEngineConfig would pass
    // silently; every canonical engine must reject an unknown sub-key.
    expect(validateConfigShape(baseConfig({
      engines: {
        claude: { bin: "claude", model: "opus" },
        [engine]: { bin: engine, model: "m", notARealEngineOption: true },
      },
    }))).toEqual([expect.stringContaining(`unknown engines.${engine} config keys: notARealEngineOption`)]);
  });

  it.each(ENGINE_NAMES)("accepts %s as an engines.default value", (engine) => {
    const problems = validateConfigShape(baseConfig({
      engines: { default: engine, claude: { bin: "claude", model: "opus" }, [engine]: { bin: engine, model: "m" } },
    }));
    expect(problems).toEqual([]);
  });

  it.each(ENGINE_NAMES)("accepts a models.%s registry block", (engine) => {
    expect(validateConfigShape(baseConfig({
      models: { [engine]: { default: "m", models: [{ id: "m" }] } },
    }))).toEqual([]);
  });

  it("rejects an engines key that is not a canonical engine name", () => {
    expect(validateConfigShape(baseConfig({
      engines: { claude: { bin: "claude", model: "opus" }, notanengine: { bin: "x", model: "m" } },
    }))).toEqual([expect.stringContaining("unknown engines config keys: notanengine")]);
  });

  it("rejects a models key that is not a canonical engine name", () => {
    expect(validateConfigShape(baseConfig({
      models: { notanengine: { default: "m", models: [{ id: "m" }] } },
    }))).toEqual([expect.stringContaining("unknown models config keys: notanengine")]);
  });

  it("enumerates exactly the canonical engine names in the engines.default error", () => {
    // MOD-B-CS-01: the message used to come from the file-local Set while the
    // check came from models.ts, so the two could disagree about what is legal.
    const [message] = validateConfigShape(baseConfig({
      engines: { default: "not-a-real-engine", claude: { bin: "claude", model: "opus" } },
    }));
    expect(message).toBe(
      `engines.default must be one of: ${ENGINE_NAMES.join(", ")} (got "not-a-real-engine")`,
    );
  });
});
