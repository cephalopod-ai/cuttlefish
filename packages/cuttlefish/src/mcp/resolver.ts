import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { McpGlobalConfig, McpServerConfig, McpServerStdioConfig, McpServerUrlConfig, Employee } from "../shared/types.js";
import { CUTTLEFISH_HOME } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import { safeWriteFile } from "../shared/safe-write.js";

// Built-in MCP processes execute in an agent's tool boundary. Exact package
// versions make the code selected by a Cuttlefish release reviewable and prevent
// an upstream `latest` tag movement from silently changing that boundary.
const PLAYWRIGHT_MCP_PACKAGE = "@playwright/mcp@0.0.78";
const PUPPETEER_MCP_PACKAGE = "@modelcontextprotocol/server-puppeteer@2025.5.12";
const BRAVE_SEARCH_MCP_PACKAGE = "brave-search-mcp@2.1.0";
let warnedUnavailableFetch = false;

export interface ResolvedMcpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

/**
 * Resolve the MCP servers that should be available for a given employee
 * based on global config and employee-level overrides.
 */
export function resolveMcpServers(
  globalMcp: McpGlobalConfig | undefined,
  employee?: Employee,
): ResolvedMcpConfig {
  const servers: Record<string, McpServerConfig> = {};

  if (!globalMcp) return { mcpServers: servers };

  // Build the full set of available MCP servers from global config
  const available = buildAvailableServers(globalMcp);

  // Determine which servers this employee gets
  const employeeMcp = employee?.mcp;

  if (employeeMcp === false) {
    // Employee explicitly opted out of all MCP servers
    return { mcpServers: {} };
  }

  if (Array.isArray(employeeMcp)) {
    // Employee wants only specific servers
    for (const name of employeeMcp) {
      if (available[name]) {
        servers[name] = available[name];
      } else {
        logger.warn(`Employee ${employee?.name} requests MCP server "${name}" but it's not configured`);
      }
    }
  } else {
    // Employee gets all enabled servers (default behavior, or mcp: true)
    Object.assign(servers, available);
  }

  return { mcpServers: servers };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isPlainObject(value) && Object.values(value).every((entry) => typeof entry === "string");
}

/**
 * Shape-validate one entry of `mcp.custom` before it is used to spawn a
 * process or dial a URL (FSR-CF-016). Config is operator-authored and may
 * not match the declared TypeScript shape at runtime; on any mismatch this
 * logs a `logger.warn` naming the server and the offending field and returns
 * `false` so the caller skips just that entry instead of crashing resolve()
 * or passing a malformed config through to the engine. Returns a type
 * predicate so callers keep the declared `McpServerConfig` typing for the
 * (now runtime-checked) entry rather than widening it to `unknown`.
 */
function isValidCustomServerEntry(
  name: string,
  value: unknown,
): value is (McpServerStdioConfig | McpServerUrlConfig) & { enabled?: boolean } {
  if (!isPlainObject(value)) {
    logger.warn(`MCP custom server "${name}" is not a valid config object; skipping`);
    return false;
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    logger.warn(`MCP custom server "${name}" has invalid "enabled" (expected boolean); skipping`);
    return false;
  }

  if (value.url !== undefined) {
    // URL-based (HTTP/SSE) server.
    if (typeof value.url !== "string" || !value.url) {
      logger.warn(`MCP custom server "${name}" has invalid "url" (expected non-empty string); skipping`);
      return false;
    }
    if (value.headers !== undefined && !isStringRecord(value.headers)) {
      logger.warn(`MCP custom server "${name}" has invalid "headers" (expected a string-to-string map); skipping`);
      return false;
    }
    return true;
  }

  // Stdio-based server.
  if (typeof value.command !== "string" || !value.command) {
    logger.warn(`MCP custom server "${name}" is missing a valid "command" (expected non-empty string); skipping`);
    return false;
  }
  if (value.args !== undefined && !isStringArray(value.args)) {
    logger.warn(`MCP custom server "${name}" has invalid "args" (expected a string array); skipping`);
    return false;
  }
  if (value.env !== undefined && !isStringRecord(value.env)) {
    logger.warn(`MCP custom server "${name}" has invalid "env" (expected a string-to-string map); skipping`);
    return false;
  }
  return true;
}

