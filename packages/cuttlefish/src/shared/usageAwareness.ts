import fs from "node:fs";
import path from "node:path";
import { CUTTLEFISH_HOME } from "./paths.js";
import { safeWriteFile } from "./safe-write.js";

interface ClaudeUsageState {
  lastRateLimitAt?: string; // ISO
  lastResetsAt?: string; // ISO
}

const STATE_PATH = path.join(CUTTLEFISH_HOME, "tmp", "claude-usage.json");

function ensureStateDir(): void {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
}

export function readClaudeUsageState(): ClaudeUsageState {
  try {
    if (!fs.existsSync(STATE_PATH)) return {};
    const raw = fs.readFileSync(STATE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as ClaudeUsageState;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

export function recordClaudeRateLimit(resetsAtSeconds?: number): void {
  const nowIso = new Date().toISOString();
  const next: ClaudeUsageState = {
    ...readClaudeUsageState(),
    lastRateLimitAt: nowIso,
    ...(typeof resetsAtSeconds === "number" && Number.isFinite(resetsAtSeconds)
      ? { lastResetsAt: new Date(resetsAtSeconds * 1000).toISOString() }
      : {}),
  };

  try {
    ensureStateDir();
    safeWriteFile(STATE_PATH, JSON.stringify(next, null, 2)); // atomic + fsync; best-effort (no audit)
  } catch {
    // best-effort only
  }
}

export function getClaudeExpectedResetAt(now = new Date()): Date | undefined {
  const state = readClaudeUsageState();
  if (!state.lastResetsAt) return undefined;
  const d = new Date(state.lastResetsAt);
  if (Number.isNaN(d.getTime())) return undefined;
  if (d.getTime() <= now.getTime()) return undefined;
  return d;
}

export function isLikelyNearClaudeUsageLimit(now = new Date()): boolean {
  const state = readClaudeUsageState();
  if (!state.lastRateLimitAt) return false;

  // If we know the exact reset time and it has passed, the limit is cleared
  if (state.lastResetsAt) {
    const resetAt = new Date(state.lastResetsAt);
    if (!Number.isNaN(resetAt.getTime()) && now.getTime() > resetAt.getTime()) {
      return false;
    }
  }

  const d = new Date(state.lastRateLimitAt);
  if (Number.isNaN(d.getTime())) return false;
  // Heuristic: if we've hit the limit recently, we're likely near it again.
  return now.getTime() - d.getTime() < 6 * 60 * 60_000;
}

