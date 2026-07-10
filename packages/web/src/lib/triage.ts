import type { EngineLimitsResponse, EngineLimitEngineSnapshot } from "@/lib/api"

/** Any engine with a usage window at or above this is "at risk" of hitting a cap. */
export const AT_RISK_THRESHOLD_PERCENT = 80

function engineIsAtRisk(engine: EngineLimitEngineSnapshot): boolean {
  const windows = engine.windows ?? []
  return windows.some((w) => typeof w.usedPercent === "number" && w.usedPercent >= AT_RISK_THRESHOLD_PERCENT)
}

/** Count of engines with any usage window at or above AT_RISK_THRESHOLD_PERCENT. */
export function countAtRiskEngines(response: EngineLimitsResponse | undefined): number {
  if (!response) return 0
  return Object.values(response.engines).filter(engineIsAtRisk).length
}

interface CronJobLike {
  scheduleValid?: boolean
  [key: string]: unknown
}

/** Count of cron jobs with a broken (invalid) schedule — the "needs attention"
 *  signal already surfaced on the Cron page, reused here for the triage strip. */
export function countBrokenCronJobs(jobs: CronJobLike[] | undefined): number {
  if (!jobs) return 0
  return jobs.filter((job) => job.scheduleValid === false).length
}
