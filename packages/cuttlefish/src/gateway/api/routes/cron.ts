import cron from "node-cron";
import fs from "node:fs";
import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import type { CronJob } from "../../../shared/types.js";
import { logger } from "../../../shared/logger.js";
import { createCronJob, updateCronJob, deleteCronJob, CronIdConflictError, CronJobValidationError, CronJobsStateError, cronRunLogPath, loadJobs } from "../../../cron/jobs.js";
import { reloadScheduler, startCronJobRun } from "../../../cron/scheduler.js";
import { readJsonBody } from "../../http-helpers.js";
import { readJsonlTail } from "../../jsonl-tail.js";
import type { ApiContext } from "../context.js";
import { matchRoute } from "../match-route.js";
import { badRequest, json, notFound } from "../responses.js";

function serializeCronJob(job: CronJob, lastRun: Record<string, unknown> | null = null): Record<string, unknown> {
  const scheduleValid = cron.validate(job.schedule);
  return {
    ...job,
    lastRun,
    scheduleValid,
    scheduleError: scheduleValid ? null : `Invalid cron schedule: ${job.schedule}`,
  };
}

function respondToMutationError(err: unknown, res: ServerResponse): boolean {
  if (err instanceof CronJobsStateError || err instanceof CronIdConflictError) {
    json(res, { error: err.message, code: err instanceof CronJobsStateError ? "CRON_INVALID_ON_DISK" : "CRON_ID_CONFLICT" }, 409);
    return true;
  }
  if (err instanceof CronJobValidationError) {
    badRequest(res, err.message);
    return true;
  }
  return false;
}

export async function handleCronRoutes(
  method: string,
  pathname: string,
  req: HttpRequest,
  url: URL,
  res: ServerResponse,
  context: ApiContext,
): Promise<boolean> {
  let params = matchRoute("/api/cron/:id/runs", pathname);
  if (method === "GET" && params) {
    const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") || "", 10) || 50));
    const runId = url.searchParams.get("runId");
    const runFile = cronRunLogPath(params.id);
    const { entries, skipped } = await readJsonlTail(runFile, runId ? 500 : limit * 4);
    const seen = new Set<string>();
    const runs = [];
    for (const entry of entries as Record<string, unknown>[]) {
      const id = typeof entry.runId === "string" ? entry.runId : JSON.stringify(entry);
      if (runId && id !== runId) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      runs.push(entry);
      if (runs.length >= limit) break;
    }
    if (skipped) logger.warn(`GET /api/cron/${params.id}/runs: skipped ${skipped} corrupt line(s)`);
    json(res, runs);
    return true;
  }

  if (method === "GET" && pathname === "/api/cron") {
    const jobs = loadJobs();
    const enriched = await Promise.all(jobs.map(async (job) => {
      const runFile = cronRunLogPath(job.id);
      const { entries } = await readJsonlTail(runFile, 1);
      return serializeCronJob(job, (entries[0] as Record<string, unknown> | undefined) ?? null);
    }));
    json(res, enriched);
    return true;
  }

  if (method === "POST" && pathname === "/api/cron") {
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    let created: ReturnType<typeof createCronJob>;
    try {
      created = createCronJob(parsed.body);
    } catch (err) {
      if (respondToMutationError(err, res)) return true;
      throw err;
    }
    reloadScheduler(created.jobs, context.getConfig(), context.connectors);
    json(res, created.job, 201);
    return true;
  }

  params = matchRoute("/api/cron/:id", pathname);
  if (method === "PUT" && params) {
    const routeParams = params;
    // Read the body before the synchronous domain mutation (CONC-004), so
    // concurrent gateway requests cannot interleave its load and save.
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    let updated: ReturnType<typeof updateCronJob>;
    try {
      updated = updateCronJob(routeParams.id, parsed.body);
    } catch (err) {
      if (respondToMutationError(err, res)) return true;
      throw err;
    }
    if (!updated) {
      notFound(res);
      return true;
    }
    reloadScheduler(updated.jobs, context.getConfig(), context.connectors);
    json(res, updated.job);
    return true;
  }

  params = matchRoute("/api/cron/:id", pathname);
  if (method === "DELETE" && params) {
    const routeParams = params;
    let deleted: ReturnType<typeof deleteCronJob>;
    try {
      deleted = deleteCronJob(routeParams.id);
    } catch (err) {
      if (respondToMutationError(err, res)) return true;
      throw err;
    }
    if (!deleted) {
      notFound(res);
      return true;
    }
    const { removed, jobs } = deleted;
    reloadScheduler(jobs, context.getConfig(), context.connectors);
    json(res, { deleted: removed.id, name: removed.name });
    return true;
  }

  params = matchRoute("/api/cron/:id/trigger", pathname);
  if (method === "POST" && params) {
    const jobs = loadJobs();
    const job = jobs.find((entry) => entry.id === params.id);
    if (!job) {
      notFound(res);
      return true;
    }
    if (!job.enabled) {
      json(res, { error: "Cron job is disabled", jobId: job.id, status: "disabled" }, 409);
      return true;
    }

    logger.info(`Manual trigger for cron job "${job.name}" (${job.id})`);
    const started = startCronJobRun(job, context.sessionManager, context.getConfig(), context.connectors, "manual");
    if (!started.started) {
      json(res, { error: "Cron job already running", jobId: job.id, status: started.run.status, runId: started.run.runId }, 409);
      return true;
    }
    started.promise.catch((err) => logger.error(`Manual cron trigger failed for "${job.name}": ${err}`));
    json(res, {
      status: "running",
      triggered: true,
      runId: started.runId,
      jobId: job.id,
      name: job.name,
      employee: job.employee,
      message: `Cron job "${job.name}" triggered manually`,
    }, 202);
    return true;
  }

  return false;
}
