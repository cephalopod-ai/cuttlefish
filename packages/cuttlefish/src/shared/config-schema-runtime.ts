/**
 * Validation for the daemon's own runtime surface: the `gateway` HTTP server and
 * its auth/file-access switches, `logging` sinks and rotation, `sessions` run
 * limits, the `features` flags, the `policy` directory, and the `remotes`
 * registry of peer Cuttlefish instances.
 *
 * Extracted from `packages/cuttlefish/src/shared/config-schema.ts` in a
 * behavior-preserving modularization. These sections are grouped by what they
 * configure — the local daemon process — rather than by any shared helper.
 */
import {
  isPlainObject,
  pushUnknownKeys,
  validateBoolean,
  validateNumber,
  validatePort,
  validateString,
  validateStringArray,
  validateStringOrStringArray,
} from "./config-schema-primitives.js";

export function validateGateway(problems: string[], value: unknown): void {
  if (!isPlainObject(value)) {
    problems.push("gateway must be a mapping");
    return;
  }
  pushUnknownKeys(problems, value, [
    "port",
    "host",
    "streaming",
    "turnStallInactivityMs",
    "turnStallLeaderCheckMs",
    "leaderAckTimeoutMs",
    "leaderAckMaxEscalations",
    "turnStallCeilingMs",
    "turnStallRetries",
    "allowFileCustomPaths",
    "allowFileOpen",
    "authRequired",
    "authDisabled",
    "insecureAllowUnauthenticatedNetwork",
    "fileReadRoots",
    "allowArbitraryFileRead",
    "exposeResolvedFilePaths",
    "userHeader",
  ], "gateway");
  if (value.port !== undefined) validatePort(problems, "gateway.port", value.port);
  if (value.host !== undefined) validateString(problems, "gateway.host", value.host);
  if (value.streaming !== undefined) validateBoolean(problems, "gateway.streaming", value.streaming);
  if (value.turnStallInactivityMs !== undefined) validateNumber(problems, "gateway.turnStallInactivityMs", value.turnStallInactivityMs);
  if (value.turnStallLeaderCheckMs !== undefined) validateNumber(problems, "gateway.turnStallLeaderCheckMs", value.turnStallLeaderCheckMs);
  if (value.leaderAckTimeoutMs !== undefined) validateNumber(problems, "gateway.leaderAckTimeoutMs", value.leaderAckTimeoutMs);
  if (value.leaderAckMaxEscalations !== undefined) validateNumber(problems, "gateway.leaderAckMaxEscalations", value.leaderAckMaxEscalations);
  if (value.turnStallCeilingMs !== undefined) validateNumber(problems, "gateway.turnStallCeilingMs", value.turnStallCeilingMs);
  if (value.turnStallRetries !== undefined) validateNumber(problems, "gateway.turnStallRetries", value.turnStallRetries);
  if (value.allowFileCustomPaths !== undefined) validateBoolean(problems, "gateway.allowFileCustomPaths", value.allowFileCustomPaths);
  if (value.allowFileOpen !== undefined) validateBoolean(problems, "gateway.allowFileOpen", value.allowFileOpen);
  if (value.authRequired !== undefined) validateBoolean(problems, "gateway.authRequired", value.authRequired);
  if (value.authDisabled !== undefined) validateBoolean(problems, "gateway.authDisabled", value.authDisabled);
  if (value.insecureAllowUnauthenticatedNetwork !== undefined) validateBoolean(problems, "gateway.insecureAllowUnauthenticatedNetwork", value.insecureAllowUnauthenticatedNetwork);
  if (value.fileReadRoots !== undefined) validateStringArray(problems, "gateway.fileReadRoots", value.fileReadRoots);
  if (value.allowArbitraryFileRead !== undefined) validateBoolean(problems, "gateway.allowArbitraryFileRead", value.allowArbitraryFileRead);
  if (value.exposeResolvedFilePaths !== undefined) validateBoolean(problems, "gateway.exposeResolvedFilePaths", value.exposeResolvedFilePaths);
  if (value.userHeader !== undefined) validateStringOrStringArray(problems, "gateway.userHeader", value.userHeader);
}

