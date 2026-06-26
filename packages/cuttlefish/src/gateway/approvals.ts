import { APPROVALS_FILE } from "../shared/paths.js";
import type { Approval, ApprovalDecision, JsonObject } from "../shared/types.js";
import {
  clearApprovalRecordsForTest,
  createApprovalRecord,
  getApprovalRecord,
  importApprovalsJsonIfNeeded,
  listApprovalRecords,
  resolveApprovalRecord,
} from "../sessions/registry.js";

/**
 * Persisted approval store.
 *
 * A generic human-approval queue backing Feature 1. Today the only producer is
 * model-fallback (`type:"fallback"`), but `tool`/`custom` approvals are accepted
 * by the same store + endpoints so future gates need no schema change.
 *
 * Persisted in the sessions registry database so daemon/CLI instances serialize
 * read-modify-write updates through SQLite instead of clobbering each other's
 * JSON snapshots. Legacy `approvals.json` is imported once per store path.
 */

let storePath = APPROVALS_FILE;

function ensureMigrated(): void {
  importApprovalsJsonIfNeeded(storePath);
}

/** Test seam: point the store at a throwaway file and reset the cache. */
export function __setApprovalsStoreForTest(path: string): void {
  storePath = path;
  clearApprovalRecordsForTest();
}

export function listApprovals(filter?: { state?: Approval["state"] | "all"; sessionId?: string; type?: Approval["type"] | "all" }): Approval[] {
  ensureMigrated();
  return listApprovalRecords(filter);
}

export function getApproval(id: string): Approval | undefined {
  ensureMigrated();
  return getApprovalRecord(id);
}

/**
 * Create an approval. For `fallback` approvals we dedupe per session: a session
 * that re-enters the ask_user branch reuses its existing pending approval rather
 * than stacking duplicates.
 */
export function createApproval(input: {
  sessionId: string;
  type: Approval["type"];
  payload: JsonObject;
}): Approval {
  ensureMigrated();
  return createApprovalRecord(input);
}

export class ApprovalStateError extends Error {
  constructor(public readonly currentState: Approval["state"]) {
    super(`approval is ${currentState}, not pending`);
    this.name = "ApprovalStateError";
  }
}

/**
 * Resolve an approval. Valid only from `pending` (else throws ApprovalStateError
 * → 409 at the endpoint). Idempotent guard prevents double-approve races.
 */
export function resolveApproval(
  id: string,
  state: ApprovalDecision,
  actor?: string | null,
  decisionNotes?: string | null,
  resultingAction?: string | null,
): Approval {
  ensureMigrated();
  const current = getApprovalRecord(id);
  if (!current) throw new Error(`approval ${id} not found`);
  if (current.state !== "pending") throw new ApprovalStateError(current.state);
  const approval = resolveApprovalRecord(id, state, actor, decisionNotes, resultingAction);
  if (!approval) throw new Error(`approval ${id} not found`);
  return approval;
}
