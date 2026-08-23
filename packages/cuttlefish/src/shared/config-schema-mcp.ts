/**
 * Validation for the `mcp` config section: the built-in browser, search, and
 * fetch providers, plus arbitrary `mcp.custom.<name>` server definitions in both
 * stdio (command/args/env) and remote (type/url/headers) form.
 *
 * Extracted from `packages/cuttlefish/src/shared/config-schema.ts` in a
 * behavior-preserving modularization. The facade calls `validateMcp`.
 */
import {
  isPlainObject,
  pushUnknownKeys,
  validateBoolean,
  validateExecString,
  validateString,
  validateStringArray,
} from "./config-schema-primitives.js";

export function validateMcp(
  problems: string[],
  value: unknown,
): void {
  if (!isPlainObject(value)) {
    problems.push("mcp must be a mapping");
    return;
  }
  pushUnknownKeys(problems, value, ["browser", "search", "fetch", "custom"], "mcp");
  if (value.browser !== undefined) {
    if (!isPlainObject(value.browser)) {
      problems.push("mcp.browser must be a mapping");
    } else {
      pushUnknownKeys(problems, value.browser, ["enabled", "provider"], "mcp.browser");
      if (value.browser.enabled !== undefined) validateBoolean(problems, "mcp.browser.enabled", value.browser.enabled);
      if (value.browser.provider !== undefined) validateString(problems, "mcp.browser.provider", value.browser.provider);
    }
  }
  if (value.search !== undefined) {
    if (!isPlainObject(value.search)) {
      problems.push("mcp.search must be a mapping");
    } else {
      pushUnknownKeys(problems, value.search, ["enabled", "provider", "apiKey"], "mcp.search");
      if (value.search.enabled !== undefined) validateBoolean(problems, "mcp.search.enabled", value.search.enabled);
      if (value.search.provider !== undefined) validateString(problems, "mcp.search.provider", value.search.provider);
      if (value.search.apiKey !== undefined) validateString(problems, "mcp.search.apiKey", value.search.apiKey);
    }
  }
  if (value.fetch !== undefined) {
    if (!isPlainObject(value.fetch)) {
      problems.push("mcp.fetch must be a mapping");
    } else {
      pushUnknownKeys(problems, value.fetch, ["enabled"], "mcp.fetch");
      if (value.fetch.enabled !== undefined) validateBoolean(problems, "mcp.fetch.enabled", value.fetch.enabled);
    }
  }
  if (value.custom !== undefined) {
    if (!isPlainObject(value.custom)) {
      problems.push("mcp.custom must be a mapping");
    } else {
      for (const [name, server] of Object.entries(value.custom)) {
        if (!isPlainObject(server)) {
          problems.push(`mcp.custom.${name} must be a mapping`);
          continue;
        }
        pushUnknownKeys(problems, server, ["enabled", "command", "args", "env", "type", "url", "headers"], `mcp.custom.${name}`);
        if (server.enabled !== undefined) validateBoolean(problems, `mcp.custom.${name}.enabled`, server.enabled);
        if (server.command !== undefined) validateExecString(problems, `mcp.custom.${name}.command`, server.command);
        if (server.args !== undefined) validateStringArray(problems, `mcp.custom.${name}.args`, server.args);
        if (server.type !== undefined) validateString(problems, `mcp.custom.${name}.type`, server.type);
        if (server.url !== undefined) validateString(problems, `mcp.custom.${name}.url`, server.url);
        if (server.env !== undefined && !isPlainObject(server.env)) problems.push(`mcp.custom.${name}.env must be a mapping`);
        if (server.headers !== undefined && !isPlainObject(server.headers)) problems.push(`mcp.custom.${name}.headers must be a mapping`);
      }
    }
  }
}
