/**
 * Validation for the `engines` and `models` config sections: per-engine binary,
 * model, and effort settings, plus the per-engine model registry used by the
 * model picker.
 *
 * Extracted from `packages/cuttlefish/src/shared/config-schema.ts` in a
 * behavior-preserving modularization. Both consumers of the local `ENGINE_NAMES`
 * membership set moved here together, so that set stays private to this module.
 * The facade calls `validateEngines` and `validateModels`.
 */
// NOTE: this file keeps its own ENGINE_NAMES Set (below) as the
// display/membership list for per-engine config keys; isKnownEngine is
// imported (not the models.js ENGINE_NAMES array) to avoid a second,
// differently-shaped copy of the same list in this file.
import { isKnownEngine } from "./models.js";
import {
  isPlainObject,
  pushUnknownKeys,
  validateBoolean,
  validateExecString,
  validateNumber,
  validateString,
  validateStringArray,
} from "./config-schema-primitives.js";

const ENGINE_NAMES = new Set(["claude", "codex", "antigravity", "grok", "pi", "kiro", "hermes", "ollama", "kilo", "aider", "vibe"]);


function validateEngineConfig(
  problems: string[],
  path: string,
  value: unknown,
  allowed: string[],
): Record<string, unknown> | null {
  if (value === undefined) return null;
  if (!isPlainObject(value)) {
    problems.push(`${path} must be a mapping`);
    return null;
  }
  pushUnknownKeys(problems, value, allowed, path);
  if (value.bin !== undefined) validateExecString(problems, `${path}.bin`, value.bin);
  if (value.model !== undefined) validateString(problems, `${path}.model`, value.model);
  if (value.effortLevel !== undefined) validateString(problems, `${path}.effortLevel`, value.effortLevel);
  if (value.childEffortOverride !== undefined) validateString(problems, `${path}.childEffortOverride`, value.childEffortOverride);
  return value;
}

export function validateEngines(
  problems: string[],
  value: unknown,
): void {
  if (!isPlainObject(value)) {
    problems.push("engines must be a mapping with at least an engines.claude entry");
    return;
  }
  pushUnknownKeys(problems, value, ["default", "claude", "codex", "antigravity", "grok", "pi", "kiro", "hermes", "ollama", "kilo", "aider", "vibe"], "engines");
  if (value.default !== undefined) {
    validateString(problems, "engines.default", value.default);
    // DFI-005: this used to only type-check engines.default as a string, so
    // an unknown engine value would pass shape validation and only fail (or
    // silently misbehave) much later at dispatch time.
    if (typeof value.default === "string" && !isKnownEngine(value.default)) {
      problems.push(`engines.default must be one of: ${[...ENGINE_NAMES].join(", ")} (got "${value.default}")`);
    }
  }
  if (value.claude === undefined) {
    problems.push("engines.claude must be a mapping");
  }
  validateEngineConfig(problems, "engines.claude", value.claude, ["bin", "model", "effortLevel", "childEffortOverride", "maxLivePtys"]);
  validateEngineConfig(problems, "engines.codex", value.codex, ["bin", "model", "effortLevel", "childEffortOverride"]);
  if (value.antigravity !== undefined) validateEngineConfig(problems, "engines.antigravity", value.antigravity, ["bin", "model", "effortLevel", "childEffortOverride"]);
  if (value.grok !== undefined) validateEngineConfig(problems, "engines.grok", value.grok, ["bin", "model", "effortLevel", "childEffortOverride"]);
  if (value.pi !== undefined) validateEngineConfig(problems, "engines.pi", value.pi, ["bin", "model", "effortLevel", "childEffortOverride"]);
  if (value.ollama !== undefined) validateEngineConfig(problems, "engines.ollama", value.ollama, ["bin", "model"]);
  if (value.kilo !== undefined) validateEngineConfig(problems, "engines.kilo", value.kilo, ["bin", "model", "effortLevel", "childEffortOverride"]);
  if (value.aider !== undefined) validateEngineConfig(problems, "engines.aider", value.aider, ["bin", "model"]);
  if (value.claude !== undefined && isPlainObject(value.claude) && value.claude.maxLivePtys !== undefined) {
    validateNumber(problems, "engines.claude.maxLivePtys", value.claude.maxLivePtys);
  }
  if (value.kiro !== undefined) {
    const kiro = validateEngineConfig(problems, "engines.kiro", value.kiro, [
      "bin",
      "model",
      "effortLevel",
      "childEffortOverride",
      "creditBudget",
      "billingAnchorDay",
    ]);
    if (kiro?.creditBudget !== undefined) validateNumber(problems, "engines.kiro.creditBudget", kiro.creditBudget);
    if (kiro?.billingAnchorDay !== undefined) validateNumber(problems, "engines.kiro.billingAnchorDay", kiro.billingAnchorDay);
  }
  if (value.hermes !== undefined) validateEngineConfig(problems, "engines.hermes", value.hermes, ["bin", "model"]);
  if (value.vibe !== undefined) validateEngineConfig(problems, "engines.vibe", value.vibe, ["bin", "model"]);
}

export function validateModels(
  problems: string[],
  value: unknown,
): void {
  if (!isPlainObject(value)) {
    problems.push("models must be a mapping");
    return;
  }
  for (const [engine, entry] of Object.entries(value)) {
    if (!ENGINE_NAMES.has(engine)) {
      problems.push(`unknown models config keys: ${engine}`);
      continue;
    }
    if (!isPlainObject(entry)) {
      problems.push(`models.${engine} must be a mapping`);
      continue;
    }
    pushUnknownKeys(problems, entry, ["default", "effortMechanism", "models"], `models.${engine}`);
    if (entry.default !== undefined) validateString(problems, `models.${engine}.default`, entry.default);
    if (entry.effortMechanism !== undefined) validateString(problems, `models.${engine}.effortMechanism`, entry.effortMechanism);
    if (!Array.isArray(entry.models)) {
      problems.push(`models.${engine}.models must be an array`);
      continue;
    }
    for (const [index, model] of entry.models.entries()) {
      if (!isPlainObject(model)) {
        problems.push(`models.${engine}.models[${index}] must be a mapping`);
        continue;
      }
      pushUnknownKeys(problems, model, ["id", "label", "supportsEffort", "effortLevels", "contextWindow"], `models.${engine}.models[${index}]`);
      if (typeof model.id !== "string" || !model.id.trim()) problems.push(`models.${engine}.models[${index}].id must be a non-empty string`);
      if (model.label !== undefined) validateString(problems, `models.${engine}.models[${index}].label`, model.label);
      if (model.supportsEffort !== undefined) validateBoolean(problems, `models.${engine}.models[${index}].supportsEffort`, model.supportsEffort);
      if (model.effortLevels !== undefined) validateStringArray(problems, `models.${engine}.models[${index}].effortLevels`, model.effortLevels);
      if (model.contextWindow !== undefined) validateNumber(problems, `models.${engine}.models[${index}].contextWindow`, model.contextWindow);
    }
  }
}
