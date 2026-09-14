import { canonicalSha256 } from "../../shared/canonical-json.js";
import type { RunContractV1 } from "./schema.js";
import type { SourceSnapshotHashInputV1, StageGraphV1 } from "./types.js";

/**
 * Contract-domain hashing, built on `shared/canonical-json.ts`. This module
 * is the single place that decides which fields are hash-domain (content
 * identity) vs. sibling metadata for each hashed record — see each
 * function's doc comment. RC-FLOW-4 (the audit's canonicalization finding)
 * is resolved here: no caller hashes a contract-domain object with a raw
 * `JSON.stringify` anywhere else in `contracts/`.
 */

/**
 * SHA-256 of the entire contract body. Callers must pass the *parsed*
 * contract (post `runContractV1Schema.parse`), not raw input — hashing
 * after Zod defaults are materialized means two semantically identical
 * inputs (one that omits an optional field, one that states its default
 * explicitly) hash identically.
 */
export function canonicalizeRunContract(contract: RunContractV1): string {
  return canonicalSha256(contract);
}

/**
 * SHA-256 of just the task-identity-defining fields, independent of a
 * contract's success criteria, validation steps, review policy, or gates.
 * Two revisions of the same underlying task (see `service.ts#reviseContract`,
 * which always mints a new `contract_id`) share a `task_sha256` even when
 * their `contract_sha256` differs because a criterion or gate changed.
 */
export function hashTaskIdentity(
  contract: Pick<RunContractV1, "taskId" | "coordinatorId" | "mode" | "prompt" | "cwd">,
): string {
  return canonicalSha256({
    taskId: contract.taskId,
    coordinatorId: contract.coordinatorId,
    mode: contract.mode,
    prompt: contract.prompt,
    cwd: contract.cwd,
  });
}

/** SHA-256 of a compiled stage graph. */
export function canonicalizeStageGraph(graph: StageGraphV1): string {
  return canonicalSha256(graph);
}

/**
 * SHA-256 of only the RC-FLOW-4-safe subset of a source snapshot. The
 * parameter type itself (`SourceSnapshotHashInputV1`) structurally excludes
 * `capturedAt`/`bootGeneration` — see its doc comment in `types.ts` — so a
 * caller cannot accidentally pass the volatile fields in even if the full
 * `SourceSnapshotV1` record is what they have in hand.
 */
export function canonicalizeSourceSnapshotForHash(input: SourceSnapshotHashInputV1): string {
  return canonicalSha256(input);
}

export interface ManifestEntry {
  id: string;
  sha256: string;
}

/**
 * Stable hash of an ordered set of (id, sha256) references — used for
 * input/output/evidence manifest hashes so a gate decision or an attempt's
 * recorded output can be bound to the exact set of upstream artifacts it
 * considered (RC-INV-007). Entry order is preserved, not sorted: order
 * reflects producer sequencing and is part of what the hash attests to.
 */
export function hashManifest(entries: ManifestEntry[]): string {
  return canonicalSha256(entries.map((entry) => ({ id: entry.id, sha256: entry.sha256 })));
}
