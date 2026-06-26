import cron from "node-cron";
import type { ScheduledTask } from "node-cron";
import crypto from "node:crypto";
import type {
  CronJob,
  CuttlefishConfig,
  Connector,
  CronRunEntry,
} from "../shared/types.js";
import { runCronJob } from "./runner.js";
import { logger } from "../shared/logger.js";
import type { SessionManager } from "../sessions/manager.js";
import { appendRunLog, loadJobs, saveJobs } from "./jobs.js";

let tasks: ScheduledTask[] = [];
let currentSessionManager: SessionManager;
let currentConfig: CuttlefishConfig;
let currentConnectors: Map<string, Connector>;
const inFlight = new Set<string>();

export type CronRunStart =
  | { started: true; runId: string; promise: Promise<CronRunEntry> }
  | { started: false; run: CronRunEntry };

export type CronTriggerResult =
  | { found: false }
  | { found: true; job: CronJob; started: true; runId: string }
  | { found: true; job: CronJob; started: false; run: CronRunEntry };

export function startScheduler(
  jobs: CronJob[],
  sessionManager: SessionManager,
  config: CuttlefishConfig,
  connectors: Map<string, Connector>,
): void {
  currentSessionManager = sessionManager;
  currentConfig = config;
  currentConnectors = connectors;
  scheduleJobs(jobs);
}

export function reloadScheduler(jobs: CronJob[], config?: CuttlefishConfig, connectors?: Map<string, Connector>): void {
  if (config) currentConfig = config;
  if (connectors) currentConnectors = connectors;
  stopScheduler();
  scheduleJobs(jobs);
}

export function stopScheduler(): void {
  for (const task of tasks) {
    task.stop();
  }
  tasks = [];
}

function scheduleJobs(jobs: CronJob[]): void {
  for (const job of jobs) {
    if (!job.enabled) continue;
    if (!cron.validate(job.schedule)) {
      logger.warn(
        `Invalid cron schedule for job "${job.name}": ${job.schedule}`,
      );
      continue;
    }
    const task = cron.schedule(
      job.schedule,
      () => {
        const started = startCronJobRun(job, currentSessionManager, currentConfig, currentConnectors, "scheduled");
        if (!started.started) {
          logger.warn(`Cron job "${job.name}" skipped: previous run still in flight`);
          return;
        }
        started.promise.catch((err) => {
          logger.error(`Cron job "${job.name}" crashed: ${err instanceof Error ? err.message : err}`);
        });
      },
      { timezone: job.timezone },
    );
    tasks.push(task);
    logger.info(`Scheduled cron job "${job.name}" (${job.schedule})`);
  }
}

export function isCronJobRunning(jobId: string): boolean {
  return inFlight.has(jobId);
}

export function startCronJobRun(
  job: CronJob,
  sessionManager: SessionManager,
  config: CuttlefishConfig,
  connectors: Map<string, Connector>,
  trigger: CronRunEntry["trigger"],
): CronRunStart {
  if (inFlight.has(job.id)) {
    const now = new Date().toISOString();
    const run: CronRunEntry = {
      runId: crypto.randomUUID(),
      timestamp: now,
      startedAt: now,
      finishedAt: now,
      status: "skipped_overlap",
      trigger,
      error: "Previous run still in flight",
      resultPreview: null,
    };
    appendRunLog(job.id, run);
    return { started: false, run };
  }

  const runId = crypto.randomUUID();
  inFlight.add(job.id);
  const promise = runCronJob(job, sessionManager, config, connectors, { runId, trigger })
    .finally(() => {
      inFlight.delete(job.id);
    });
  return { started: true, runId, promise };
}

export async function triggerCronJob(idOrName: string): Promise<CronTriggerResult> {
  const job = findJob(idOrName);
  if (!job) return { found: false };
  const started = startCronJobRun(job, currentSessionManager, currentConfig, currentConnectors, "manual");
  if (!started.started) return { found: true, job, started: false, run: started.run };
  await started.promise;
  return { found: true, job, started: true, runId: started.runId };
}

export function setCronJobEnabled(idOrName: string, enabled: boolean): CronJob | undefined {
  const jobs = loadJobs();
  const index = jobs.findIndex((job) => matchesJob(job, idOrName));
  if (index === -1) return undefined;
  jobs[index] = { ...jobs[index], enabled };
  saveJobs(jobs);
  reloadScheduler(jobs);
  return jobs[index];
}

function findJob(idOrName: string): CronJob | undefined {
  return loadJobs().find((job) => matchesJob(job, idOrName));
}

function matchesJob(job: CronJob, idOrName: string): boolean {
  const needle = idOrName.trim().toLowerCase();
  return job.id.toLowerCase() === needle || job.name.toLowerCase() === needle;
}
