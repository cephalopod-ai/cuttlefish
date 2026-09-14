import { createHash } from "node:crypto";

/**
 * Canonical JSON serialization for stable content hashing.
 *
 * `JSON.stringify` alone is not a canonical form: object key order follows
 * insertion order, so two semantically identical objects built in a
 * different order serialize (and therefore hash) differently. This module
 * fixes that by recursively sorting object keys before serializing, while
 * preserving array order (which is semantically meaningful — e.g. which
 * revision pass produced which artifact, so arrays are never reordered).
 *
 * Unlike `JSON.stringify`, this throws on values that would otherwise be
 * silently dropped or coerced (`NaN`, `Infinity`, `bigint`, `function`,
 * `symbol`, `Date`, `Map`, `Set`) rather than letting two semantically
 * different inputs hash the same, or letting a value type collapse to `{}`
 * silently (a bare `Date`/`Map`/`Set` has no own enumerable properties, so a
 * naive recursive key-sort would otherwise turn it into an empty object).
 * Callers that need a timestamp in a hashed structure must pass an ISO
 * string explicitly.
 */

export class CanonicalJsonError extends Error {}

function assertHashablePrimitive(value: unknown, path: string): void {
  if (typeof value === "bigint") {
    throw new CanonicalJsonError(`cannot canonicalize a bigint at ${path || "<root>"}`);
  }
  if (typeof value === "function") {
    throw new CanonicalJsonError(`cannot canonicalize a function at ${path || "<root>"}`);
  }
  if (typeof value === "symbol") {
    throw new CanonicalJsonError(`cannot canonicalize a symbol at ${path || "<root>"}`);
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new CanonicalJsonError(`cannot canonicalize a non-finite number (${value}) at ${path || "<root>"}`);
  }
}

function canonicalize(value: unknown, path: string): unknown {
  assertHashablePrimitive(value, path);
  if (value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalize(item, `${path}[${index}]`));
  }
  if (value instanceof Date) {
    throw new CanonicalJsonError(`cannot canonicalize a Date at ${path || "<root>"}; pass an ISO string instead`);
  }
  if (value instanceof Map || value instanceof Set) {
    throw new CanonicalJsonError(`cannot canonicalize a ${value.constructor.name} at ${path || "<root>"}; pass a plain object or array instead`);
  }

  const record = value as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort();
  const result: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    const child = record[key];
    if (child === undefined) continue; // matches JSON.stringify's own omission of undefined-valued properties
    result[key] = canonicalize(child, path ? `${path}.${key}` : key);
  }
  return result;
}

/**
 * Stable, key-order-independent JSON serialization suitable for hashing or
 * equality comparison. Throws `CanonicalJsonError` on values with no
 * canonical representation (see module doc).
 */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value, ""));
}

/** SHA-256 hex digest of a value's canonical JSON form. */
export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJsonStringify(value)).digest("hex");
}
