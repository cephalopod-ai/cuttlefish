import type { LiveRunMode } from "../live-run.js";
import type { ContractArtifactKind, RunContractV1 } from "./schema.js";

/**
 * Cross-cutting types shared by two or more `contracts/` modules. Kept
 * separate from any single module (rather than, say, exported from
 * `compiler.ts`) so `canonicalize.ts`, `state-machine.ts`, `templates.ts`,
 * and `compiler.ts` can all depend on these shapes without depending on
 * each other's implementation modules.
 */

// ---------------------------------------------------------------------------
// Stage graph (compiler.ts produces these; canonicalize.ts hashes them)
// ---------------------------------------------------------------------------

export type StageKind =
  | "plan"
  | "implement"
  | "review"
  | "revise"
  | "adversarial_review"
  | "validate"
  | "compare"
  | "human_gate"
  | "apply"
  | "report";

/** How a stage's declared output binds to a downstream stage's input when the
 * producing stage has more than one bounded attempt (a revision loop). */
export type AttemptResolutionMode = "latest_succeeded" | "latest_attempt";

export interface ArtifactSelector {
  /** stageKey of the producing stage. */
  fromStageKey: string;
  artifactKind: ContractArtifactKind;
  attemptResolution: AttemptResolutionMode;
}

/** Failure kinds a stage's retry policy may declare as retry-eligible. Not
 * the full attempt-state enum: `cancelled`/`claim_lost` are deliberately
 * excluded here (see state-machine.ts `isRetryEligible`) since retrying them
 * would misclassify an intentional cancel or a pure contention loss as a
 * failure. */
export type AttemptFailureKind = "failed" | "interrupted" | "timed_out";

export interface StageDefinitionV1 {
  id: string;
  kind: StageKind;
  dependsOn: string[];
  roleId?: string;
  requiredExecutionProfile?: ExecutionProfileRequirement;
  inputSelectors: ArtifactSelector[];
  outputContracts: ContractArtifactKind[];
  retryPolicy: { maxAttempts: number; retryOn: AttemptFailureKind[] };
  required: boolean;
  /** Drives the RC-TEMP-1/2 source-drift recheck: the snapshot is rechecked
   * immediately before any stage with `mutatesWorkspace: true` launches. */
  mutatesWorkspace: boolean;
  /** RC-REL-3: bound on how long this stage may wait for a worker before the
   * contract re-enters `blocked_resource`, distinct from a running attempt's
   * own `timeoutMs`. Undefined means "no stage-specific bound" (the compiler
   * always fills in a template default; see templates.ts). */
  allocationTimeoutMs?: number;
}

export interface StageGraphV1 {
  schemaVersion: "1";
  mode: LiveRunMode;
  /** Ordinal-ordered, acyclic. `compiler.ts` guarantees both properties at
   * compile time; nothing downstream re-validates them. */
  stages: StageDefinitionV1[];
}

// ---------------------------------------------------------------------------
// Stage templates (templates.ts defines these; compiler.ts resolves one
// against a specific RunContractV1 into a StageGraphV1)
// ---------------------------------------------------------------------------

/**
 * One stage's fixed shape within a mode template, plus the (code-level, not
 * persisted) predicates the compiler uses to decide whether the stage is
 * included at all for a given contract, and whether an included stage
 * counts toward `computeContractOutcome`. Templates are versioned code
 * constants, not user-authored data — per the design's "no general-purpose
 * workflow DSL" non-goal, `includeIf`/`requiredIf` let a fixed template
 * react to what the contract actually declares (e.g. whether a `validate`
 * stage exists at all depends on whether `contract.validation` is present)
 * without turning the template itself into an executable workflow language.
 */
export interface StageBlueprintV1 {
  key: string;
  kind: StageKind;
  dependsOn: string[];
  roleId?: string;
  /** RC-TEMP-1/2: stages that meaningfully mutate the workspace get a source
   * drift recheck immediately before they launch. */
  mutatesWorkspace: boolean;
  requiredExecutionProfile?: ExecutionProfileRequirement;
  inputSelectors: ArtifactSelector[];
  outputContracts: ContractArtifactKind[];
  /** Include this stage in the compiled graph at all. Absent = always
   * included. */
  includeIf?: (contract: RunContractV1) => boolean;
  /** Once included, whether the stage counts toward outcome computation.
   * Absent = always required. Bounded-loop targets (e.g. `revise`) are
   * never required — see RC-REL-4 / `computeContractOutcome`. */
  requiredIf?: (contract: RunContractV1) => boolean;
  retryPolicy: { maxAttempts: number; retryOn: AttemptFailureKind[] };
  allocationTimeoutMs: number;
}

