import type { LiveRunMode } from "../live-run.js";
import type { StageBlueprintV1, StageTemplateV1 } from "./types.js";

/**
 * Versioned, fixed stage templates for the five existing live run modes.
 * Per the design's explicit non-goal, this is deliberately NOT a
 * general-purpose workflow language: the stage list, kinds, and dependency
 * edges are code constants, not contract-authored data. The only things a
 * contract can influence are the `includeIf`/`requiredIf` predicates below
 * (e.g. whether a `validate` stage exists at all depends on whether the
 * contract declares `validation`), never the shape of the graph itself.
 *
 * Default allocation timeout (RC-REL-3): a stage waiting this long for a
 * worker moves the contract to `blocked_resource` rather than waiting
 * indefinitely with no distinct operator-visible state.
 */
const DEFAULT_ALLOCATION_TIMEOUT_MS = 30 * 60 * 1_000;

function validateStage(dependsOn: string[]): StageBlueprintV1 {
  return {
    key: "validate",
    kind: "validate",
    dependsOn,
    mutatesWorkspace: false,
    requiredExecutionProfile: { profile: "validation_host_process" },
    inputSelectors: [],
    outputContracts: ["workspace_diff"],
    // Only present in the compiled graph when the contract actually
    // declares validation steps — a criterion referencing a validation_step
    // that doesn't exist is already rejected at the schema level, so it is
    // schema-safe to omit this stage entirely otherwise (e.g. a
    // process_only legacy contract with no declared validation).
    includeIf: (contract) => contract.validation !== undefined && contract.validation.steps.length > 0,
    retryPolicy: { maxAttempts: 1, retryOn: [] },
    allocationTimeoutMs: DEFAULT_ALLOCATION_TIMEOUT_MS,
  };
}

const SINGLE_WORKER: StageTemplateV1 = {
  schemaVersion: "1",
  mode: "single_worker",
  stages: [
    {
      key: "implement",
      kind: "implement",
      dependsOn: [],
      roleId: "implementer",
      mutatesWorkspace: true,
      requiredExecutionProfile: { profile: "implementation" },
      inputSelectors: [],
      outputContracts: ["workspace_diff", "artifact_manifest"],
      retryPolicy: { maxAttempts: 1, retryOn: [] },
      allocationTimeoutMs: DEFAULT_ALLOCATION_TIMEOUT_MS,
    },
    validateStage(["implement"]),
  ],
};

const SINGLE_WORKER_WITH_REVIEW: StageTemplateV1 = {
  schemaVersion: "1",
  mode: "single_worker_with_review",
  stages: [
    {
      key: "implement",
      kind: "implement",
      dependsOn: [],
      roleId: "implementer",
      mutatesWorkspace: true,
      requiredExecutionProfile: { profile: "implementation" },
      inputSelectors: [],
      outputContracts: ["workspace_diff", "artifact_manifest"],
      retryPolicy: { maxAttempts: 1, retryOn: [] },
      allocationTimeoutMs: DEFAULT_ALLOCATION_TIMEOUT_MS,
    },
    {
      key: "review",
      kind: "review",
      dependsOn: ["implement"],
      roleId: "reviewer",
      mutatesWorkspace: false,
      requiredExecutionProfile: { profile: "review_read_only", require: { workspaceWrite: "prompt_only" } },
      inputSelectors: [{ fromStageKey: "implement", artifactKind: "workspace_diff", attemptResolution: "latest_succeeded" }],
      outputContracts: ["parsed_review"],
      // RC-FLOW-2: the compiler caps this at 1 + contract.review.maxRevisionPasses
      // attempts (one initial review plus one re-review per bounded revision
      // pass) so the review/revise loop has a hard, declared exit.
      retryPolicy: { maxAttempts: 1, retryOn: [] },
      allocationTimeoutMs: DEFAULT_ALLOCATION_TIMEOUT_MS,
    },
    {
      // Bounded loop target. Never `required` (RC-REL-4): whether a revision
      // pass ran, and whether it succeeded, cannot itself gate the contract
      // — only the review stage's final verdict and the validate stage's
      // result do.
      key: "revise",
      kind: "revise",
      dependsOn: ["review"],
      roleId: "implementer",
      mutatesWorkspace: true,
      requiredExecutionProfile: { profile: "implementation" },
      inputSelectors: [{ fromStageKey: "review", artifactKind: "parsed_review", attemptResolution: "latest_attempt" }],
      outputContracts: ["workspace_diff"],
      requiredIf: () => false,
      retryPolicy: { maxAttempts: 1, retryOn: [] },
      allocationTimeoutMs: DEFAULT_ALLOCATION_TIMEOUT_MS,
    },
    validateStage(["review"]),
  ],
};

