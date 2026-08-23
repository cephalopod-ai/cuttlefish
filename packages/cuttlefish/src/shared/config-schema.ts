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

const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function validateBoardWorker(problems: string[], value: unknown): void {
  if (!isPlainObject(value)) {
    problems.push("boardWorker must be a mapping");
    return;
  }
  pushUnknownKeys(problems, value, ["enabled", "idleMinutes", "timezone", "schedule", "usage"], "boardWorker");
  if (value.enabled !== undefined) validateBoolean(problems, "boardWorker.enabled", value.enabled);
  if (value.idleMinutes !== undefined) validateNumber(problems, "boardWorker.idleMinutes", value.idleMinutes);
  if (value.timezone !== undefined) {
    if (typeof value.timezone !== "string") {
      problems.push(`boardWorker.timezone must be a string (got ${typeof value.timezone})`);
    } else {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: value.timezone });
      } catch {
        problems.push(`boardWorker.timezone must be a valid IANA timezone (got ${value.timezone})`);
      }
    }
  }
  if (value.schedule !== undefined) {
    if (!isPlainObject(value.schedule)) {
      problems.push("boardWorker.schedule must be a mapping");
    } else {
      pushUnknownKeys(problems, value.schedule, ["weekday", "weekend"], "boardWorker.schedule");
      for (const key of ["weekday", "weekend"] as const) {
        const window = value.schedule[key];
        if (window === undefined) continue;
        if (!isPlainObject(window)) {
          problems.push(`boardWorker.schedule.${key} must be a mapping`);
          continue;
        }
        pushUnknownKeys(problems, window, ["start", "end"], `boardWorker.schedule.${key}`);
        if (typeof window.start !== "string" || !TIME_OF_DAY_RE.test(window.start)) {
          problems.push(`boardWorker.schedule.${key}.start must be HH:MM`);
        }
        if (typeof window.end !== "string" || !TIME_OF_DAY_RE.test(window.end)) {
          problems.push(`boardWorker.schedule.${key}.end must be HH:MM`);
        }
      }
    }
  }
  if (value.usage !== undefined) {
    if (!isPlainObject(value.usage)) {
      problems.push("boardWorker.usage must be a mapping");
    } else {
      pushUnknownKeys(problems, value.usage, ["minRemainingPercent"], "boardWorker.usage");
      if (value.usage.minRemainingPercent !== undefined) {
        validateNumber(problems, "boardWorker.usage.minRemainingPercent", value.usage.minRemainingPercent);
      }
    }
  }
}

function validateOrchestration(problems: string[], value: unknown): void {
  if (!isPlainObject(value)) {
    problems.push("orchestration must be a mapping");
    return;
  }
  pushUnknownKeys(problems, value, [
    "enabled",
    "configDir",
    "dbPath",
    "leaseDurationMs",
    "reaperIntervalMs",
    "worktreeRoot",
    "maxWorktrees",
    "sameFamilyReviewerFallback",
    "empiricalRouting",
  ], "orchestration");
  if (value.enabled !== undefined) validateBoolean(problems, "orchestration.enabled", value.enabled);
  if (value.configDir !== undefined) validateString(problems, "orchestration.configDir", value.configDir);
  if (value.dbPath !== undefined) validateString(problems, "orchestration.dbPath", value.dbPath);
  if (value.leaseDurationMs !== undefined) validateNumber(problems, "orchestration.leaseDurationMs", value.leaseDurationMs);
  if (value.reaperIntervalMs !== undefined) validateNumber(problems, "orchestration.reaperIntervalMs", value.reaperIntervalMs);
  if (value.worktreeRoot !== undefined) validateString(problems, "orchestration.worktreeRoot", value.worktreeRoot);
  if (value.maxWorktrees !== undefined) validateNumber(problems, "orchestration.maxWorktrees", value.maxWorktrees);
  if (value.sameFamilyReviewerFallback !== undefined) {
    validateBoolean(problems, "orchestration.sameFamilyReviewerFallback", value.sameFamilyReviewerFallback);
  }
  if (value.empiricalRouting !== undefined) validateBoolean(problems, "orchestration.empiricalRouting", value.empiricalRouting);
}

function validateCron(problems: string[], value: unknown): void {
  if (!isPlainObject(value)) {
    problems.push("cron must be a mapping");
    return;
  }
  pushUnknownKeys(problems, value, ["defaultDelivery", "alertChannel", "alertConnector", "alertThresholdMs"], "cron");
  if (value.defaultDelivery !== undefined) {
    if (!isPlainObject(value.defaultDelivery)) {
      problems.push("cron.defaultDelivery must be a mapping");
    } else {
      pushUnknownKeys(problems, value.defaultDelivery, ["connector", "channel", "thread"], "cron.defaultDelivery");
      if (value.defaultDelivery.connector !== undefined) validateString(problems, "cron.defaultDelivery.connector", value.defaultDelivery.connector);
      if (value.defaultDelivery.channel !== undefined) validateString(problems, "cron.defaultDelivery.channel", value.defaultDelivery.channel);
      if (value.defaultDelivery.thread !== undefined) validateString(problems, "cron.defaultDelivery.thread", value.defaultDelivery.thread);
    }
  }
  if (value.alertChannel !== undefined) validateString(problems, "cron.alertChannel", value.alertChannel);
  if (value.alertConnector !== undefined) validateString(problems, "cron.alertConnector", value.alertConnector);
  if (value.alertThresholdMs !== undefined) validateNumber(problems, "cron.alertThresholdMs", value.alertThresholdMs);
}

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
