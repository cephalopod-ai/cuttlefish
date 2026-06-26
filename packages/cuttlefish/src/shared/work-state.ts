/**
 * Feature 2: one normalized work lifecycle derived from the fields the daemon
 * already tracks — NO schema change. Both `Session.status` and the queue's
 * `transportState` describe pieces of "what is this session doing"; this folds
 * them (plus the approval flag) into a single state the kanban/org surfaces and
 * `GET /api/work` can group on.
 */

export type WorkState =
  | "queued"
  | "running"
  | "waiting_on_human"
  | "blocked"
  | "completed"
  | "failed";

export const WORK_STATES: readonly WorkState[] = [
  "queued",
  "running",
  "waiting_on_human",
  "blocked",
  "completed",
  "failed",
] as const;

export interface WorkStateInput {
  /** Session.status. */
  status: "idle" | "running" | "error" | "waiting" | "interrupted";
  /** Queue transport state (queue.getTransportState), if known. */
  transportState?: "idle" | "queued" | "running" | "error" | "interrupted";
  /** True when a model-fallback (or other) approval is pending for this session. */
  approvalRequired?: boolean;
  /** Forward-compat: set for cron-bound sessions. Reserved; does not change the
   *  lifecycle state today (a cron session is classified by its run state). */
  cron?: boolean;
}

/**
 * Derive the single work-state. Precedence is most-specific first:
 *   1. approvalRequired              → waiting_on_human  (beats "running"/"waiting")
 *   2. status "waiting" (non-approval)→ blocked
 *   3. status "error"                → failed
 *   4. transportState "queued"       → queued
 *   5. running (status|transport)    → running
 *   6. status "interrupted"          → blocked
 *   7. otherwise (idle)              → completed
 */
export function deriveWorkState(input: WorkStateInput): WorkState {
  if (input.approvalRequired) return "waiting_on_human";
  if (input.status === "waiting") return "blocked";
  if (input.status === "error") return "failed";
  if (input.transportState === "queued") return "queued";
  if (input.status === "running" || input.transportState === "running") return "running";
  if (input.status === "interrupted") return "blocked";
  return "completed";
}

/** Empty per-state counter (all zero) — handy for aggregates. */
export function emptyWorkCounts(): Record<WorkState, number> {
  return { queued: 0, running: 0, waiting_on_human: 0, blocked: 0, completed: 0, failed: 0 };
}