const ARCHITECTURE: StageTemplateV1 = {
  schemaVersion: "1",
  mode: "architecture",
  stages: [
    {
      key: "plan",
      kind: "plan",
      dependsOn: [],
      roleId: "architect",
      mutatesWorkspace: false,
      requiredExecutionProfile: { profile: "planning_read_only" },
      inputSelectors: [],
      outputContracts: ["parsed_plan"],
      retryPolicy: { maxAttempts: 1, retryOn: [] },
      allocationTimeoutMs: DEFAULT_ALLOCATION_TIMEOUT_MS,
    },
    {
      key: "implement",
      kind: "implement",
      dependsOn: ["plan"],
      roleId: "implementer",
      mutatesWorkspace: true,
      requiredExecutionProfile: { profile: "implementation" },
      inputSelectors: [{ fromStageKey: "plan", artifactKind: "parsed_plan", attemptResolution: "latest_succeeded" }],
      outputContracts: ["workspace_diff", "artifact_manifest"],
      retryPolicy: { maxAttempts: 1, retryOn: [] },
      allocationTimeoutMs: DEFAULT_ALLOCATION_TIMEOUT_MS,
    },
    {
      key: "review",
      kind: "review",
      dependsOn: ["implement"],
      roleId: "reviewer",
      mutatesWorkspace: false,
      requiredExecutionProfile: { profile: "review_read_only" },
      inputSelectors: [{ fromStageKey: "implement", artifactKind: "workspace_diff", attemptResolution: "latest_succeeded" }],
      outputContracts: ["parsed_review"],
      retryPolicy: { maxAttempts: 1, retryOn: [] },
      allocationTimeoutMs: DEFAULT_ALLOCATION_TIMEOUT_MS,
    },
    {
      key: "adversarial_review",
      kind: "adversarial_review",
      dependsOn: ["implement"],
      roleId: "adversarial_reviewer",
      mutatesWorkspace: false,
      requiredExecutionProfile: { profile: "review_read_only" },
      inputSelectors: [{ fromStageKey: "implement", artifactKind: "workspace_diff", attemptResolution: "latest_succeeded" }],
      outputContracts: ["parsed_review"],
      // RC-FLOW-7 decision: gating by default alongside independent review;
      // an operator may set review.adversarialGating: false to make it
      // advisory instead.
      requiredIf: (contract) => contract.review?.adversarialGating ?? true,
      retryPolicy: { maxAttempts: 1, retryOn: [] },
      allocationTimeoutMs: DEFAULT_ALLOCATION_TIMEOUT_MS,
    },
    {
      key: "revise",
      kind: "revise",
      dependsOn: ["review", "adversarial_review"],
      roleId: "implementer",
      mutatesWorkspace: true,
      requiredExecutionProfile: { profile: "implementation" },
      inputSelectors: [
        { fromStageKey: "review", artifactKind: "parsed_review", attemptResolution: "latest_attempt" },
        { fromStageKey: "adversarial_review", artifactKind: "parsed_review", attemptResolution: "latest_attempt" },
      ],
      outputContracts: ["workspace_diff"],
      requiredIf: () => false,
      retryPolicy: { maxAttempts: 1, retryOn: [] },
      allocationTimeoutMs: DEFAULT_ALLOCATION_TIMEOUT_MS,
    },
    validateStage(["review", "adversarial_review"]),
  ],
};

