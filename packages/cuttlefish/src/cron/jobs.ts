import fs from "node:fs";
import path from "node:path";
import type { CronJob, CronRunEntry } from "../shared/types.js";
import { CRON_JOBS, CRON_RUNS } from "../shared/paths.js";
import { safeWriteFile } from "../shared/safe-write.js";
import { logger } from "../shared/logger.js";

export function loadJobs(): CronJob[] {
  let raw: string;
  try {
    raw = fs.readFileSync(CRON_JOBS, "utf-8");
  } catch (err) {
    // Missing file is normal (no cron jobs configured yet); anything else is not.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.error(
        `Failed to read cron jobs file ${CRON_JOBS}: ${err instanceof Error ? err.message : err}`,
      );
    }
    return [];
  }
  try {
    return JSON.parse(raw) as CronJob[];
  } catch (err) {
    // Corrupt JSON: preserve the broken file for the operator, then run with no jobs.
    const backupPath = `${CRON_JOBS}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(CRON_JOBS, backupPath);
    } catch {
      // best effort — the original file is still on disk
    }
    logger.error(
      `Failed to parse cron jobs file ${CRON_JOBS}: ${err instanceof Error ? err.message : err}. ` +
      `Corrupt copy saved to ${backupPath}; running with zero cron jobs.`,
    );
    return [];
  }
}

export function saveJobs(jobs: CronJob[]): void {
  // Atomic + fsync-durable + audited (canonical, low-churn state).
  safeWriteFile(CRON_JOBS, JSON.stringify(jobs, null, 2) + "\n", {
    audit: { actor: "gateway", op: "cron.save" },
  });
}

export const DEFAULT_MAX_RUN_LOG_ENTRIES = 1000;

function pruneRunLog(logPath: string, maxEntries: number): void {
  if (maxEntries <= 0) return;
  let raw: string;
  try {
    raw = fs.readFileSync(logPath, "utf-8");
  } catch {
    return;
  }
  const lines = raw.split("\n").filter(Boolean);
  if (lines.length <= maxEntries) return;
  const kept = lines.slice(-maxEntries).join("\n") + "\n";
  safeWriteFile(logPath, kept);
}

export function appendRunLog(jobId: string, entry: CronRunEntry, opts: { maxEntries?: number } = {}): void {
  fs.mkdirSync(CRON_RUNS, { recursive: true });
  const logPath = path.join(CRON_RUNS, `${jobId}.jsonl`);
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
  pruneRunLog(logPath, opts.maxEntries ?? DEFAULT_MAX_RUN_LOG_ENTRIES);
}
