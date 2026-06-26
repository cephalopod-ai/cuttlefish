import fs from "node:fs";
import path from "node:path";
import { CUTTLEFISH_HOME } from "./paths.js";
import { collectEngineLimits } from "./engine-limits.js";
import { recordClaudeRateLimit, readClaudeUsageState } from "./usageAwareness.js";
import { safeWriteFile } from "./safe-write.js";
import type { CuttlefishConfig } from "./types.js";

/**
 * Deterministic, cross-provider usage status + recovery planning.
 *
 * The goal: an agent must never hit a usage bottleneck it can't recover from. So we
 * (a) record a deterministic reset clock per engine on every rate-limit (with a
 * configurable fallback window — default 3h — when the provider doesn't tell us when
 * it resets), (b) read ACTUAL remaining-% snapshots where the provider exposes them
 * (Claude/Codex), and (c) decide deterministically whether to PROCEED, SWITCH to a
 * healthier available engine, or WAIT until the earliest known reset (bounded).
 *
 * Pure decision functions (`statusFromInputs`, `planUsageRecovery`) take their inputs
 * explicitly so they are fully unit-testable; the async `getEngineUsageStatus` wraps
 * them with the live snapshot + recorded-reset I/O.
 */

const USAGE_DIR = path.join(CUTTLEFISH_HOME, "tmp", "usage");
const KIRO_USAGE_DIR = path.join(CUTTLEFISH_HOME, "usage");
const KIRO_CREDITS_FILE = path.join(KIRO_USAGE_DIR, "kiro-credits.json");
const DEFAULT_FALLBACK_WINDOW_MINS = 180; // 3h — used when the provider gives no reset time
const DEFAULT_LOW_PERCENT = 15;           // remaining <= this → "low" → prefer switching
const DEFAULT_MAX_WAIT_MINS = 360;        // never wait longer than this for a reset (6h)

export type UsageState = "ok" | "low" | "exhausted" | "unknown";

export interface UsageStatus {
  engine: string;
  state: UsageState;
  /** Worst remaining percentage across the engine's windows, if known. */
  remainingPercent?: number;
  /** Epoch seconds when the binding window resets, if known. */
  resetsAt?: number;
  source: "live" | "recorded" | "estimate" | "none";
  /** True when the provider exposes no authoritative quota endpoint and Cuttlefish is using local accounting. */
  estimated?: boolean;
}

export interface UsageConfig {
  lowPercent: number;
  fallbackWindowMins: number;
  maxWaitMins: number;
}

export function usageConfig(config: CuttlefishConfig): UsageConfig {
  const s = ((config as unknown as { sessions?: Record<string, unknown> }).sessions) ?? {};
  const pos = (v: unknown, d: number) => (typeof v === "number" && v > 0 ? v : d);
  return {
    lowPercent: pos(s.usageLowPercent, DEFAULT_LOW_PERCENT),
    fallbackWindowMins: pos(s.usageFallbackWindowMins, DEFAULT_FALLBACK_WINDOW_MINS),
    maxWaitMins: pos(s.usageMaxWaitMins, DEFAULT_MAX_WAIT_MINS),
  };
}

// ── recorder: a deterministic per-engine "rate-limited until" clock ───────────
interface RecordedLimit { lastRateLimitAt: string; lastResetsAt?: string }

function recPath(engine: string): string { return path.join(USAGE_DIR, `${engine}.json`); }

/** Record that `engine` hit a usage/rate limit, with its reset time if the provider gave one. */
export function recordEngineRateLimit(engine: string, resetsAtSeconds?: number): void {
  if (engine === "claude") recordClaudeRateLimit(resetsAtSeconds); // keep the legacy Claude machinery in sync
  const rec: RecordedLimit = {
    lastRateLimitAt: new Date().toISOString(),
    ...(typeof resetsAtSeconds === "number" && Number.isFinite(resetsAtSeconds)
      ? { lastResetsAt: new Date(resetsAtSeconds * 1000).toISOString() } : {}),
  };
  try {
    safeWriteFile(recPath(engine), JSON.stringify(rec)); // atomic + fsync; best-effort (no audit)
  } catch { /* best-effort */ }
}