/**
 * Build the map of all available (enabled) MCP servers from global config.
 */
function buildAvailableServers(config: McpGlobalConfig): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};

  // Browser automation via Playwright
  if (config.browser?.enabled !== false) {
    const provider = config.browser?.provider || "playwright";
    if (provider === "playwright") {
      servers.browser = {
        command: "npx",
        args: ["-y", PLAYWRIGHT_MCP_PACKAGE],
      };
    } else if (provider === "puppeteer") {
      servers.browser = {
        command: "npx",
        args: ["-y", PUPPETEER_MCP_PACKAGE],
      };
    }
  }

  // Web search via Brave
  if (config.search?.enabled) {
    const apiKey = resolveEnvVar(config.search.apiKey);
    if (apiKey) {
      servers.search = {
        command: "npx",
        args: ["-y", BRAVE_SEARCH_MCP_PACKAGE],
        env: { BRAVE_API_KEY: apiKey },
      };
    } else {
      logger.warn("MCP search enabled but no API key configured (set mcp.search.apiKey or BRAVE_API_KEY env var)");
    }
  }

  // The historical @anthropic-ai fetch MCP package is no longer published.
  // Keep the configuration key for backwards-compatible parsing, but never
  // launch an unresolvable or mutable replacement automatically. Operators can
  // opt into a reviewed, pinned custom MCP fetch server instead.
  if (config.fetch?.enabled) {
    if (!warnedUnavailableFetch) {
      warnedUnavailableFetch = true;
      logger.warn("Built-in MCP fetch is unavailable; configure a reviewed pinned mcp.custom fetch server instead");
    }
  }

  // Custom user-defined MCP servers. These come from operator-authored
  // config (YAML/JSON) and are not guaranteed to match the declared
  // TypeScript shape at runtime, so each entry is shape-validated before use
  // (FSR-CF-016) — a malformed entry is skipped with a warning rather than
  // crashing resolve() or being passed through to the engine unchecked.
  if (config.custom) {
    for (const [name, serverConfig] of Object.entries(config.custom)) {
      if (!isValidCustomServerEntry(name, serverConfig)) continue;
      if (serverConfig.enabled === false) continue;
      const { enabled, ...rest } = serverConfig;

      // URL-based MCP server (HTTP/SSE transport)
      // Claude Code requires "type": "sse" for URL-based servers
      if ("url" in rest && (rest as McpServerUrlConfig).url) {
        servers[name] = { type: "sse", ...rest } as McpServerConfig;
        continue;
      }

      // Stdio-based MCP server — resolve env vars
      if ("env" in rest && rest.env) {
        for (const [key, value] of Object.entries(rest.env)) {
          rest.env[key] = resolveEnvVar(value) || value;
        }
      }
      servers[name] = rest as McpServerConfig;
    }
  }

  return servers;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function codexMcpServerFlags(name: string, server: McpServerConfig): string[] {
  const prefix = `mcp_servers.${name}`;
  const flags: string[] = [];
  if ("url" in server && server.url) {
    flags.push("-c", `${prefix}.url=${tomlString(server.url)}`);
    const bearer = (server as any).bearer_token_env_var ?? (server as any).bearerTokenEnvVar;
    if (typeof bearer === "string" && bearer) flags.push("-c", `${prefix}.bearer_token_env_var=${tomlString(bearer)}`);
    return flags;
  }

  const stdio = server as McpServerStdioConfig & { cwd?: string };
  flags.push("-c", `${prefix}.command=${tomlString(stdio.command)}`);
  if (stdio.args?.length) flags.push("-c", `${prefix}.args=${tomlStringArray(stdio.args)}`);
  if (stdio.cwd) flags.push("-c", `${prefix}.cwd=${tomlString(stdio.cwd)}`);
  if (stdio.env) {
    for (const [key, value] of Object.entries(stdio.env)) {
      flags.push("-c", `${prefix}.env.${key}=${tomlString(value)}`);
    }
  }
  return flags;
}

