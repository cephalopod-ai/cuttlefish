import fs from "node:fs";
import path from "node:path";
import { CUTTLEFISH_HOME } from "./paths.js";
import { safeWriteFile } from "./safe-write.js";
import type { CuttlefishConfig } from "./types.js";

const KIRO_USAGE_DIR = path.join(CUTTLEFISH_HOME, "usage");
const KIRO_CREDITS_FILE = path.join(KIRO_USAGE_DIR, "kiro-credits.json");

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
    safeWriteFile(KIRO_CREDITS_FILE, JSON.stringify(next, null, 2));
  } catch {
    /* best-effort local usage estimate */
  }
  return next;
}