function readRecorded(engine: string): RecordedLimit | undefined {
  if (engine === "claude") {
    const s = readClaudeUsageState();
    return s.lastRateLimitAt ? { lastRateLimitAt: s.lastRateLimitAt, lastResetsAt: s.lastResetsAt } : undefined;
  }
  try {
    const p = recPath(engine);
    if (!fs.existsSync(p)) return undefined;
    const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
    return parsed?.lastRateLimitAt ? parsed as RecordedLimit : undefined;
  } catch { return undefined; }
}

export interface KiroCreditLedger {
  windowStart: string;
  consumed: number;
}

function kiroAnchorDay(config: CuttlefishConfig): number {
  const raw = config.engines.kiro?.billingAnchorDay;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 1;
  return Math.min(31, Math.max(1, Math.round(raw)));
}

function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function anchorDateUtc(year: number, month: number, anchorDay: number): Date {
  const day = Math.min(anchorDay, daysInUtcMonth(year, month));
  return new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
}

function kiroWindow(config: CuttlefishConfig, now = Date.now()): { start: Date; next: Date } {
  const anchorDay = kiroAnchorDay(config);
  const d = new Date(now);
  let start = anchorDateUtc(d.getUTCFullYear(), d.getUTCMonth(), anchorDay);
  if (d.getTime() < start.getTime()) {
    start = anchorDateUtc(d.getUTCFullYear(), d.getUTCMonth() - 1, anchorDay);
  }
  const next = anchorDateUtc(start.getUTCFullYear(), start.getUTCMonth() + 1, anchorDay);
  return { start, next };
}

export function nextKiroCreditResetAt(config: CuttlefishConfig, now = Date.now()): number {
  return Math.floor(kiroWindow(config, now).next.getTime() / 1000);
}

export function readKiroCreditLedger(config: CuttlefishConfig, now = Date.now()): KiroCreditLedger {
  const { start } = kiroWindow(config, now);
  const windowStart = start.toISOString();
  try {
    if (fs.existsSync(KIRO_CREDITS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(KIRO_CREDITS_FILE, "utf-8"));
      if (
        parsed?.windowStart === windowStart &&
        typeof parsed.consumed === "number" &&
        Number.isFinite(parsed.consumed)
      ) {
        return { windowStart, consumed: Math.max(0, parsed.consumed) };
      }
    }
  } catch {
    /* corrupt/mismatched local estimate ledger resets for the active billing window */
  }
  return { windowStart, consumed: 0 };
}

export function recordKiroCreditUsage(config: CuttlefishConfig, credits: number, now = Date.now()): KiroCreditLedger {
  const current = readKiroCreditLedger(config, now);
  const next: KiroCreditLedger = {
    windowStart: current.windowStart,
    consumed: Math.max(0, current.consumed + Math.max(0, credits)),
  };
  try {
    fs.mkdirSync(KIRO_USAGE_DIR, { recursive: true });
    safeWriteFile(KIRO_CREDITS_FILE, JSON.stringify(next, null, 2)); // atomic + fsync; estimate only
  } catch {
    /* best-effort local usage estimate */
  }
  return next;
}

export function getKiroCreditUsageStatus(config: CuttlefishConfig, opts: { now?: number } = {}): UsageStatus {
  const now = opts.now ?? Date.now();
  const ledger = readKiroCreditLedger(config, now);
  const budget = config.engines.kiro?.creditBudget;
  if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) {
    return { engine: "kiro", state: "unknown", resetsAt: nextKiroCreditResetAt(config, now), source: "estimate", estimated: true };
  }
  const remainingPercent = Math.max(0, 100 - (ledger.consumed / budget) * 100);
  const resetsAt = nextKiroCreditResetAt(config, now);
  const lowPercent = usageConfig(config).lowPercent;
  if (remainingPercent <= 0) return { engine: "kiro", state: "exhausted", remainingPercent, resetsAt, source: "estimate", estimated: true };
  if (remainingPercent <= lowPercent) return { engine: "kiro", state: "low", remainingPercent, resetsAt, source: "estimate", estimated: true };
  return { engine: "kiro", state: "ok", remainingPercent, resetsAt, source: "estimate", estimated: true };
}