export function validateLogging(
  problems: string[],
  value: unknown,
): void {
  if (!isPlainObject(value)) {
    problems.push("logging must be a mapping");
    return;
  }
  pushUnknownKeys(problems, value, ["file", "stdout", "level", "maxSizeBytes", "maxFiles"], "logging");
  if (value.file !== undefined) validateBoolean(problems, "logging.file", value.file);
  if (value.stdout !== undefined) validateBoolean(problems, "logging.stdout", value.stdout);
  if (value.level !== undefined) validateString(problems, "logging.level", value.level);
  if (value.maxSizeBytes !== undefined) validateNumber(problems, "logging.maxSizeBytes", value.maxSizeBytes);
  if (value.maxFiles !== undefined) validateNumber(problems, "logging.maxFiles", value.maxFiles);
}

export function validateSessions(
  problems: string[],
  value: unknown,
): void {
  if (!isPlainObject(value)) {
    problems.push("sessions must be a mapping");
    return;
  }
  pushUnknownKeys(problems, value, ["maxDurationMinutes", "maxCostUsd", "interruptOnNewMessage", "rateLimitStrategy", "fallbackEngine", "autoResumeOnBoot", "maxConcurrentRuns"], "sessions");
  if (value.maxDurationMinutes !== undefined) validateNumber(problems, "sessions.maxDurationMinutes", value.maxDurationMinutes);
  if (value.maxCostUsd !== undefined) validateNumber(problems, "sessions.maxCostUsd", value.maxCostUsd);
  if (value.interruptOnNewMessage !== undefined) validateBoolean(problems, "sessions.interruptOnNewMessage", value.interruptOnNewMessage);
  if (value.rateLimitStrategy !== undefined) validateString(problems, "sessions.rateLimitStrategy", value.rateLimitStrategy);
  if (value.fallbackEngine !== undefined) validateString(problems, "sessions.fallbackEngine", value.fallbackEngine);
  if (value.autoResumeOnBoot !== undefined) validateBoolean(problems, "sessions.autoResumeOnBoot", value.autoResumeOnBoot);
  if (value.maxConcurrentRuns !== undefined) validateNumber(problems, "sessions.maxConcurrentRuns", value.maxConcurrentRuns);
}

export function validateFeatures(problems: string[], value: unknown): void {
  if (!isPlainObject(value)) {
    problems.push("features must be a mapping");
    return;
  }
  pushUnknownKeys(problems, value, ["multiRoleEmployeeExecution", "autonomousMode"], "features");
  if (value.multiRoleEmployeeExecution !== undefined) {
    validateBoolean(problems, "features.multiRoleEmployeeExecution", value.multiRoleEmployeeExecution);
  }
  if (value.autonomousMode !== undefined) {
    validateBoolean(problems, "features.autonomousMode", value.autonomousMode);
  }
}


export function validatePolicy(problems: string[], value: unknown): void {
  if (!isPlainObject(value)) {
    problems.push("policy must be a mapping");
    return;
  }
  pushUnknownKeys(problems, value, ["dir"], "policy");
  if (value.dir !== undefined) validateString(problems, "policy.dir", value.dir);
}

export function validateRemotes(problems: string[], value: unknown): void {
  if (!isPlainObject(value)) {
    problems.push("remotes must be a mapping");
    return;
  }
  for (const [name, remote] of Object.entries(value)) {
    if (!isPlainObject(remote)) {
      problems.push(`remotes.${name} must be a mapping`);
      continue;
    }
    pushUnknownKeys(problems, remote, ["url", "label", "token"], `remotes.${name}`);
    if (remote.url === undefined) {
      problems.push(`remotes.${name}.url is required`);
    } else {
      validateString(problems, `remotes.${name}.url`, remote.url);
    }
    if (remote.label !== undefined) validateString(problems, `remotes.${name}.label`, remote.label);
    if (remote.token !== undefined) validateString(problems, `remotes.${name}.token`, remote.token);
  }
}