export interface StageTemplateV1 {
  schemaVersion: "1";
  mode: LiveRunMode;
  stages: StageBlueprintV1[];
}

// ---------------------------------------------------------------------------
// Execution policy (execution-policy.ts, a later stage, implements the
// resolution logic; the shape is needed now because StageDefinitionV1
// references it)
// ---------------------------------------------------------------------------

export type ExecutionProfile =
  | "implementation"
  | "planning_read_only"
  | "review_read_only"
  | "validation_host_process"
  | "report_read_only";

export type EnforcementLevel =
  | "host_enforced"
  | "adapter_enforced"
  | "cli_guarded"
  | "prompt_only"
  | "unsupported";

export interface ExecutionProfileRequirement {
  profile: ExecutionProfile;
  /** Per-field minimum required enforcement level. A field absent here has
   * no requirement (any level, including `unsupported`, satisfies it). */
  require?: Partial<Record<
    "workspaceWrite" | "shell" | "network" | "workspaceBoundary" | "structuredOutput" | "cancellation",
    EnforcementLevel
  >>;
}

// ---------------------------------------------------------------------------
// Source snapshot (source-snapshot.ts, a later stage, captures these; the
// shape is needed now so canonicalize.ts can define the hash-safe subset)
// ---------------------------------------------------------------------------

/**
 * The content-identity subset of a source snapshot: exactly the fields that
 * must be identical for two snapshots to be considered "the same source
 * state" for drift-detection purposes. Structurally excludes `capturedAt`
 * and `bootGeneration` (see `SourceSnapshotV1`) so a future field addition
 * to the full record can't silently leak a volatile field into a hash —
 * this is RC-FLOW-4's fix, enforced by type rather than convention.
 */
export interface SourceSnapshotHashInputV1 {
  repoRootIdentity: string;
  headCommit?: string;
  /** SHA-256 of the tracked diff's content, not the diff text itself, to
   * keep the snapshot record bounded regardless of how large the dirty
   * state is. */
  trackedDiffSha256?: string;
  untrackedManifestSha256?: string;
  repositoryKind: "clean" | "dirty" | "unsupported";
  taskSha256: string;
  contractSha256: string;
  coordinatorTemplateSha256?: string;
  workerRoutingConfigSha256?: string;
  orchestrationPolicySha256?: string;
}

/** The full persisted snapshot record, adding the volatile fields that must
 * never enter `source_snapshot_sha256`'s hash domain. */
export interface SourceSnapshotV1 extends SourceSnapshotHashInputV1 {
  capturedAt: string;
  bootGeneration: number;
}

// ---------------------------------------------------------------------------
// Contract / attempt state machines (state-machine.ts implements the
// transition logic; the enums live here so store.ts/service.ts/views.ts can
// reference them without importing state-machine.ts's transition tables)
// ---------------------------------------------------------------------------

export const CONTRACT_PHASES = [
  "accepted",
  "blocked_resource",
  "preparing",
  "stale_source",
  "awaiting_human",
  "executing",
  "reviewing",
  "revising",
  "comparing",
  "applying",
  "validating",
  "superseded",
  "cancelled",
  "passed",
  "failed",
  "dead_lettered",
] as const;
export type ContractPhase = typeof CONTRACT_PHASES[number];

export const TERMINAL_CONTRACT_PHASES: ReadonlySet<ContractPhase> = new Set([
  "superseded",
  "cancelled",
  "passed",
  "failed",
  "dead_lettered",
]);

export type ContractOutcome = "passed" | "failed" | "cancelled" | "dead_lettered" | "superseded";

export const ATTEMPT_STATES = [
  "pending",
  "claimed",
  "allocated",
  "running",
  "succeeded",
  "failed",
  "interrupted",
  "timed_out",
  "cancelled",
  "claim_lost",
] as const;
export type AttemptState = typeof ATTEMPT_STATES[number];

export const TERMINAL_ATTEMPT_STATES: ReadonlySet<AttemptState> = new Set([
  "succeeded",
  "failed",
  "interrupted",
  "timed_out",
  "cancelled",
  "claim_lost",
]);
