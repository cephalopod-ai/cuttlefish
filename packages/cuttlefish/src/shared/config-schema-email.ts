/**
 * Validation for the `email` config section: the poll toggle/interval and the
 * IMAP inbox definitions it drives, including the inbox-count cap, duplicate-id
 * check, and the "enabled requires at least one inbox" rule.
 *
 * Extracted from `packages/cuttlefish/src/shared/config-schema.ts` in a
 * behavior-preserving modularization. The facade calls `validateEmail`.
 */
import {
  isPlainObject,
  pushUnknownKeys,
  validateBoolean,
  validateNumber,
  validatePort,
  validateString,
  validateStringArray,
} from "./config-schema-primitives.js";

function validateEmailInbox(problems: string[], path: string, value: unknown): void {
  if (!isPlainObject(value)) {
    problems.push(`${path} must be a mapping`);
    return;
  }
  pushUnknownKeys(problems, value, [
    "id",
    "label",
    "address",
    "username",
    "password",
    "imapHost",
    "imapPort",
    "useTls",
    "folder",
    "autoIngest",
    "allowFrom",
    "trustedAuthservIds",
    "unreadOnly",
    "maxMessagesPerPoll",
    "maxMessageBytes",
  ], path);
  if (typeof value.id !== "string" || !value.id.trim()) problems.push(`${path}.id must be a non-empty string`);
  if (value.label !== undefined) validateString(problems, `${path}.label`, value.label);
  if (typeof value.address !== "string" || !value.address.trim()) problems.push(`${path}.address must be a non-empty string`);
  if (typeof value.username !== "string" || !value.username.trim()) problems.push(`${path}.username must be a non-empty string`);
  if (typeof value.password !== "string" || !value.password.trim()) problems.push(`${path}.password must be a non-empty string`);
  if (typeof value.imapHost !== "string" || !value.imapHost.trim()) problems.push(`${path}.imapHost must be a non-empty string`);
  if (value.imapPort !== undefined) validatePort(problems, `${path}.imapPort`, value.imapPort);
  if (value.useTls !== undefined) validateBoolean(problems, `${path}.useTls`, value.useTls);
  if (value.folder !== undefined) validateString(problems, `${path}.folder`, value.folder);
  if (value.autoIngest !== undefined) validateBoolean(problems, `${path}.autoIngest`, value.autoIngest);
  if (value.allowFrom !== undefined) validateStringArray(problems, `${path}.allowFrom`, value.allowFrom);
  if (value.trustedAuthservIds !== undefined) validateStringArray(problems, `${path}.trustedAuthservIds`, value.trustedAuthservIds);
  if (value.unreadOnly !== undefined) validateBoolean(problems, `${path}.unreadOnly`, value.unreadOnly);
  if (value.maxMessagesPerPoll !== undefined) validateNumber(problems, `${path}.maxMessagesPerPoll`, value.maxMessagesPerPoll);
  if (value.maxMessageBytes !== undefined) validateNumber(problems, `${path}.maxMessageBytes`, value.maxMessageBytes);
}

export function validateEmail(
  problems: string[],
  value: unknown,
): void {
  if (!isPlainObject(value)) {
    problems.push("email must be a mapping");
    return;
  }
  pushUnknownKeys(problems, value, ["enabled", "pollIntervalSeconds", "inboxes"], "email");
  if (value.enabled !== undefined) validateBoolean(problems, "email.enabled", value.enabled);
  if (value.pollIntervalSeconds !== undefined) validateNumber(problems, "email.pollIntervalSeconds", value.pollIntervalSeconds);
  if (value.inboxes !== undefined) {
    if (!Array.isArray(value.inboxes)) {
      problems.push("email.inboxes must be an array");
    } else {
      if (value.inboxes.length > 3) problems.push("email.inboxes must contain at most 3 inboxes");
      const ids = new Set<string>();
      value.inboxes.forEach((entry, index) => {
        const path = `email.inboxes[${index}]`;
        validateEmailInbox(problems, path, entry);
        if (isPlainObject(entry) && typeof entry.id === "string" && entry.id.trim()) {
          if (ids.has(entry.id.trim())) problems.push(`duplicate email inbox id: ${entry.id.trim()}`);
          ids.add(entry.id.trim());
        }
      });
    }
  }
  if (value.enabled === true && (!Array.isArray(value.inboxes) || value.inboxes.length === 0)) {
    problems.push("email.enabled requires at least one configured inbox");
  }
}
