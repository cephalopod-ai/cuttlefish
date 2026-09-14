import {
  ATTEMPT_STATES,
  CONTRACT_PHASES,
  TERMINAL_CONTRACT_PHASES,
  type AttemptFailureKind,
  type AttemptState,
  type ContractPhase,
} from "./types.js";

export { ATTEMPT_STATES, CONTRACT_PHASES, TERMINAL_CONTRACT_PHASES };
export type { AttemptState, ContractPhase };

/**
 * Pure transition predicates for the contract-phase and attempt-state
 * machines, plus outcome computation. Nothing here touches the database —
 * `contracts/store.ts` calls these functions before performing a CAS write
 * and refuses the write if the requested transition is illegal, per
 * RC-INV-016.
 *
 * The contract-phase graph below folds in every diagram gap the audit found
 * in the original proposal:
 *   - `dead_lettered` is reachable from `blocked_resource` and
 *     `awaiting_human` (RC-REL-1, Critical — the original diagram had no
 *     path to this outcome at all).
 *   - `reviewing` cannot reach `passed` without visiting `validating`
 *     (RC-STATE-1 — enforced by `computeContractOutcome`, not by this graph
 *     alone, since the graph only says an edge is *reachable*, not that
 *     skipping validation would produce a passing outcome).
 *   - The bounded review/revise loop has an explicit exit to `failed`
 *     (RC-FLOW-2) instead of no drawn exit at all.
 *   - `applying` has a mandatory edge into `validating` (RC-FLOW-3) instead
 *     of being a dead-end leaf.
 *   - `executing` can re-enter `blocked_resource` for a stage-level
 *     allocation timeout (RC-REL-3), not just once at the very start.
 *
 * `awaiting_human` is one phase value reached for several different
 * reasons (stale source, post-apply validation failure, dual-lane
 * selection). This graph unions every reason's legal outgoing edges rather
 * than modeling "awaiting_human" as several sub-phases — the graph answers
 * "is phase A -> phase B ever legal", and the *contextual* rule for which
 * edge applies to a specific occurrence (recorded as a `reason` alongside
 * the phase, not part of this enum) is enforced by the caller (`service.ts`
 * / `executor.ts`), which has that context and this module deliberately
 * does not.
 */
const CONTRACT_PHASE_EDGES: Record<ContractPhase, ReadonlySet<ContractPhase>> = {
  accepted: new Set(["blocked_resource", "preparing"]),
  blocked_resource: new Set(["preparing", "dead_lettered"]),
  preparing: new Set(["stale_source", "executing"]),
  stale_source: new Set(["awaiting_human"]),
  awaiting_human: new Set(["superseded", "dead_lettered", "applying", "failed"]),
  executing: new Set(["reviewing", "comparing", "validating", "awaiting_human", "blocked_resource"]),
  reviewing: new Set(["revising", "validating", "failed"]),
  revising: new Set(["reviewing", "failed"]),
  comparing: new Set(["awaiting_human"]),
  applying: new Set(["validating"]),
  validating: new Set(["awaiting_human", "passed", "failed"]),
  superseded: new Set(),
  cancelled: new Set(),
  passed: new Set(),
  failed: new Set(),
  dead_lettered: new Set(),
};

/**
 * True if `from -> to` is a legal contract-phase transition. Every
 * non-terminal phase may transition to `cancelled` (an explicit operator
 * cancel is always available, per the original design) — handled as a
 * blanket rule here rather than repeated in every edge set above.
 */
export function canTransitionContractPhase(from: ContractPhase, to: ContractPhase): boolean {
  if (to === "cancelled") return !TERMINAL_CONTRACT_PHASES.has(from);
  return CONTRACT_PHASE_EDGES[from]?.has(to) ?? false;
}

