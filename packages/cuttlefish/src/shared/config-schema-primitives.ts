/**
 * Value-shape primitives shared by every `config-schema-*` section validator:
 * plain-object narrowing, unknown-key reporting, and the scalar/array/exec-string
 * checks that push human-readable problems onto a shared `problems` array.
 *
 * Extracted from `packages/cuttlefish/src/shared/config-schema.ts` in a
 * behavior-preserving modularization. These names were module-private in the
 * original file, so the `config-schema.ts` facade deliberately does not
 * re-export them — it imports them like any other section module does.
 */

// Shared with policy/cron/MCP parsing — see `plain-object.ts`. Re-exported here
// so every `config-schema-*` module keeps importing it from one place.
export { isPlainObject } from "./plain-object.js";

export function pushUnknownKeys(
  problems: string[],
  value: Record<string, unknown>,
  allowed: Iterable<string>,
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) {
    const prefix = label === "config" ? "unknown config keys" : `unknown ${label} config keys`;
    problems.push(`${prefix}: ${unknown.join(", ")}`);
  }
}
export function validateStringArray(problems: string[], path: string, value: unknown): void {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    problems.push(`${path} must be an array of strings`);
  }
}
export function validateNumber(problems: string[], path: string, value: unknown): void {
  if (typeof value !== "number") problems.push(`${path} must be a number (got ${typeof value})`);
}
export function validatePort(problems: string[], path: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    problems.push(`${path} must be an integer from 1 to 65535`);
  }
}
export function validateString(problems: string[], path: string, value: unknown): void {
  if (typeof value !== "string") problems.push(`${path} must be a string (got ${typeof value})`);
}

export function validateBoolean(problems: string[], path: string, value: unknown): void {
  if (typeof value !== "boolean") problems.push(`${path} must be a boolean (got ${typeof value})`);
}

export function validateStringOrStringArray(problems: string[], path: string, value: unknown): void {
  const valid = typeof value === "string" || (Array.isArray(value) && value.every((entry) => typeof entry === "string"));
  if (!valid) problems.push(`${path} must be a string or array of strings`);
}

function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}
export function validateExecString(problems: string[], path: string, value: unknown): void {
  if (typeof value !== "string") {
    problems.push(`${path} must be a string (got ${typeof value})`);
    return;
  }
  if (hasControlChars(value)) {
    problems.push(`${path} must not contain control characters or newlines`);
  }
}
