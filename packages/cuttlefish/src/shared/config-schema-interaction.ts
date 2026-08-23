/**
 * Validation for the operator-facing interaction config sections: `portal`
 * identity and onboarding state, the `context` budget and manager mode, `stt`
 * speech-to-text settings, and `talk` mode with its Kokoro sidecar block.
 *
 * Extracted from `packages/cuttlefish/src/shared/config-schema.ts` in a
 * behavior-preserving modularization.
 */
import {
  isPlainObject,
  pushUnknownKeys,
  validateBoolean,
  validateNumber,
  validateString,
  validateStringArray,
} from "./config-schema-primitives.js";

export function validatePortal(problems: string[], value: unknown): void {
  if (!isPlainObject(value)) {
    problems.push("portal must be a mapping");
    return;
  }
  pushUnknownKeys(problems, value, ["portalName", "operatorName", "language", "onboarded", "setupComplete"], "portal");
  if (value.portalName !== undefined) validateString(problems, "portal.portalName", value.portalName);
  if (value.operatorName !== undefined) validateString(problems, "portal.operatorName", value.operatorName);
  if (value.language !== undefined) validateString(problems, "portal.language", value.language);
  if (value.onboarded !== undefined) validateBoolean(problems, "portal.onboarded", value.onboarded);
  if (value.setupComplete !== undefined) validateBoolean(problems, "portal.setupComplete", value.setupComplete);
}

export function validateContext(problems: string[], value: unknown): void {
  if (!isPlainObject(value)) {
    problems.push("context must be a mapping");
    return;
  }
  pushUnknownKeys(problems, value, ["maxChars", "managerMode"], "context");
  if (value.maxChars !== undefined) validateNumber(problems, "context.maxChars", value.maxChars);
  if (value.managerMode !== undefined) {
    if (typeof value.managerMode !== "string" || !["off", "shadow", "on"].includes(value.managerMode)) {
      problems.push("context.managerMode must be one of: off, shadow, on");
    }
  }
}

export function validateStt(problems: string[], value: unknown, path = "stt"): void {
  if (!isPlainObject(value)) {
    problems.push(`${path} must be a mapping`);
    return;
  }
  pushUnknownKeys(problems, value, ["enabled", "model", "language", "languages"], path);
  if (value.enabled !== undefined) validateBoolean(problems, `${path}.enabled`, value.enabled);
  if (value.model !== undefined) validateString(problems, `${path}.model`, value.model);
  if (value.language !== undefined) validateString(problems, `${path}.language`, value.language);
  if (value.languages !== undefined) validateStringArray(problems, `${path}.languages`, value.languages);
}

export function validateTalk(problems: string[], value: unknown): void {
  if (!isPlainObject(value)) {
    problems.push("talk must be a mapping");
    return;
  }
  pushUnknownKeys(problems, value, ["enabled", "engine", "orchestratorModel", "kokoro"], "talk");
  if (value.enabled !== undefined) validateBoolean(problems, "talk.enabled", value.enabled);
  if (value.engine !== undefined) validateString(problems, "talk.engine", value.engine);
  if (value.orchestratorModel !== undefined) validateString(problems, "talk.orchestratorModel", value.orchestratorModel);
  if (value.kokoro !== undefined) {
    if (!isPlainObject(value.kokoro)) {
      problems.push("talk.kokoro must be a mapping");
    } else {
      pushUnknownKeys(problems, value.kokoro, ["voice", "modelDir", "sidecarPort"], "talk.kokoro");
      if (value.kokoro.voice !== undefined) validateString(problems, "talk.kokoro.voice", value.kokoro.voice);
      if (value.kokoro.modelDir !== undefined) validateString(problems, "talk.kokoro.modelDir", value.kokoro.modelDir);
      if (value.kokoro.sidecarPort !== undefined) validateNumber(problems, "talk.kokoro.sidecarPort", value.kokoro.sidecarPort);
    }
  }
}
