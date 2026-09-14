import { z } from "zod";
import { LIVE_RUN_MODES, type LiveRunMode, type LiveRunTaskPayload } from "../live-run.js";

/**
 * `RunContractV1` — the versioned input schema for an evidence-gated
 * orchestration run. See docs/orchestration/README.md (and the audited
 * design in docs/audits/092026/2026-09-13-run-contracts-plan-multilens-audit.md)
 * for the full rationale.
 *
 * Bounds exist to satisfy RC-INV-014 (contracts cap stages, evidence,
 * validation steps, etc.) and to keep a hostile or malformed contract from
 * producing unbounded persisted state. They are deliberately generous
 * defaults, not tuned limits — revisit only with a concrete case that needs
 * more.
 */

export const CONTRACT_SCHEMA_VERSION = "1" as const;

export const MAX_ID_LENGTH = 64;
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_TITLE_LENGTH = 200;
export const MAX_PROMPT_LENGTH = 20_000;
export const MAX_STATEMENT_LENGTH = 2_000;
export const MAX_SUCCESS_CRITERIA = 20;
export const MAX_EVIDENCE_PER_CRITERION = 10;
export const MAX_VALIDATION_STEPS = 20;
export const MAX_ARGV_ITEMS = 64;
export const MAX_ARGV_ITEM_LENGTH = 4_096;
export const MIN_VALIDATION_TIMEOUT_MS = 1_000;
export const MAX_VALIDATION_TIMEOUT_MS = 30 * 60 * 1_000;
export const MAX_HUMAN_GATES = 10;
export const MAX_ROLES = 20;
export const MAX_REVISION_PASSES = 5;
export const MAX_REASON_LENGTH = 2_000;

const idSchema = z.string().regex(ID_PATTERN, `must match ${ID_PATTERN}`);

/**
 * Artifact kinds a success criterion may cite as evidence. Intentionally a
 * closed set (not a free string) so a criterion can't reference a kind the
 * host doesn't know how to produce or check.
 */
export const CONTRACT_ARTIFACT_KINDS = [
  "source_snapshot",
  "workspace_diff",
  "artifact_manifest",
  "parsed_plan",
  "parsed_review",
  "parsed_report",
  "apply_result",
] as const;
export type ContractArtifactKind = typeof CONTRACT_ARTIFACT_KINDS[number];

const evidenceRequirementSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("validation_step"), stepId: idSchema }).strict(),
  z.object({ kind: z.literal("artifact"), artifactKind: z.enum(CONTRACT_ARTIFACT_KINDS) }).strict(),
  z.object({ kind: z.literal("review_gate"), gateId: idSchema }).strict(),
  z.object({ kind: z.literal("human_gate"), gateId: idSchema }).strict(),
]);

const successCriterionSchema = z.object({
  id: idSchema,
  statement: z.string().min(1).max(MAX_STATEMENT_LENGTH),
  evidence: z.array(evidenceRequirementSchema).min(1).max(MAX_EVIDENCE_PER_CRITERION),
}).strict();

const validationStepSchema = z.object({
  id: idSchema,
  argv: z.array(z.string().min(1).max(MAX_ARGV_ITEM_LENGTH)).min(1).max(MAX_ARGV_ITEMS),
  cwdRelative: z.string().min(1).max(1_024).optional(),
  timeoutMs: z.number().int().min(MIN_VALIDATION_TIMEOUT_MS).max(MAX_VALIDATION_TIMEOUT_MS),
  expectedExitCodes: z.array(z.number().int().min(0).max(255)).max(16).optional(),
  environment: z.enum(["minimal", "inherit_safe"]),
  network: z.enum(["inherit", "deny_if_supported", "require_denied"]),
}).strict();

const reviewPolicySchema = z.object({
  required: z.boolean(),
  maxRevisionPasses: z.number().int().min(0).max(MAX_REVISION_PASSES).default(2),
  independence: z.enum(["operator_selected", "different_family_required"]),
  blockingSeverities: z.array(z.enum(["critical", "high", "medium", "low"])).max(4),
  /**
   * RC-FLOW-7 decision: in `architecture` mode, adversarial review is
   * gating by default alongside independent review. An operator may set
   * this false to make it advisory instead. Ignored by modes with no
   * adversarial-review stage.
   */
  adversarialGating: z.boolean().default(true),
}).strict();

const humanGateSchema = z.object({
  id: idSchema,
  afterStage: idSchema,
  reason: z.string().min(1).max(MAX_REASON_LENGTH),
  allowedDecisions: z.array(z.enum(["approve", "reject", "revise", "defer"])).min(1).max(4),
}).strict();

const routingSchema = z.object({
  requiredRoles: z.array(idSchema).max(MAX_ROLES).optional(),
  optionalRoles: z.array(idSchema).max(MAX_ROLES).optional(),
  allowedWorkerIds: z.array(idSchema).max(MAX_ROLES).optional(),
  priority: z.enum(["low", "normal", "high"]).optional(),
  leaseDurationMs: z.number().int().positive().optional(),
  model: z.string().min(1).max(200).optional(),
  effortLevel: z.string().min(1).max(200).optional(),
}).strict();

