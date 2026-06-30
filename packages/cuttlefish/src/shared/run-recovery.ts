import { logger } from "./logger.js";
import { getRunLedger } from "../run-ledger/index.js";

/**
 * Boot-time scan for orphaned run-ledger entries in non-terminal states.
 * Any run that has no corresponding live owner (session or orchestration allocation)
 * is transitioned to `interrupted` with a recovery notice.
 *
 * Recovery NEVER maps to `completed`; fail-closed rule.
 *
 * @param liveSessionIds Set of session IDs that are actively running (post-recovery).
 * @param liveAllocationIds Set of allocationIds that are live in orchestration.
 * @returns Count of runs swept.
 */
export function recoverOrphanedRunsAtStartup(
  liveSessionIds: Set<string>,
  liveAllocationIds: Set<string>,
): number {
  const ledger = getRunLedger();
  const nonTerminal = ledger.listRuns({ states: ["created", "running", "blocked"] });
  let swept = 0;
  const at = new Date().toISOString();
  for (const run of nonTerminal) {
    const isLiveSession = run.sessionId !== null && liveSessionIds.has(run.sessionId);
    const isLiveAllocation = run.engine === "orchestration" && run.sourceRef !== null && liveAllocationIds.has(run.sourceRef);
    if (isLiveSession || isLiveAllocation) continue;
    try {
      ledger.transitionRun({
        runId: run.runId,
        nextState: "interrupted",
        errorMessage: "Run owner not found at startup recovery",
        at,
      });
      swept += 1;
    } catch (err) {
      logger.warn(`run-recovery: could not mark orphaned run ${run.runId} as interrupted: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (swept > 0) {
    logger.info(`run-recovery: startup scan marked ${swept} orphaned run(s) as interrupted`);
  }
  return swept;
}