/**
 * Convert a resolved Cuttlefish MCP config into Codex CLI config overrides.
 * Codex does not accept Claude's --mcp-config JSON file; it reads
 * mcp_servers.<name> from config.toml, and `-c` can inject those keys per run.
 */
export function codexMcpConfigFlags(config: ResolvedMcpConfig): string[] {
  const flags: string[] = [];
  for (const [name, server] of Object.entries(config.mcpServers)) {
    flags.push(...codexMcpServerFlags(name, server));
  }
  return flags;
}

export function codexMcpConfigFlagsFromFile(configPath: string | undefined): string[] {
  if (!configPath) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as ResolvedMcpConfig;
    return codexMcpConfigFlags(parsed);
  } catch (err) {
    logger.warn(`Failed to read MCP config for Codex from ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Write a resolved MCP config to a temp file and return the path.
 * Claude Code reads this via --mcp-config <path>; Codex reads the same file
 * through codexMcpConfigFlagsFromFile() and receives equivalent -c overrides.
 */
export function writeMcpConfigFile(config: ResolvedMcpConfig, sessionId: string): string {
  const tmpDir = path.join(CUTTLEFISH_HOME, "tmp", "mcp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const filePath = path.join(tmpDir, `${sessionId}.json`);
  // 0600: this file can contain resolved MCP server secrets (API keys, bearer
  // tokens, etc. pulled in via resolveEnvVar) and is read by the engine from
  // disk, so it must not be group/world-readable (SEC-CFDB-006).
  safeWriteFile(filePath, JSON.stringify(config, null, 2), { mode: 0o600 }); // atomic + fsync (resolved MCP config read by the engine)
  return filePath;
}

/**
 * Clean up a temp MCP config file.
 */
export function cleanupMcpConfigFile(sessionId: string): void {
  const filePath = path.join(CUTTLEFISH_HOME, "tmp", "mcp", `${sessionId}.json`);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Ignore cleanup errors
  }
}

/** Per-session MCP temp config files older than this are swept on startup. */
export const MCP_CONFIG_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * Sweep stale per-session MCP temp config files (TMP-CUT-019 / DAT-BUS-006).
 *
 * `writeMcpConfigFile()` writes a resolved MCP config — which can contain
 * secrets — under `CUTTLEFISH_HOME/tmp/mcp/<sessionId>.json` for the engine
 * to read via `--mcp-config`. Normal cleanup happens best-effort in a
 * `finally` block in the session lifecycle, so a hard process kill mid-session
 * orphans that file with nothing to remove it. Call this on daemon startup
 * (and optionally on a periodic timer, mirroring `cleanupOldUploads()` in
 * gateway/files/storage.ts) to remove anything left over from a prior boot.
 *
 * Wired into daemon startup (and a 24h interval timer) in
 * gateway/server.ts's startGateway(), next to cleanupOldUploads().
 */
export function sweepStaleMcpConfigFiles(maxAgeMs: number = MCP_CONFIG_STALE_MS): number {
  const tmpDir = path.join(CUTTLEFISH_HOME, "tmp", "mcp");
  if (!fs.existsSync(tmpDir)) return 0;
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const entry of fs.readdirSync(tmpDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(tmpDir, entry.name);
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs >= cutoff) continue;
      fs.unlinkSync(filePath);
      removed++;
    } catch (err) {
      logger.warn(`Failed to sweep stale MCP config file ${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (removed > 0) logger.info(`Swept ${removed} stale MCP config file(s) older than ${Math.round(maxAgeMs / (60 * 60 * 1000))}h`);
  return removed;
}

/**
 * Resolve a value that may reference an environment variable.
 * Supports ${VAR_NAME} syntax.
 */
function resolveEnvVar(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^\$\{(.+)\}$/);
  if (match) {
    return process.env[match[1]] || undefined;
  }
  // Also check if the raw value is a plain env var name
  if (value.startsWith("$")) {
    return process.env[value.slice(1)] || undefined;
  }
  return value;
}
