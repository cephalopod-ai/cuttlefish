import { validateKnowledge } from "./config-schema-knowledge.js";
import {
  isPlainObject,
  pushUnknownKeys,
  validateBoolean,
  validateExecString,
  validateNumber,
  validatePort,
  validateString,
  validateStringArray,
  validateStringOrStringArray,
} from "./config-schema-primitives.js";
import { validateAutonomousModeSingleton, validateWorkspaces } from "./config-schema-workspaces.js";
import { validateEngines, validateModels } from "./config-schema-engines.js";
import {
  validateConnectors,
  validateNotificationConnectorReference,
  validateNotifications,
} from "./config-schema-connectors.js";
import { validateEmail } from "./config-schema-email.js";
import { validateMcp } from "./config-schema-mcp.js";
import { validateModelFallback } from "./config-schema-model-fallback.js";
import {
  validateFeatures,
  validateGateway,
  validateLogging,
  validatePolicy,
  validateRemotes,
  validateSessions,
} from "./config-schema-runtime.js";
import {
  validateBoardWorker,
  validateCron,
  validateOrchestration,
} from "./config-schema-scheduling.js";

function validatePortal(problems: string[], value: unknown): void {
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

function validateContext(problems: string[], value: unknown): void {
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

function validateStt(problems: string[], value: unknown, path = "stt"): void {
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

function validateTalk(problems: string[], value: unknown): void {
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

export function validateConfigShape(config: unknown): string[] {
  if (config === null || config === undefined) {
    return ["file is empty or parsed to null — expected a YAML mapping"];
  }
  if (typeof config !== "object" || Array.isArray(config)) {
    return [`expected a YAML mapping, got ${Array.isArray(config) ? "an array" : typeof config}`];
  }

  const problems: string[] = [];
  const c = config as Record<string, unknown>;

  pushUnknownKeys(problems, c, [
    "cuttlefish",
    "workspaces",
    "gateway",
    "engines",
    "models",
    "connectors",
    "email",
    "logging",
    "mcp",
    "modelFallback",
    "orchestration",
    "sessions",
    "features",
    "boardWorker",
    "cron",
    "notifications",
    "portal",
    "context",
    "stt",
    "talk",
    "knowledge",
    "remotes",
    "policy",
  ], "config");

  if (c.cuttlefish !== undefined) {
    if (!isPlainObject(c.cuttlefish)) {
      problems.push("cuttlefish must be a mapping");
    } else {
      pushUnknownKeys(problems, c.cuttlefish, ["version"], "cuttlefish");
      if (c.cuttlefish.version !== undefined) validateString(problems, "cuttlefish.version", c.cuttlefish.version);
    }
  }
  if (c.workspaces !== undefined) {
    validateWorkspaces(problems, c.workspaces);
    validateAutonomousModeSingleton(problems, c.workspaces);
  }
  if (c.gateway !== undefined) validateGateway(problems, c.gateway);
  validateEngines(problems, c.engines);
  if (c.models !== undefined) validateModels(problems, c.models);
  if (c.connectors !== undefined) validateConnectors(problems, c.connectors);
  if (c.email !== undefined) validateEmail(problems, c.email);
  if (c.logging !== undefined) validateLogging(problems, c.logging);
  if (c.mcp !== undefined) validateMcp(problems, c.mcp);
  if (c.modelFallback !== undefined) validateModelFallback(problems, c.modelFallback);
  if (c.orchestration !== undefined) validateOrchestration(problems, c.orchestration);
  if (c.sessions !== undefined) validateSessions(problems, c.sessions);
  if (c.features !== undefined) validateFeatures(problems, c.features);
  if (c.boardWorker !== undefined) validateBoardWorker(problems, c.boardWorker);
  if (c.cron !== undefined) validateCron(problems, c.cron);
  if (c.notifications !== undefined) validateNotifications(problems, c.notifications);
  if (c.portal !== undefined) validatePortal(problems, c.portal);
  if (c.context !== undefined) validateContext(problems, c.context);
  if (c.stt !== undefined) validateStt(problems, c.stt);
  if (c.talk !== undefined) validateTalk(problems, c.talk);
  if (c.knowledge !== undefined) validateKnowledge(problems, c.knowledge, { pushUnknownKeys, validateString, validateNumber });
  if (c.remotes !== undefined) validateRemotes(problems, c.remotes);
  if (c.policy !== undefined) validatePolicy(problems, c.policy);
  validateNotificationConnectorReference(problems, c);

  return problems;
}
