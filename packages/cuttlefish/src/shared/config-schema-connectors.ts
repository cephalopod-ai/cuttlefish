/**
 * Validation for the messaging-connector surface: the singleton `connectors.slack`,
 * `connectors.whatsapp`, and `connectors.twilio` blocks, the multi-instance
 * `connectors.instances` array, the `notifications` block, and the cross-reference
 * that requires `notifications.connector` to name a connector that is actually
 * configured (INV-CF-CRF-003 / DEC-20260628-010).
 *
 * Extracted from `packages/cuttlefish/src/shared/config-schema.ts` in a
 * behavior-preserving modularization. The notification cross-check lives here
 * rather than with the other top-level sections because it is driven entirely by
 * the connector inventory it walks. The facade calls `validateConnectors`,
 * `validateNotifications`, and `validateNotificationConnectorReference`.
 */
import {
  isPlainObject,
  pushUnknownKeys,
  validateBoolean,
  validateString,
  validateStringArray,
  validateStringOrStringArray,
} from "./config-schema-primitives.js";

function validateSlackConnector(problems: string[], path: string, value: unknown): void {
  if (!isPlainObject(value)) {
    problems.push(`${path} must be a mapping`);
    return;
  }
  pushUnknownKeys(problems, value, ["id", "employee", "appToken", "botToken", "allowFrom", "ignoreOldMessagesOnBoot", "shareSessionInChannel"], path);
  if (value.id !== undefined) validateString(problems, `${path}.id`, value.id);
  if (value.employee !== undefined) validateString(problems, `${path}.employee`, value.employee);
  if (value.appToken !== undefined) validateString(problems, `${path}.appToken`, value.appToken);
  if (value.botToken !== undefined) validateString(problems, `${path}.botToken`, value.botToken);
  if (value.allowFrom !== undefined) validateStringOrStringArray(problems, `${path}.allowFrom`, value.allowFrom);
  if (value.ignoreOldMessagesOnBoot !== undefined) validateBoolean(problems, `${path}.ignoreOldMessagesOnBoot`, value.ignoreOldMessagesOnBoot);
  if (value.shareSessionInChannel !== undefined) validateBoolean(problems, `${path}.shareSessionInChannel`, value.shareSessionInChannel);
}

function validateWhatsAppConnector(problems: string[], path: string, value: unknown): void {
  if (!isPlainObject(value)) {
    problems.push(`${path} must be a mapping`);
    return;
  }
  pushUnknownKeys(problems, value, ["id", "employee", "authDir", "allowFrom", "ignoreOldMessagesOnBoot"], path);
  if (value.id !== undefined) validateString(problems, `${path}.id`, value.id);
  if (value.employee !== undefined) validateString(problems, `${path}.employee`, value.employee);
  if (value.authDir !== undefined) validateString(problems, `${path}.authDir`, value.authDir);
  if (value.allowFrom !== undefined) validateStringArray(problems, `${path}.allowFrom`, value.allowFrom);
  if (value.ignoreOldMessagesOnBoot !== undefined) validateBoolean(problems, `${path}.ignoreOldMessagesOnBoot`, value.ignoreOldMessagesOnBoot);
}

function validateTwilioConnector(problems: string[], path: string, value: unknown): void {
  if (!isPlainObject(value)) {
    problems.push(`${path} must be a mapping`);
    return;
  }
  pushUnknownKeys(problems, value, ["employee", "fromNumber", "messagingServiceSid", "webhookUrl", "allowFrom"], path);
  if (value.employee !== undefined) validateString(problems, `${path}.employee`, value.employee);
  if (value.fromNumber !== undefined) validateString(problems, `${path}.fromNumber`, value.fromNumber);
  if (value.messagingServiceSid !== undefined) validateString(problems, `${path}.messagingServiceSid`, value.messagingServiceSid);
  if (value.allowFrom !== undefined) validateStringOrStringArray(problems, `${path}.allowFrom`, value.allowFrom);
  if (typeof value.webhookUrl !== "string" || !value.webhookUrl.trim()) {
    problems.push(`${path}.webhookUrl must be a non-empty HTTPS URL`);
  } else {
    try {
      if (new URL(value.webhookUrl).protocol !== "https:") throw new Error("not HTTPS");
    } catch {
      problems.push(`${path}.webhookUrl must be a non-empty HTTPS URL`);
    }
  }
  if (value.fromNumber === undefined && value.messagingServiceSid === undefined) {
    problems.push(`${path} requires fromNumber or messagingServiceSid for outbound SMS`);
  }
}