/**
 * Attempt-state graph. `running -> cancelled` exists only for a confirmed,
 * intentional operator cancel (RC-STATE-2) — the caller (`executor.ts`)
 * verifies the underlying process is reaped before making this transition;
 * this predicate only says the edge is legal, not that it has been earned.
 * `claimed -> claim_lost` is the loser of a concurrent unique-constraint
 * claim race (RC-CONC-1) and, like `cancelled`, never consumes retry
 * budget — see `isRetryEligible`.
 */
const ATTEMPT_STATE_EDGES: Record<AttemptState, ReadonlySet<AttemptState>> = {
  pending: new Set(["claimed", "cancelled"]),
  claimed: new Set(["allocated", "claim_lost", "cancelled"]),
  allocated: new Set(["running", "cancelled"]),
  running: new Set(["succeeded", "failed", "interrupted", "timed_out", "cancelled"]),
  succeeded: new Set(),
  failed: new Set(),
  interrupted: new Set(),
  timed_out: new Set(),
  cancelled: new Set(),
  claim_lost: new Set(),
};

export function canTransitionAttemptState(from: AttemptState, to: AttemptState): boolean {
  return ATTEMPT_STATE_EDGES[from]?.has(to) ?? false;
}

/**
 * Whether an attempt that ended in `state` is eligible for another attempt,
 * given the stage's declared `retryOn` list. `cancelled` and `claim_lost`
 * are NEVER retry-eligible regardless of `retryOn` (RC-STATE-2 / RC-CONC-1):
 * an intentional cancel or a pure contention loss must not be misclassified
 * as a failure worth retrying, and must not consume the stage's bounded
 * `maxAttempts` budget.
 */
export function isRetryEligible(state: AttemptState, retryOn: readonly AttemptFailureKind[]): boolean {
  if (state === "cancelled" || state === "claim_lost") return false;
  if (state === "failed" || state === "interrupted" || state === "timed_out") {
    return retryOn.includes(state);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Stage state — a coarser status than an individual attempt's, tracking
// whether a stage as a whole has satisfied its output contract yet.
// ---------------------------------------------------------------------------

export const STAGE_STATES = ["pending", "runnable", "running", "succeeded", "failed", "skipped"] as const;
export type StageState = typeof STAGE_STATES[number];
export const TERMINAL_STAGE_STATES: ReadonlySet<StageState> = new Set(["succeeded", "failed", "skipped"]);

const STAGE_STATE_EDGES: Record<StageState, ReadonlySet<StageState>> = {
  pending: new Set(["runnable", "skipped"]),
  runnable: new Set(["running", "skipped"]),
  // running -> runnable is the retry loop-back: an attempt failed but the
  // stage still has attempts remaining, so the stage becomes runnable again
  // rather than moving straight to the terminal `failed` state.
  running: new Set(["succeeded", "failed", "runnable"]),
  succeeded: new Set(),
  failed: new Set(),
  skipped: new Set(),
};

export function canTransitionStageState(from: StageState, to: StageState): boolean {
  return STAGE_STATE_EDGES[from]?.has(to) ?? false;
}

export interface StageOutcomeInput {
  required: boolean;
  state: StageState;
}

/**
 * RC-STATE-1's fix. Walks every `required: true` stage and returns
 * `"pending"` unless each one reached `"succeeded"` — never inferred from
 * the contract phase's shape. A contract with an unattempted or failed
 * required `validate` stage can never return `"passed"` here, regardless
 * of what the contract's `phase` column currently shows. Optional-stage
 * state never affects the result (RC-REL-4): a `required: false` stage's
 * failure cannot block the contract, and its success cannot substitute for
 * a required stage's.
 */
export function computeContractOutcome(stages: readonly StageOutcomeInput[]): "passed" | "failed" | "pending" {
  let allRequiredSucceeded = true;
  let anyRequiredFailed = false;
  for (const stage of stages) {
    if (!stage.required) continue;
    if (stage.state === "succeeded") continue;
    allRequiredSucceeded = false;
    if (stage.state === "failed") anyRequiredFailed = true;
  }
  if (allRequiredSucceeded) return "passed";
  if (anyRequiredFailed) return "failed";
  return "pending";
}
