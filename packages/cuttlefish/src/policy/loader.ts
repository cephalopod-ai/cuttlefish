import fs from "node:fs";
import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { buildDefaultProfile } from "./profiles.js";
import { logger } from "../shared/logger.js";
import type { PolicyProfile, PolicyRule } from "./types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRule(raw: unknown, index: number): PolicyRule | null {
  if (!isPlainObject(raw)) return null;
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `rule-${index}`;
  if (typeof raw.allow !== "boolean") return null;
  const rule: PolicyRule = { id, allow: raw.allow };
  if (raw.action !== undefined) {
    if (raw.action === "export" || raw.action === "retain" || raw.action === "quarantine" || raw.action === "register") {
      rule.action = raw.action;
    } else {
      throw new Error(`policy: rule ${index} has unknown action "${String(raw.action)}"; fix the policy file or remove the rule`);
    }
  }
  if (typeof raw.kindPattern === "string" && raw.kindPattern) rule.kindPattern = raw.kindPattern;
  if (typeof raw.locatorPattern === "string" && raw.locatorPattern) rule.locatorPattern = raw.locatorPattern;
  return rule;
}

function parseProfileFile(filePath: string): PolicyProfile {
  const raw: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  if (!isPlainObject(raw)) throw new Error(`policy: ${filePath} is not a JSON object`);
  if (!Array.isArray(raw.rules)) throw new Error(`policy: ${filePath} 'rules' field is missing or not an array`);
  const rulesRaw = raw.rules;
  const rules: PolicyRule[] = rulesRaw
    .map((r, i) => parseRule(r, i))
    .filter((r): r is PolicyRule => r !== null);
  return { rules };
}

export function loadPolicyProfile(policyDir: string): PolicyProfile {
  if (!fs.existsSync(policyDir) || !fs.statSync(policyDir).isDirectory()) return buildDefaultProfile();
  const entries = (fs.readdirSync(policyDir) as string[]).filter((name: string) => name.endsWith(".json")).sort();
  if (entries.length === 0) return buildDefaultProfile();
  const allRules: PolicyRule[] = [];
  // DAT-BUS-004: rules from earlier (alphabetically) files match first and shadow
  // later files' broader/narrower rules. Log the effective load order and per-file
  // rule counts so an operator debugging a shadowed-rule issue can see the merge
  // order without reading source.
  const loadOrder: string[] = [];
  for (const entry of entries) {
    const profile = parseProfileFile(path.join(policyDir, entry));
    allRules.push(...profile.rules);
    loadOrder.push(`${entry} (${profile.rules.length} rule${profile.rules.length === 1 ? "" : "s"})`);
  }
  logger.debug(`policy: loaded ${entries.length} file(s) from ${policyDir} in effective (first-match-wins) order: ${loadOrder.join(", ")}`);
  return { rules: allRules };
}

/**
 * How long (in milliseconds) a cached policy profile is considered fresh.
 * After this interval elapses, the next call to getPolicyProfile() will
 * re-read and re-parse all policy files from disk, picking up any live
 * changes an operator made without restarting the gateway.
 * Set to 60 seconds as a balance between responsiveness and I/O cost.
 */
const POLICY_CACHE_TTL_MS = 60_000;

let _cached: PolicyProfile | undefined;
let _cachedDir: string | undefined;
let _cachedAt: number | undefined;

/** Debounce delay (ms) for policy-file watch events, mirroring gateway/watcher.ts. */
const POLICY_WATCH_DEBOUNCE_MS = 300;

let _watcher: FSWatcher | undefined;
let _watchedDir: string | undefined;

function debounce(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

/**
 * Lazily start a file watcher on `policyDir` so operator edits to policy files
 * invalidate the cache promptly instead of waiting up to POLICY_CACHE_TTL_MS
 * (DAT-BUS-003 / CAS-CF-004 / TMP-CUT-002). The TTL above remains as a
 * backstop: if the watcher can't be set up (e.g. an exotic filesystem that
 * doesn't support watching), we log and fall back to TTL-only invalidation
 * rather than crashing the daemon.
 */
function ensurePolicyWatcher(policyDir: string): void {
  if (_watcher && _watchedDir === policyDir) return;
  if (_watcher) {
    const stale = _watcher;
    _watcher = undefined;
    void stale.close().catch(() => {});
  }
  try {
    const watcher = watch(policyDir, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300 },
    });
    watcher.on(
      "all",
      debounce(() => {
        logger.debug(`policy: ${policyDir} changed, invalidating cached profile`);
        invalidatePolicyCache();
      }, POLICY_WATCH_DEBOUNCE_MS),
    );
    watcher.on("error", (err) => {
      logger.warn(
        `policy: file watcher error for ${policyDir}, falling back to TTL-only cache invalidation: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    _watcher = watcher;
    _watchedDir = policyDir;
  } catch (err) {
    logger.warn(
      `policy: failed to start file watcher for ${policyDir}, falling back to TTL-only cache invalidation: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Stops the policy file watcher, if any. Exposed for tests and graceful shutdown. */
export async function stopPolicyWatcher(): Promise<void> {
  const watcher = _watcher;
  _watcher = undefined;
  _watchedDir = undefined;
  if (watcher) {
    try {
      await watcher.close();
    } catch {
      // ignore close failures — nothing more we can do
    }
  }
}

export function getPolicyProfile(policyDir: string): PolicyProfile {
  ensurePolicyWatcher(policyDir);
  const now = Date.now();
  if (
    _cached &&
    _cachedDir === policyDir &&
    _cachedAt !== undefined &&
    now - _cachedAt < POLICY_CACHE_TTL_MS
  ) {
    return _cached;
  }
  _cached = loadPolicyProfile(policyDir);
  _cachedDir = policyDir;
  _cachedAt = now;
  return _cached;
}

export function invalidatePolicyCache(): void {
  _cached = undefined;
  _cachedDir = undefined;
  _cachedAt = undefined;
}