function validateConnectorInstance(
  problems: string[],
  value: unknown,
  index: number,
): void {
  const path = `connectors.instances[${index}]`;
  if (!isPlainObject(value)) {
    problems.push(`${path} must be a mapping`);
    return;
  }
  if (typeof value.id !== "string" || !value.id.trim()) problems.push(`${path}.id must be a non-empty string`);
  if (typeof value.type !== "string" || !value.type.trim()) {
    problems.push(`${path}.type must be a non-empty string`);
    return;
  }
  const type = value.type;
  const baseKeys = ["id", "type", "employee", "ignoreOldMessagesOnBoot"];
  const keysByType: Record<string, string[]> = {
    slack: [...baseKeys, "appToken", "botToken", "allowFrom"],
    whatsapp: [...baseKeys, "authDir", "allowFrom"],
  };
  if (!keysByType[type]) {
    problems.push(`${path}.type must be one of: ${Object.keys(keysByType).join(", ")}`);
    return;
  }
  pushUnknownKeys(problems, value, keysByType[type], path);
  if (value.employee !== undefined) validateString(problems, `${path}.employee`, value.employee);
  if (value.ignoreOldMessagesOnBoot !== undefined) validateBoolean(problems, `${path}.ignoreOldMessagesOnBoot`, value.ignoreOldMessagesOnBoot);
  if (value.allowFrom !== undefined) {
    validateStringOrStringArray(problems, `${path}.allowFrom`, value.allowFrom);
  }
  if (value.botToken !== undefined) validateString(problems, `${path}.botToken`, value.botToken);
  if (value.appToken !== undefined) validateString(problems, `${path}.appToken`, value.appToken);
  if (value.authDir !== undefined) validateString(problems, `${path}.authDir`, value.authDir);
}

export function validateConnectors(
  problems: string[],
  value: unknown,
): void {
  if (!isPlainObject(value)) {
    problems.push("connectors must be a mapping");
    return;
  }
  pushUnknownKeys(problems, value, ["web", "slack", "whatsapp", "twilio", "instances"], "connectors");
  if (value.web !== undefined && !isPlainObject(value.web)) problems.push("connectors.web must be a mapping");
  if (value.slack !== undefined) validateSlackConnector(problems, "connectors.slack", value.slack);
  if (value.whatsapp !== undefined) validateWhatsAppConnector(problems, "connectors.whatsapp", value.whatsapp);
  if (value.twilio !== undefined) validateTwilioConnector(problems, "connectors.twilio", value.twilio);
  if (value.instances !== undefined) {
    if (!Array.isArray(value.instances)) {
      problems.push("connectors.instances must be an array");
    } else {
      value.instances.forEach((instance, index) => validateConnectorInstance(problems, instance, index));
    }
  }
}


export function validateNotifications(problems: string[], value: unknown): void {
  if (!isPlainObject(value)) {
    problems.push("notifications must be a mapping");
    return;
  }
  pushUnknownKeys(problems, value, ["connector", "channel"], "notifications");
  if (value.connector !== undefined) validateString(problems, "notifications.connector", value.connector);
  if (value.channel !== undefined) validateString(problems, "notifications.channel", value.channel);
}

function collectConfiguredConnectorIds(config: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  if (!isPlainObject(config.connectors)) return ids;

  const connectors = config.connectors;
  if (isPlainObject(connectors.slack) && typeof connectors.slack.appToken === "string" && typeof connectors.slack.botToken === "string") {
    ids.add("slack");
  }
  if (isPlainObject(connectors.whatsapp)) {
    ids.add("whatsapp");
  }
  if (isPlainObject(connectors.twilio)) {
    ids.add("twilio");
  }
  if (!Array.isArray(connectors.instances)) return ids;

  for (const instance of connectors.instances) {
    if (!isPlainObject(instance)) continue;
    if (typeof instance.id !== "string" || !instance.id.trim()) continue;
    if (instance.type !== "slack" && instance.type !== "whatsapp") continue;
    ids.add(instance.id);
  }
  return ids;
}

export function validateNotificationConnectorReference(problems: string[], config: Record<string, unknown>): void {
  if (!isPlainObject(config.notifications)) return;

  const channel = config.notifications.channel;
  if (channel === undefined || typeof channel !== "string" || !channel.trim()) return;

  const connectorName = config.notifications.connector;
  const effectiveConnector = typeof connectorName === "string" && connectorName.trim() ? connectorName : "slack";
  const supportedConnectors = collectConfiguredConnectorIds(config);
  if (supportedConnectors.has(effectiveConnector)) return;

  const available = [...supportedConnectors].sort();
  const detail = available.length > 0
    ? `available connectors: ${available.join(", ")}`
    : "no supported connectors are configured";
  problems.push(`notifications.connector must reference a configured connector; got "${effectiveConnector}" (${detail})`);
}
