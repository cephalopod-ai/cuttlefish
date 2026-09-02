import net from "node:net";
import {
  isPlainObject,
  pushUnknownKeys,
  validateBoolean,
  validateNumber,
  validateString,
  validateStringArray,
} from "./config-schema-primitives.js";
import { isPrivateAddress } from "./ssrf-guard.js";

const CLIENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isLocalDevelopmentHttpUrl(parsed: URL): boolean {
  if (parsed.protocol !== "http:") return false;
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return hostname === "localhost"
    || hostname.endsWith(".localhost")
    || (net.isIP(hostname) > 0 && isPrivateAddress(hostname));
}

export function validateA2A(problems: string[], value: unknown): void {
  if (!isPlainObject(value)) {
    problems.push("a2a must be a mapping");
    return;
  }
  pushUnknownKeys(problems, value, [
    "enabled",
    "publicUrl",
    "allowedServices",
    "clients",
    "destinations",
    "maxInputBytes",
    "maxArtifactBytes",
    "pollIntervalMs",
  ], "a2a");
  if (value.enabled !== undefined) validateBoolean(problems, "a2a.enabled", value.enabled);
  if (value.publicUrl !== undefined) {
    validateString(problems, "a2a.publicUrl", value.publicUrl);
    if (typeof value.publicUrl === "string") {
      try {
        const parsed = new URL(value.publicUrl);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          problems.push("a2a.publicUrl must use http or https");
        }
        if (parsed.username || parsed.password) problems.push("a2a.publicUrl must not contain credentials");
      } catch {
        problems.push("a2a.publicUrl must be an absolute URL");
      }
    }
  }
  if (value.allowedServices !== undefined) validateStringArray(problems, "a2a.allowedServices", value.allowedServices);
  if (value.maxInputBytes !== undefined) {
    validateNumber(problems, "a2a.maxInputBytes", value.maxInputBytes);
    if (typeof value.maxInputBytes === "number" && (value.maxInputBytes < 1024 || value.maxInputBytes > 1024 * 1024)) {
      problems.push("a2a.maxInputBytes must be between 1024 and 1048576");
    }
  }
  if (value.maxArtifactBytes !== undefined) {
    validateNumber(problems, "a2a.maxArtifactBytes", value.maxArtifactBytes);
    if (typeof value.maxArtifactBytes === "number" && (value.maxArtifactBytes < 1024 || value.maxArtifactBytes > 50 * 1024 * 1024)) {
      problems.push("a2a.maxArtifactBytes must be between 1024 and 52428800");
    }
  }
  if (value.pollIntervalMs !== undefined) {
    validateNumber(problems, "a2a.pollIntervalMs", value.pollIntervalMs);
    if (typeof value.pollIntervalMs === "number" && (value.pollIntervalMs < 50 || value.pollIntervalMs > 10_000)) {
      problems.push("a2a.pollIntervalMs must be between 50 and 10000");
    }
  }
  if (value.clients !== undefined && !Array.isArray(value.clients)) {
    problems.push("a2a.clients must be an array");
  }
  const ids = new Set<string>();
  const tokens = new Set<string>();
  for (const [index, rawClient] of (Array.isArray(value.clients) ? value.clients : []).entries()) {
    const at = `a2a.clients[${index}]`;
    if (!isPlainObject(rawClient)) {
      problems.push(`${at} must be a mapping`);
      continue;
    }
    pushUnknownKeys(problems, rawClient, ["id", "token", "allowedServices"], at);
    validateString(problems, `${at}.id`, rawClient.id);
    validateString(problems, `${at}.token`, rawClient.token);
    if (typeof rawClient.id === "string") {
      if (!CLIENT_ID_RE.test(rawClient.id)) problems.push(`${at}.id has an invalid format`);
      if (ids.has(rawClient.id)) problems.push(`${at}.id duplicates another A2A client id`);
      ids.add(rawClient.id);
    }
    if (typeof rawClient.token === "string") {
      if (rawClient.token.length < 16) problems.push(`${at}.token must contain at least 16 characters`);
      if (tokens.has(rawClient.token)) problems.push(`${at}.token duplicates another A2A client token`);
      tokens.add(rawClient.token);
    }
    if (rawClient.allowedServices !== undefined) {
      validateStringArray(problems, `${at}.allowedServices`, rawClient.allowedServices);
    }
  }
  if (value.destinations !== undefined && !Array.isArray(value.destinations)) {
    problems.push("a2a.destinations must be an array");
  }
  const destinationIds = new Set<string>();
  const externalServiceNames = new Set<string>();
  for (const [index, rawDestination] of (Array.isArray(value.destinations) ? value.destinations : []).entries()) {
    const at = `a2a.destinations[${index}]`;
    if (!isPlainObject(rawDestination)) {
      problems.push(`${at} must be a mapping`);
      continue;
    }
    pushUnknownKeys(problems, rawDestination, [
      "id",
      "agentCardUrl",
      "token",
      "credentialType",
      "allowedSkills",
      "services",
      "allowedOrigins",
      "allowPrivateHosts",
      "timeoutMs",
    ], at);
    validateString(problems, `${at}.id`, rawDestination.id);
    validateString(problems, `${at}.agentCardUrl`, rawDestination.agentCardUrl);
    validateString(problems, `${at}.token`, rawDestination.token);
    if (rawDestination.credentialType !== undefined) {
      validateString(problems, `${at}.credentialType`, rawDestination.credentialType);
      if (rawDestination.credentialType !== "bearer" && rawDestination.credentialType !== "x-api-key") {
        problems.push(`${at}.credentialType must be bearer or x-api-key`);
      }
    }
    validateStringArray(problems, `${at}.allowedSkills`, rawDestination.allowedSkills);
    if (rawDestination.services !== undefined && !Array.isArray(rawDestination.services)) {
      problems.push(`${at}.services must be an array`);
    }
    if (rawDestination.allowedOrigins !== undefined) {
      validateStringArray(problems, `${at}.allowedOrigins`, rawDestination.allowedOrigins);
    }
    if (rawDestination.allowPrivateHosts !== undefined) {
      validateBoolean(problems, `${at}.allowPrivateHosts`, rawDestination.allowPrivateHosts);
    }
    if (rawDestination.timeoutMs !== undefined) {
      validateNumber(problems, `${at}.timeoutMs`, rawDestination.timeoutMs);
      if (typeof rawDestination.timeoutMs === "number" && (rawDestination.timeoutMs < 1000 || rawDestination.timeoutMs > 600_000)) {
        problems.push(`${at}.timeoutMs must be between 1000 and 600000`);
      }
    }
    if (typeof rawDestination.id === "string") {
      if (!CLIENT_ID_RE.test(rawDestination.id)) problems.push(`${at}.id has an invalid format`);
      if (destinationIds.has(rawDestination.id)) problems.push(`${at}.id duplicates another A2A destination id`);
      destinationIds.add(rawDestination.id);
    }
    if (typeof rawDestination.agentCardUrl === "string") {
      try {
        const parsed = new URL(rawDestination.agentCardUrl);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") problems.push(`${at}.agentCardUrl must use http or https`);
        if (parsed.protocol === "http:" && (rawDestination.allowPrivateHosts !== true || !isLocalDevelopmentHttpUrl(parsed))) {
          problems.push(`${at}.agentCardUrl must use https except for an explicitly enabled local-development HTTP peer`);
        }
        if (parsed.username || parsed.password) problems.push(`${at}.agentCardUrl must not contain credentials`);
      } catch {
        problems.push(`${at}.agentCardUrl must be an absolute URL`);
      }
    }
    if (typeof rawDestination.token === "string" && rawDestination.token.length < 16) {
      problems.push(`${at}.token must contain at least 16 characters`);
    }
    if (!Array.isArray(rawDestination.allowedSkills) || rawDestination.allowedSkills.length === 0) {
      problems.push(`${at}.allowedSkills must contain at least one remote skill id`);
    }
    const allowedSkills = new Set(Array.isArray(rawDestination.allowedSkills)
      ? rawDestination.allowedSkills.filter((value): value is string => typeof value === "string")
      : []);
    const serviceNames = new Set<string>();
    for (const [serviceIndex, rawService] of (Array.isArray(rawDestination.services) ? rawDestination.services : []).entries()) {
      const serviceAt = `${at}.services[${serviceIndex}]`;
      if (!isPlainObject(rawService)) {
        problems.push(`${serviceAt} must be a mapping`);
        continue;
      }
      pushUnknownKeys(problems, rawService, ["name", "description", "skillId"], serviceAt);
      validateString(problems, `${serviceAt}.name`, rawService.name);
      validateString(problems, `${serviceAt}.description`, rawService.description);
      validateString(problems, `${serviceAt}.skillId`, rawService.skillId);
      if (typeof rawService.name === "string") {
        const normalized = rawService.name.trim().toLowerCase();
        if (!normalized) problems.push(`${serviceAt}.name must not be empty`);
        if (serviceNames.has(normalized)) problems.push(`${serviceAt}.name duplicates another service on this destination`);
        if (externalServiceNames.has(normalized)) problems.push(`${serviceAt}.name duplicates another external A2A service`);
        serviceNames.add(normalized);
        externalServiceNames.add(normalized);
      }
      if (typeof rawService.skillId === "string" && !allowedSkills.has(rawService.skillId)) {
        problems.push(`${serviceAt}.skillId must also appear in ${at}.allowedSkills`);
      }
    }
    for (const [originIndex, origin] of (Array.isArray(rawDestination.allowedOrigins) ? rawDestination.allowedOrigins : []).entries()) {
      if (typeof origin !== "string") continue;
      try {
        const parsed = new URL(origin);
        if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || origin !== parsed.origin) {
          problems.push(`${at}.allowedOrigins[${originIndex}] must be an exact http(s) origin without a path`);
        }
        if (parsed.protocol === "http:" && (rawDestination.allowPrivateHosts !== true || !isLocalDevelopmentHttpUrl(parsed))) {
          problems.push(`${at}.allowedOrigins[${originIndex}] must use https except for an explicitly enabled local-development HTTP peer`);
        }
      } catch {
        problems.push(`${at}.allowedOrigins[${originIndex}] must be an exact http(s) origin without a path`);
      }
    }
  }
  if (value.enabled === true) {
    if (!Array.isArray(value.allowedServices) || value.allowedServices.length === 0) {
      problems.push("a2a.allowedServices must contain at least one service when A2A is enabled");
    }
    if (!Array.isArray(value.clients) || value.clients.length === 0) {
      problems.push("a2a.clients must contain at least one authenticated caller when A2A is enabled");
    }
  }
}