const DUAL_LANE: StageTemplateV1 = {
  schemaVersion: "1",
  mode: "dual_lane",
  stages: [
    {
      key: "implement_openai",
      kind: "implement",
      dependsOn: [],
      roleId: "implementer",
      mutatesWorkspace: true,
      requiredExecutionProfile: { profile: "implementation" },
      inputSelectors: [],
      outputContracts: ["workspace_diff"],
      retryPolicy: { maxAttempts: 1, retryOn: [] },
      allocationTimeoutMs: DEFAULT_ALLOCATION_TIMEOUT_MS,
    },
    {
      key: "implement_anthropic",
      kind: "implement",
      dependsOn: [],
      roleId: "implementer",
      mutatesWorkspace: true,
      requiredExecutionProfile: { profile: "implementation" },
      inputSelectors: [],
      outputContracts: ["workspace_diff"],
      retryPolicy: { maxAttempts: 1, retryOn: [] },
      allocationTimeoutMs: DEFAULT_ALLOCATION_TIMEOUT_MS,
    },
    {
      key: "compare",
      kind: "compare",
      dependsOn: ["implement_openai", "implement_anthropic"],
      mutatesWorkspace: false,
      inputSelectors: [
        { fromStageKey: "implement_openai", artifactKind: "workspace_diff", attemptResolution: "latest_succeeded" },
        { fromStageKey: "implement_anthropic", artifactKind: "workspace_diff", attemptResolution: "latest_succeeded" },
      ],
      outputContracts: ["artifact_manifest"],
      retryPolicy: { maxAttempts: 1, retryOn: [] },
      allocationTimeoutMs: DEFAULT_ALLOCATION_TIMEOUT_MS,
    },
    {
      // Discrete stage (rather than folding selection into the phase
      // transition alone) so the human decision has a concrete `stage_id`
      // to bind a `run_gate_decisions` row to.
      key: "selection",
      kind: "human_gate",
      dependsOn: ["compare"],
      mutatesWorkspace: false,
      inputSelectors: [{ fromStageKey: "compare", artifactKind: "artifact_manifest", attemptResolution: "latest_succeeded" }],
      outputContracts: [],
      retryPolicy: { maxAttempts: 1, retryOn: [] },
      allocationTimeoutMs: DEFAULT_ALLOCATION_TIMEOUT_MS,
    },
    {
      key: "apply",
      kind: "apply",
      dependsOn: ["selection"],
      mutatesWorkspace: true,
      inputSelectors: [],
      outputContracts: ["apply_result"],
      // Comparison-only contracts (no apply expected) are represented by
      // omitting the apply/validate stages entirely; the compiler decides
      // this from completionPolicy — see compiler.ts.
      includeIf: (contract) => contract.completionPolicy !== "human_acceptance" || contract.validation !== undefined,
      retryPolicy: { maxAttempts: 1, retryOn: [] },
      allocationTimeoutMs: DEFAULT_ALLOCATION_TIMEOUT_MS,
    },
    validateStage(["apply"]),
  ],
};

const LOCAL_HEAVY: StageTemplateV1 = {
  schemaVersion: "1",
  mode: "local_heavy",
  stages: [
    {
      key: "inspect",
      kind: "report",
      dependsOn: [],
      roleId: "inspector",
      mutatesWorkspace: false,
      requiredExecutionProfile: { profile: "report_read_only" },
      inputSelectors: [],
      outputContracts: ["parsed_report"],
      retryPolicy: { maxAttempts: 1, retryOn: [] },
      allocationTimeoutMs: DEFAULT_ALLOCATION_TIMEOUT_MS,
    },
    {
      key: "acceptance",
      kind: "human_gate",
      dependsOn: ["inspect"],
      mutatesWorkspace: false,
      inputSelectors: [{ fromStageKey: "inspect", artifactKind: "parsed_report", attemptResolution: "latest_succeeded" }],
      outputContracts: [],
      includeIf: (contract) => contract.completionPolicy === "human_acceptance",
      retryPolicy: { maxAttempts: 1, retryOn: [] },
      allocationTimeoutMs: DEFAULT_ALLOCATION_TIMEOUT_MS,
    },
  ],
};

export const STAGE_TEMPLATES_V1: Record<LiveRunMode, StageTemplateV1> = {
  single_worker: SINGLE_WORKER,
  single_worker_with_review: SINGLE_WORKER_WITH_REVIEW,
  dual_lane: DUAL_LANE,
  architecture: ARCHITECTURE,
  local_heavy: LOCAL_HEAVY,
};
