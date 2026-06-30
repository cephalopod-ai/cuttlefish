import type { CuttlefishConfig, OrgHierarchy } from "../shared/types.js";

export interface TurnStallWatchdogConfig {
  tickMs: number;
  leaderCheckMs: number;
  inactivityMs: number;
  hardCeilingMs: number;
  maxRetries: number;
}

function positiveNumberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && value > 0 ? value : fallback;
}

export { positiveNumberOr };

export function resolveTurnStallWatchdogConfig(config: CuttlefishConfig): TurnStallWatchdogConfig {
  const STALL_TICK_MS = 30_000;
  const gatewayConfig = config.gateway ?? {};
  return {
    tickMs: STALL_TICK_MS,
    leaderCheckMs: positiveNumberOr(gatewayConfig.turnStallLeaderCheckMs, 4 * 60_000),
    inactivityMs: positiveNumberOr(gatewayConfig.turnStallInactivityMs, 15 * 60_000),
    hardCeilingMs: positiveNumberOr(gatewayConfig.turnStallCeilingMs, 45 * 60_000),
    maxRetries:
      typeof gatewayConfig.turnStallRetries === "number" && gatewayConfig.turnStallRetries >= 0
        ? Math.floor(gatewayConfig.turnStallRetries)
        : 0,
  };
}

export function shouldRetrySameEngineAfterStall(stallAttempt: number, maxRetries: number): boolean {
  return stallAttempt < maxRetries;
}

export function shouldNotifyLeaderReviewOnStall(input: {
  idleMs: number;
  leaderCheckMs: number;
  inactivityMs: number;
  alreadyNotified: boolean;
}): boolean {
  if (input.alreadyNotified) return false;
  if (input.leaderCheckMs <= 0) return false;
  if (input.idleMs < input.leaderCheckMs) return false;
  return input.idleMs < input.inactivityMs;
}

/**
 * Resolve the name of the nearest managing leader (rank `manager` or
 * `executive`) above an employee in the org hierarchy, used to address a
 * stall leader-review notice. Returns null when the employee is unknown, has no
 * parent chain, or no manager/executive ancestor exists. Pure over the resolved
 * hierarchy so it is testable without a live org scan.
 */
export function resolveStallLeaderName(
  hierarchy: OrgHierarchy,
  employeeName: string | null | undefined,
): string | null {
  if (!employeeName) return null;
  let parentName = hierarchy.nodes[employeeName]?.parentName ?? null;
  while (parentName) {
    const parent = hierarchy.nodes[parentName]?.employee;
    if (!parent) return null;
    if (parent.rank === "manager" || parent.rank === "executive") return parent.name;
    parentName = hierarchy.nodes[parent.name]?.parentName ?? null;
  }
  return null;
}
