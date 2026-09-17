import fs from "node:fs";
import path from "node:path";
import type { CronJob, CronRunEntry } from "../shared/types.js";
import { CRON_JOBS, CRON_RUNS } from "../shared/paths.js";
import { safeWriteFile } from "../shared/safe-write.js";
import { logger } from "../shared/logger.js";
import { buildCronJob, parseStoredCronJob, patchCronJob, sanitizeCronLogId } from "./validation.js";

interface CronJobsCacheEntry {
  fingerprint: string;
  jobs: CronJob[];
}

let cronJobsCache: CronJobsCacheEntry | null = null;

function cloneJobs(jobs: CronJob[]): CronJob[] {
  return jobs.map((job) => structuredClone(job));
}

function jobsFingerprint(): string {
  try {
    const stat = fs.statSync(CRON_JOBS);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw err;
  }
}

export function resetLoadJobsCacheForTests(): void {
  cronJobsCache = null;
}

/** Backs up the current jobs.json contents next to the original, best-effort. */
function backupJobsFile(suffix: string): string | null {
  const backupPath = `${CRON_JOBS}.${suffix}-${Date.now()}`;
  try {
    fs.copyFileSync(CRON_JOBS, backupPath);
    return backupPath;
  } catch (err) {
    logger.error(
      `Failed to back up cron jobs file ${CRON_JOBS}: ${err instanceof Error ? err.message : err}. ` +
      "The original remains on disk; preserve it before repair.",
    );
    return null;
  }
}

function backupStatus(backupPath: string | null): string {
  return backupPath ? `Original copy saved to ${backupPath}` : "No backup copy was saved; original remains on disk";
}

export function loadJobs(): CronJob[] {
  const fingerprint = jobsFingerprint();
  if (cronJobsCache?.fingerprint === fingerprint) return cloneJobs(cronJobsCache.jobs);

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
    cronJobsCache = { fingerprint, jobs: [] };
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Corrupt JSON: preserve the broken file for the operator, then run with no jobs.
    const backupPath = backupJobsFile("corrupt");
    logger.error(
      `Failed to parse cron jobs file ${CRON_JOBS}: ${err instanceof Error ? err.message : err}. ` +
      `${backupStatus(backupPath)}; running with zero cron jobs.`,
    );
    cronJobsCache = { fingerprint, jobs: [] };
    return [];
  }
  if (!Array.isArray(parsed)) {
    const backupPath = backupJobsFile("corrupt");
    logger.error(
      `Cron jobs file ${CRON_JOBS} did not contain a JSON array. ` +
      `${backupStatus(backupPath)}; running with zero cron jobs.`,
    );
    cronJobsCache = { fingerprint, jobs: [] };
    return [];
  }

  // Runtime shape validation (DAT-BUS-005): JSON.parse only guarantees valid JSON
  // syntax, not a valid CronJob shape. A hand-edited or version-skewed jobs.json
  // can contain entries with missing/wrong-typed fields (e.g. a non-string id),
  // which would otherwise be scheduled as-is. Validate each entry's shape (not
  // its schedule validity — an invalid schedule is intentionally surfaced via the
  // API rather than hidden, see `parseStoredCronJob`'s doc comment), drop
  // structurally invalid entries (following the same backup-and-continue pattern
  // used above for corrupt JSON), and keep running with the valid subset.
  const validJobs: CronJob[] = [];
  let invalidCount = 0;
  for (const entry of parsed) {
    try {
      validJobs.push(parseStoredCronJob(entry));
    } catch (err) {
      invalidCount += 1;
      logger.warn(
        `Dropping invalid cron job entry in ${CRON_JOBS}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  if (invalidCount > 0) {
    const backupPath = backupJobsFile("invalid");
    logger.warn(
      `${invalidCount} invalid cron job entr${invalidCount === 1 ? "y" : "ies"} dropped from ${CRON_JOBS}. ` +
      `${backupStatus(backupPath)}; running with ${validJobs.length} valid job(s).`,
    );
  }
  cronJobsCache = { fingerprint, jobs: cloneJobs(validJobs) };
  return validJobs;
}

export class CronJobsStateError extends Error {
  constructor() {
    super("Cron jobs file is invalid; repair it before modifying jobs");
    this.name = "CronJobsStateError";
  }
}

/** Runtime reads may continue with a valid subset. Mutations must preserve the
 * complete original when its syntax or any stored entry is invalid. Never use
 * the degraded read cache as permission to replace that state. */
export function loadJobsForMutation(): CronJob[] {
  let raw: string;
  try {
    raw = fs.readFileSync(CRON_JOBS, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new CronJobsStateError();
    return parsed.map((entry) => parseStoredCronJob(entry));
  } catch {
    throw new CronJobsStateError();
  }
}

export function saveJobs(jobs: CronJob[]): void {
  loadJobsForMutation();
  // Atomic replacement, file fsync and audit for canonical, low-churn state.
  safeWriteFile(CRON_JOBS, JSON.stringify(jobs, null, 2) + "\n", {
    audit: { actor: "gateway", op: "cron.save" },
  });
  cronJobsCache = null;
}

export class CronIdConflictError extends Error {
  constructor() {
    super("Cron job id already exists or shares an existing job's run-log filename");
    this.name = "CronIdConflictError";
  }
}

export class CronJobValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronJobValidationError";
  }
}

/** Validate identity and persist without an await between loading and saving. */
export function createCronJob(body: unknown): { job: CronJob; jobs: CronJob[] } {
  let job: CronJob;
  try {
    job = buildCronJob(body);
  } catch (err) {
    throw new CronJobValidationError(err instanceof Error ? err.message : "Invalid cron job");
  }
  const jobs = loadJobsForMutation();
  // Legacy IDs remain readable, but new jobs must not share their normalized log.
  if (jobs.some((existing) => sanitizeCronLogId(existing.id) === job.id)) {
    throw new CronIdConflictError();
  }
  jobs.push(job);
  saveJobs(jobs);
  return { job, jobs };
}

export function updateCronJob(id: string, body: unknown): { job: CronJob; jobs: CronJob[] } | null {
  const jobs = loadJobsForMutation();
  const index = jobs.findIndex((job) => job.id === id);
  if (index === -1) return null;
  let job: CronJob;
  try {
    job = { ...patchCronJob(jobs[index], body), id };
  } catch (err) {
    throw new CronJobValidationError(err instanceof Error ? err.message : "Invalid cron update");
  }
  jobs[index] = job;
  saveJobs(jobs);
  return { job, jobs };
}

export function deleteCronJob(id: string): { removed: CronJob; jobs: CronJob[] } | null {
  const jobs = loadJobsForMutation();
  const index = jobs.findIndex((job) => job.id === id);
  if (index === -1) return null;
  const removed = jobs.splice(index, 1)[0];
  saveJobs(jobs);
  return { removed, jobs };
}

export function cronRunLogPath(jobId: string): string {
  return path.join(CRON_RUNS, `${sanitizeCronLogId(jobId)}.jsonl`);
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
  // jobId is attacker/user-controlled via the cron API body (SEC-CFDB-005); sanitize
  // it before it becomes part of the run-log path so control chars/newlines cannot
  // forge fake log entries and path separators cannot escape CRON_RUNS.
  const logPath = cronRunLogPath(jobId);
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
  pruneRunLog(logPath, opts.maxEntries ?? DEFAULT_MAX_RUN_LOG_ENTRIES);
}