export const runContractV1Schema = z.object({
  schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
  taskId: idSchema,
  coordinatorId: idSchema,
  mode: z.enum(LIVE_RUN_MODES),
  title: z.string().min(1).max(MAX_TITLE_LENGTH).optional(),
  prompt: z.string().min(1).max(MAX_PROMPT_LENGTH),
  cwd: z.string().min(1).max(4_096).optional(),

  completionPolicy: z.enum(["evidence_required", "human_acceptance", "process_only"]),
  sourceDriftPolicy: z.enum(["block", "warn"]),

  successCriteria: z.array(successCriterionSchema).max(MAX_SUCCESS_CRITERIA).default([]),
  validation: z.object({ steps: z.array(validationStepSchema).max(MAX_VALIDATION_STEPS) }).strict().optional(),
  review: reviewPolicySchema.optional(),
  humanGates: z.array(humanGateSchema).max(MAX_HUMAN_GATES).default([]),
  routing: routingSchema.optional(),
}).strict().superRefine((contract, ctx) => {
  if (contract.completionPolicy === "evidence_required" && contract.successCriteria.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["successCriteria"],
      message: "completionPolicy 'evidence_required' must declare at least one success criterion",
    });
  }
  if (contract.completionPolicy === "human_acceptance" && contract.humanGates.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["humanGates"],
      message: "completionPolicy 'human_acceptance' must declare at least one human gate",
    });
  }

  assertUniqueIds(contract.successCriteria.map((c) => c.id), "successCriteria", ctx);
  assertUniqueIds(contract.humanGates.map((g) => g.id), "humanGates", ctx);
  if (contract.validation) {
    assertUniqueIds(contract.validation.steps.map((s) => s.id), "validation.steps", ctx);
  }

  const declaredStepIds = new Set(contract.validation?.steps.map((s) => s.id) ?? []);
  const declaredGateIds = new Set(contract.humanGates.map((g) => g.id));
  for (const [criterionIndex, criterion] of contract.successCriteria.entries()) {
    for (const [evidenceIndex, req] of criterion.evidence.entries()) {
      if (req.kind === "validation_step" && !declaredStepIds.has(req.stepId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["successCriteria", criterionIndex, "evidence", evidenceIndex, "stepId"],
          message: `references undeclared validation step '${req.stepId}'`,
        });
      }
      if (req.kind === "human_gate" && !declaredGateIds.has(req.gateId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["successCriteria", criterionIndex, "evidence", evidenceIndex, "gateId"],
          message: `references undeclared human gate '${req.gateId}'`,
        });
      }
    }
  }
  for (const [gateIndex, gate] of contract.humanGates.entries()) {
    for (const [decisionIndex, decision] of gate.allowedDecisions.entries()) {
      if (gate.allowedDecisions.indexOf(decision) !== decisionIndex) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["humanGates", gateIndex, "allowedDecisions", decisionIndex],
          message: "duplicate decision in allowedDecisions",
        });
      }
    }
  }
});

function assertUniqueIds(ids: string[], path: string, ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: `duplicate id '${id}'` });
    }
    seen.add(id);
  }
}

export type RunContractV1 = z.infer<typeof runContractV1Schema>;
export type ValidationStepV1 = z.infer<typeof validationStepSchema>;
export type SuccessCriterionV1 = z.infer<typeof successCriterionSchema>;
export type ReviewPolicyV1 = z.infer<typeof reviewPolicySchema>;
export type HumanGateV1 = z.infer<typeof humanGateSchema>;

/**
 * True when `payload` looks like the pre-contract `LiveRunTaskPayload` shape
 * (no `schemaVersion` field) rather than a versioned `RunContractV1` body.
 * Used at the API/CLI boundary to route a request onto the legacy
 * process_only-compatible path (RC-INV-020) without breaking existing
 * callers that never adopted the contract schema.
 */
export function isLegacyTaskPayload(payload: unknown): payload is LiveRunTaskPayload {
  return (
    typeof payload === "object"
    && payload !== null
    && !("schemaVersion" in payload)
    && "taskId" in payload
    && "coordinatorId" in payload
    && "prompt" in payload
  );
}

/**
 * Build a `RunContractV1` for a legacy task payload with no declared
 * success criteria or evidence — `completionPolicy: "process_only"`, which
 * RC-INV-020 requires be labeled unverified everywhere it surfaces (see
 * `views.ts`). This never claims evidence-gated completion; it exists so
 * the contract layer has exactly one execution path (compile → execute →
 * project to ledger) instead of a parallel legacy code path.
 */
export function synthesizeProcessOnlyContract(task: LiveRunTaskPayload, mode: LiveRunMode): RunContractV1 {
  return runContractV1Schema.parse({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    taskId: task.taskId,
    coordinatorId: task.coordinatorId,
    mode,
    title: task.title,
    prompt: task.prompt,
    cwd: task.cwd,
    completionPolicy: "process_only",
    sourceDriftPolicy: "warn",
    successCriteria: [],
    humanGates: [],
    routing: {
      requiredRoles: task.requiredRoles,
      optionalRoles: task.optionalRoles,
      allowedWorkerIds: task.allowedWorkerIds,
      priority: task.priority,
      leaseDurationMs: task.leaseDurationMs,
      model: task.model,
      effortLevel: task.effortLevel,
    },
  });
}
