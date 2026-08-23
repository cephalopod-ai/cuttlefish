/**
 * Validation for the scheduled-work config sections: the `boardWorker` idle
 * windows (including the HH:MM schedule format and IANA timezone check), the
 * `orchestration` runtime, and `cron` delivery defaults and alerting.
 *
 * Extracted from `packages/cuttlefish/src/shared/config-schema.ts` in a
 * behavior-preserving modularization. `TIME_OF_DAY_RE` has only one consumer and
 * moved here with it.
 */
import {
  isPlainObject,
  pushUnknownKeys,
  validateBoolean,
  validateNumber,
  validateString,
} from "./config-schema-primitives.js";

const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function validateBoardWorker(problems: string[], value: unknown): void {
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

export function validateOrchestration(problems: string[], value: unknown): void {
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

export function validateCron(problems: string[], value: unknown): void {
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
