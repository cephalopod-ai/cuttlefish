/**
 * The one `isPlainObject` narrowing used across config, policy, cron, and MCP
 * parsing.
 *
 * Four byte-identical private copies of this predicate had accumulated
 * (`config-schema-knowledge.ts`, `mcp/resolver.ts`, `policy/loader.ts`,
 * `cron/validation.ts`) alongside the exported one in
 * `config-schema-primitives.ts`. They all guard the same thing — "this parsed
 * YAML/JSON value is a mapping, not an array and not null" — so a change to that
 * definition had five places to miss. It lives here, in a neutral module, so
 * subsystems outside the config schema can share it without importing a
 * config-schema internal.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