/**
 * The engine's recorded reset time (epoch seconds) if it is still in the future.
 * Uses the provider-given reset, else `lastRateLimitAt + fallbackWindow` (default 3h).
 * Returns undefined once the reset has passed (the limit is considered cleared).
 */
export function getRecordedReset(engine: string, fallbackWindowMins: number, now = Date.now()): number | undefined {
  const rec = readRecorded(engine);
  if (!rec) return undefined;
  let resetMs: number | undefined;
  if (rec.lastResetsAt) { const t = Date.parse(rec.lastResetsAt); if (Number.isFinite(t)) resetMs = t; }
  if (resetMs === undefined) {
    const t = Date.parse(rec.lastRateLimitAt);
    if (Number.isFinite(t)) resetMs = t + fallbackWindowMins * 60_000;
  }
  if (resetMs === undefined || resetMs <= now) return undefined; // cleared
  return Math.floor(resetMs / 1000);
}

// ── status from inputs (pure) ────────────────────────────────────────────────
export interface SnapshotLike {
  available?: boolean;
  status?: string;
  windows?: Array<{ usedPercent?: number; resetsAt?: number }>;
}

/** Decide a usage state from a (fresher) live snapshot and/or a recorded reset. Pure. */
export function statusFromInputs(
  engine: string,
  opts: { recordedReset?: number; snapshot?: SnapshotLike; lowPercent: number },
): UsageStatus {
  const { recordedReset, snapshot, lowPercent } = opts;
  const windows = snapshot?.windows;
  if (snapshot?.available !== false && Array.isArray(windows) && windows.some((w) => typeof w.usedPercent === "number")) {
    let worst = 100; let bindingReset: number | undefined;
    for (const w of windows) {
      if (typeof w.usedPercent !== "number") continue;
      const rem = 100 - w.usedPercent;
      if (rem < worst) { worst = rem; bindingReset = w.resetsAt; }
    }
    if (worst <= 0) return { engine, state: "exhausted", remainingPercent: Math.max(0, worst), resetsAt: bindingReset ?? recordedReset, source: "live" };
    if (worst <= lowPercent) return { engine, state: "low", remainingPercent: worst, resetsAt: bindingReset, source: "live" };
    return { engine, state: "ok", remainingPercent: worst, source: "live" };
  }
  // No usable live snapshot — fall back to the recorded "rate-limited until" clock.
  if (recordedReset !== undefined) return { engine, state: "exhausted", resetsAt: recordedReset, source: "recorded" };
  return { engine, state: "unknown", source: "none" };
}

/** Live usage status for one engine (recorded clock + actual snapshot). */
export async function getEngineUsageStatus(
  engine: string, config: CuttlefishConfig, opts: { now?: number } = {},
): Promise<UsageStatus> {
  const { lowPercent, fallbackWindowMins } = usageConfig(config);
  const now = opts.now ?? Date.now();
  const recordedReset = getRecordedReset(engine, fallbackWindowMins, now);
  if (engine === "kiro") {
    const estimated = getKiroCreditUsageStatus(config, { now });
    if (recordedReset !== undefined && estimated.state !== "exhausted") {
      return {
        engine,
        state: "exhausted",
        remainingPercent: estimated.remainingPercent,
        resetsAt: recordedReset,
        source: "recorded",
        estimated: true,
      };
    }
    return estimated;
  }
  let snapshot: SnapshotLike | undefined;
  try {
    const resp = await collectEngineLimits(config, { engine });
    const s = resp.engines[engine] as unknown as SnapshotLike & { status?: string };
    if (s && s.available && (s.status === "live" || s.status === "snapshot")) snapshot = s;
  } catch { /* snapshot best-effort; recorded clock still applies */ }
  return statusFromInputs(engine, { recordedReset, snapshot, lowPercent });
}

