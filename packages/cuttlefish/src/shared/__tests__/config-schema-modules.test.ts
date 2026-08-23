/**
 * Structural regression cover for the config-schema module split.
 *
 * `config-schema.ts` is a compatibility facade: it owns `validateConfigShape`
 * and nothing else, and delegates one config section per sibling module. Two
 * things can silently break that arrangement — the public export path changing,
 * and a section being dropped from the facade's dispatch list while its module
 * still compiles. These tests pin both against behavior, not internals: each
 * case feeds a section-shaped bad value through the facade and asserts it
 * reports exactly what that section's own validator reports.
 */
import { describe, it, expect } from "vitest";
import { validateConfigShape } from "../config-schema.js";
import { validateConfigShape as validateViaConfig } from "../config.js";
import { validateConnectors, validateNotifications } from "../config-schema-connectors.js";
import { validateEmail } from "../config-schema-email.js";
import { validateEngines, validateModels } from "../config-schema-engines.js";
import { validateContext, validatePortal, validateStt, validateTalk } from "../config-schema-interaction.js";
import { validateMcp } from "../config-schema-mcp.js";
import { validateModelFallback } from "../config-schema-model-fallback.js";
import {
  validateFeatures,
  validateGateway,
  validateLogging,
  validatePolicy,
  validateRemotes,
  validateSessions,
} from "../config-schema-runtime.js";
import { validateBoardWorker, validateCron, validateOrchestration } from "../config-schema-scheduling.js";
import { validateWorkspaces } from "../config-schema-workspaces.js";

type SectionValidator = (problems: string[], value: unknown) => void;

/** Every top-level section, its owning module's validator, and a value of the
 *  wrong shape for it. `engines` is omitted: the facade calls it unconditionally
 *  (a missing `engines` block is itself an error), so it is covered separately. */
const SECTIONS: Array<[string, SectionValidator]> = [
  ["workspaces", validateWorkspaces],
  ["gateway", validateGateway],
  ["models", validateModels],
  ["connectors", validateConnectors],
  ["email", validateEmail],
  ["logging", validateLogging],
  ["mcp", validateMcp],
  ["modelFallback", validateModelFallback],
  ["orchestration", validateOrchestration],
  ["sessions", validateSessions],
  ["features", validateFeatures],
  ["boardWorker", validateBoardWorker],
  ["cron", validateCron],
  ["notifications", validateNotifications],
  ["portal", validatePortal],
  ["context", validateContext],
  ["stt", validateStt],
  ["talk", validateTalk],
  ["remotes", validateRemotes],
  ["policy", validatePolicy],
];

const validEngines = { engines: { claude: { bin: "claude", model: "opus" } } };

describe("config-schema facade", () => {
  it("is the only public export path, and shared/config.ts re-exports the same function", () => {
    expect(validateViaConfig).toBe(validateConfigShape);
  });

  it("accepts a minimal valid config", () => {
    expect(validateConfigShape(validEngines)).toEqual([]);
  });

  it("still reports the engines section, which it validates unconditionally", () => {
    const direct: string[] = [];
    validateEngines(direct, undefined);
    expect(validateConfigShape({})).toEqual(direct);
  });

  it.each(SECTIONS)("routes the %s section to its own module's validator", (key, validator) => {
    const direct: string[] = [];
    validator(direct, "not-a-mapping");
    expect(direct.length).toBeGreaterThan(0);
    expect(validateConfigShape({ ...validEngines, [key]: "not-a-mapping" })).toEqual(direct);
  });

  it("still runs the notifications/connector cross-check, which no single section owns", () => {
    expect(
      validateConfigShape({ ...validEngines, notifications: { channel: "#ops" } }),
    ).toEqual([
      'notifications.connector must reference a configured connector; got "slack" (no supported connectors are configured)',
    ]);
  });
});
