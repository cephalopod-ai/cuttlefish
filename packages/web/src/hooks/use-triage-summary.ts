import { useApprovals } from "./use-approvals"
import { useCommandCenter } from "./use-command-center"
import { useCronJobs } from "./use-cron"
import { useEngineLimits } from "./use-engine-limits"
import { countAtRiskEngines, countBrokenCronJobs } from "@/lib/triage"

export interface TriageSummary {
  pendingApprovals: number
  blockedTickets: number
  brokenCronJobs: number
  atRiskLimits: number
  total: number
  isLoading: boolean
}

/**
 * The operator's "what needs my attention right now" rollup — shared by the
 * Command Center triage strip and the attention-aware landing redirect, so
 * they can never disagree about what counts as needing attention. Each
 * underlying query is already used elsewhere in the app (approvals badge,
 * command center, cron page, limits page), so mounting this hook doesn't
 * introduce new network traffic beyond what those surfaces already fetch —
 * TanStack Query dedupes by query key.
 */
export function useTriageSummary(): TriageSummary {
  const approvals = useApprovals("pending")
  const commandCenter = useCommandCenter()
  const cronJobs = useCronJobs()
  const engineLimits = useEngineLimits()

  const pendingApprovals = approvals.data?.length ?? 0
  const blockedTickets = commandCenter.data?.ticketCounts?.blocked ?? 0
  const brokenCronJobs = countBrokenCronJobs(cronJobs.data as { scheduleValid?: boolean }[] | undefined)
  const atRiskLimits = countAtRiskEngines(engineLimits.data)

  return {
    pendingApprovals,
    blockedTickets,
    brokenCronJobs,
    atRiskLimits,
    total: pendingApprovals + blockedTickets + brokenCronJobs + atRiskLimits,
    isLoading: approvals.isLoading || commandCenter.isLoading || cronJobs.isLoading || engineLimits.isLoading,
  }
}