// ── recovery plan (pure) ─────────────────────────────────────────────────────
export interface UsagePlan {
  action: "proceed" | "switch" | "wait";
  toEngine?: string;
  /** Epoch seconds to resume at (action === "wait"). */
  waitUntil?: number;
  waitMs?: number;
  reason: string;
}

const score = (s: UsageStatus): number =>
  typeof s.remainingPercent === "number" ? s.remainingPercent : (s.state === "unknown" ? 50 : 0);

/**
 * Deterministic recovery decision: proceed on the current engine, switch to the
 * healthiest available alternate, or wait until the earliest known reset (bounded
 * by maxWait; falls back to the 3h window when no reset is known). Pure.
 */
export function planUsageRecovery(opts: {
  fromEngine: string;
  statuses: Record<string, UsageStatus>;
  isAvailable: (engine: string) => boolean;
  config: CuttlefishConfig;
  now?: number;
}): UsagePlan {
  const { fromEngine, statuses, isAvailable, config } = opts;
  const now = opts.now ?? Date.now();
  const { fallbackWindowMins, maxWaitMins } = usageConfig(config);
  const from = statuses[fromEngine];

  const candidates = Object.values(statuses)
    .filter((s) => s.engine !== fromEngine && isAvailable(s.engine) && s.state !== "exhausted")
    .sort((a, b) => score(b) - score(a));

  const fromUsable = !!from && (from.state === "ok" || from.state === "unknown") && isAvailable(fromEngine);
  if (fromUsable) return { action: "proceed", reason: `${fromEngine} ${from!.state}` };

  if (candidates.length) {
    const best = candidates[0];
    // If we're only "low" (not exhausted) and the best alternate is also merely low,
    // don't thrash — stay put. Otherwise move to the healthier engine.
    if (from && from.state === "low" && best.state === "low") {
      return { action: "proceed", reason: "current and alternates only low — staying" };
    }
    return { action: "switch", toEngine: best.engine, reason: `${fromEngine} ${from?.state ?? "unknown"} → ${best.engine} ${best.state} (${Math.round(score(best))}% left)` };
  }

  // Nobody available — wait until the earliest known future reset, bounded.
  const resets = Object.values(statuses)
    .map((s) => s.resetsAt)
    .filter((x): x is number => typeof x === "number" && x * 1000 > now);
  let waitUntilMs = resets.length ? Math.min(...resets) * 1000 + 10_000 : now + fallbackWindowMins * 60_000;
  const cap = now + maxWaitMins * 60_000;
  const capped = waitUntilMs > cap;
  if (capped) waitUntilMs = cap;
  return {
    action: "wait",
    waitUntil: Math.floor(waitUntilMs / 1000),
    waitMs: waitUntilMs - now,
    reason: resets.length
      ? `all engines exhausted — wait until earliest reset${capped ? " (capped at maxWait)" : ""}`
      : `all engines exhausted, no reset known — wait ${fallbackWindowMins}m fallback window`,
  };
}

/** Convenience: gather usage status for several engines, then plan recovery. */
export async function planUsageRecoveryLive(opts: {
  fromEngine: string;
  engines: string[];
  config: CuttlefishConfig;
  isAvailable: (engine: string) => boolean;
  now?: number;
}): Promise<{ plan: UsagePlan; statuses: Record<string, UsageStatus> }> {
  const now = opts.now ?? Date.now();
  const statuses: Record<string, UsageStatus> = {};
  await Promise.all(opts.engines.map(async (e) => { statuses[e] = await getEngineUsageStatus(e, opts.config, { now }); }));
  const plan = planUsageRecovery({ fromEngine: opts.fromEngine, statuses, isAvailable: opts.isAvailable, config: opts.config, now });
  return { plan, statuses };
}
