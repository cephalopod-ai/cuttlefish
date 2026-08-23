/**
 * Validation for the `modelFallback` config section: the enable flag and default
 * mode, the global fallback chain, the per-failure-reason trigger map, handoff
 * summary options, and the return-to-primary policy.
 *
 * Extracted from `packages/cuttlefish/src/shared/config-schema.ts` in a
 * behavior-preserving modularization. The `FALLBACK_MODES`, `RETURN_POLICIES`,
 * and `ENGINE_FAILURE_REASONS` membership sets are used only by this section, so
 * they moved here with it. The facade calls `validateModelFallback`.
 */
import type { EngineFailureReason } from "./types.js";
import {
  isPlainObject,
  pushUnknownKeys,
  validateBoolean,
  validateNumber,
  validateString,
} from "./config-schema-primitives.js";

const FALLBACK_MODES = new Set(["auto", "ask_user", "never"]);
const RETURN_POLICIES = new Set(["ask_user", "auto", "never", "stay_on_fallback"]);
const ENGINE_FAILURE_REASONS = new Set<EngineFailureReason>([
  "rate_limit",
  "quota_exhausted",
  "engine_unavailable",
  "timeout",
  "auth_failure",
  "context_overflow",
  "unknown",
]);

function validateFallbackTarget(
  problems: string[],
  path: string,
  value: unknown,
): void {
  if (!isPlainObject(value)) {
    problems.push(`${path} must be a mapping`);
    return;
  }
  pushUnknownKeys(problems, value, ["engine", "model", "effortLevel", "employee", "reason"], path);
  if (typeof value.engine !== "string" || !value.engine.trim()) problems.push(`${path}.engine must be a non-empty string`);
  if (value.model !== undefined) validateString(problems, `${path}.model`, value.model);
  if (value.effortLevel !== undefined) validateString(problems, `${path}.effortLevel`, value.effortLevel);
  if (value.employee !== undefined) validateString(problems, `${path}.employee`, value.employee);
  if (value.reason !== undefined) validateString(problems, `${path}.reason`, value.reason);
}

export function validateModelFallback(
  problems: string[],
  value: unknown,
): void {
  if (!isPlainObject(value)) {
    problems.push("modelFallback must be a mapping");
    return;
  }
  pushUnknownKeys(problems, value, ["enabled", "defaultMode", "globalChain", "triggers", "handoff", "returnPolicy"], "modelFallback");
  if (value.enabled !== undefined) validateBoolean(problems, "modelFallback.enabled", value.enabled);
  if (value.defaultMode !== undefined) {
    if (typeof value.defaultMode !== "string" || !FALLBACK_MODES.has(value.defaultMode)) {
      problems.push("modelFallback.defaultMode must be one of: auto, ask_user, never");
    }
  }
  if (value.globalChain !== undefined) {
    if (!Array.isArray(value.globalChain)) {
      problems.push("modelFallback.globalChain must be an array");
    } else {
      value.globalChain.forEach((entry, index) => validateFallbackTarget(problems, `modelFallback.globalChain[${index}]`, entry));
    }
  }
  if (value.triggers !== undefined) {
    if (!isPlainObject(value.triggers)) {
      problems.push("modelFallback.triggers must be a mapping");
    } else {
      pushUnknownKeys(problems, value.triggers, ENGINE_FAILURE_REASONS, "modelFallback.triggers");
      for (const [reason, enabled] of Object.entries(value.triggers)) {
        if (!ENGINE_FAILURE_REASONS.has(reason as EngineFailureReason)) continue;
        validateBoolean(problems, `modelFallback.triggers.${reason}`, enabled);
      }
    }
  }
  if (value.handoff !== undefined) {
    if (!isPlainObject(value.handoff)) {
      problems.push("modelFallback.handoff must be a mapping");
    } else {
      pushUnknownKeys(problems, value.handoff, [
        "createSummary",
        "includeArtifacts",
        "includeLogs",
        "includeOpenQuestions",
        "includeRecentTranscriptTurns",
      ], "modelFallback.handoff");
      if (value.handoff.createSummary !== undefined) validateBoolean(problems, "modelFallback.handoff.createSummary", value.handoff.createSummary);
      if (value.handoff.includeArtifacts !== undefined) validateBoolean(problems, "modelFallback.handoff.includeArtifacts", value.handoff.includeArtifacts);
      if (value.handoff.includeLogs !== undefined) validateBoolean(problems, "modelFallback.handoff.includeLogs", value.handoff.includeLogs);
      if (value.handoff.includeOpenQuestions !== undefined) validateBoolean(problems, "modelFallback.handoff.includeOpenQuestions", value.handoff.includeOpenQuestions);
      if (value.handoff.includeRecentTranscriptTurns !== undefined) {
        validateNumber(problems, "modelFallback.handoff.includeRecentTranscriptTurns", value.handoff.includeRecentTranscriptTurns);
      }
    }
  }
  if (value.returnPolicy !== undefined) {
    if (!isPlainObject(value.returnPolicy)) {
      problems.push("modelFallback.returnPolicy must be a mapping");
    } else {
      pushUnknownKeys(problems, value.returnPolicy, ["whenPrimaryAvailable"], "modelFallback.returnPolicy");
      if (value.returnPolicy.whenPrimaryAvailable !== undefined) {
        if (typeof value.returnPolicy.whenPrimaryAvailable !== "string" || !RETURN_POLICIES.has(value.returnPolicy.whenPrimaryAvailable)) {
          problems.push("modelFallback.returnPolicy.whenPrimaryAvailable must be one of: ask_user, auto, never, stay_on_fallback");
        }
      }
    }
  }
}
