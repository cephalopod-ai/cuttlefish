import type { RunContractV1 } from "./schema.js";
import { STAGE_TEMPLATES_V1 } from "./templates.js";
import type { StageDefinitionV1, StageGraphV1 } from "./types.js";

/** Thrown when a contract cannot be compiled against its mode's template —
 * an undeclared dependency, a cross-reference to a stage that ended up not
 * `required`, or (defensively) a cyclic stage graph. Never thrown for a
 * reason a caller should retry without changing the contract. */
export class ContractCompilationError extends Error {}

/**
 * Resolve `STAGE_TEMPLATES_V1[contract.mode]` against a specific parsed
 * contract into an immutable `StageGraphV1`.
 *
 * This is the ONLY place a contract's declarations (`humanGates`,
 * `review.maxRevisionPasses`, `review.adversarialGating`,
 * `successCriteria`) are allowed to influence which stages exist and how
 * they're wired — the fixed template supplies the stage kinds and the
 * dependency shape; the contract may only include/exclude optional stages
 * the template already anticipates and fill in bounded parameters. This is
 * the boundary that keeps the design a fixed set of versioned templates
 * rather than a general-purpose workflow language.
 */
export function compileStageGraph(contract: RunContractV1): StageGraphV1 {
  const template = STAGE_TEMPLATES_V1[contract.mode];
  if (!template) {
    throw new ContractCompilationError(`no stage template registered for mode '${contract.mode}'`);
  }

  const included: StageDefinitionV1[] = [];
  for (const blueprint of template.stages) {
    if (blueprint.includeIf && !blueprint.includeIf(contract)) continue;
    const required = blueprint.requiredIf ? blueprint.requiredIf(contract) : true;
    included.push({
      id: blueprint.key,
      kind: blueprint.kind,
      dependsOn: [...blueprint.dependsOn],
      roleId: blueprint.roleId,
      requiredExecutionProfile: blueprint.requiredExecutionProfile,
      inputSelectors: [...blueprint.inputSelectors],
      outputContracts: [...blueprint.outputContracts],
      retryPolicy: resolveRetryPolicy(blueprint.key, blueprint.kind, blueprint.retryPolicy, contract),
      required,
      mutatesWorkspace: blueprint.mutatesWorkspace,
      allocationTimeoutMs: blueprint.allocationTimeoutMs,
    });
  }

  // Contract-declared human gates are additional stages layered onto the
  // template's structural ones, positioned by `afterStage`. Unlike the
  // template's own optional human_gate stages (dual_lane's `selection`,
  // local_heavy's `acceptance`), a gate the contract author explicitly
  // declared is always `required: true` — declaring one is an assertion
  // that it must be resolved, not an optional annotation.
  const includedKeys = new Set(included.map((stage) => stage.id));
  for (const gate of contract.humanGates) {
    if (!includedKeys.has(gate.afterStage)) {
      throw new ContractCompilationError(
        `humanGates[].afterStage '${gate.afterStage}' does not name a stage in the compiled '${contract.mode}' graph`,
      );
    }
    if (includedKeys.has(gate.id)) {
      throw new ContractCompilationError(`humanGates[].id '${gate.id}' collides with an existing stage key`);
    }
    included.push({
      id: gate.id,
      kind: "human_gate",
      dependsOn: [gate.afterStage],
      inputSelectors: [],
      outputContracts: [],
      retryPolicy: { maxAttempts: 1, retryOn: [] },
      required: true,
      mutatesWorkspace: false,
      allocationTimeoutMs: template.stages.find((s) => s.key === gate.afterStage)?.allocationTimeoutMs ?? 30 * 60 * 1_000,
    });
    includedKeys.add(gate.id);
  }

  assertDependenciesResolve(included);
  assertAcyclic(included);
  assertSuccessCriteriaReferenceRequiredStages(contract, included);

  return {
    schemaVersion: "1",
    mode: contract.mode,
    stages: topologicalSort(included),
  };
}

/**
 * RC-FLOW-2 fix: bound the review/revise loop's exit by capping attempt
 * counts from `contract.review.maxRevisionPasses` rather than leaving the
 * loop's exit condition undrawn. `review` gets one initial attempt plus one
 * per revision pass; `revise` gets exactly one attempt per pass (it only
 * ever runs between two review attempts).
 */
function resolveRetryPolicy(
  stageKey: string,
  kind: StageDefinitionV1["kind"],
  base: { maxAttempts: number; retryOn: StageDefinitionV1["retryPolicy"]["retryOn"] },
  contract: RunContractV1,
): StageDefinitionV1["retryPolicy"] {
  const maxRevisionPasses = contract.review?.maxRevisionPasses ?? 0;
  if (kind === "review" || kind === "adversarial_review") {
    return { maxAttempts: 1 + maxRevisionPasses, retryOn: base.retryOn };
  }
  if (kind === "revise") {
    return { maxAttempts: Math.max(1, maxRevisionPasses), retryOn: base.retryOn };
  }
  return { ...base };
}

function assertDependenciesResolve(stages: StageDefinitionV1[]): void {
  const keys = new Set(stages.map((s) => s.id));
  for (const stage of stages) {
    for (const dep of stage.dependsOn) {
      if (!keys.has(dep)) {
        throw new ContractCompilationError(`stage '${stage.id}' depends on undeclared or excluded stage '${dep}'`);
      }
    }
  }
}

function assertAcyclic(stages: StageDefinitionV1[]): void {
  topologicalSort(stages);
}

/**
 * Kahn's algorithm. Doubles as the acyclicity check (`assertAcyclic` calls
 * this and discards the result) — a fixed hand-authored template should
 * never produce a cycle, but this is a real, testable guard against a
 * future template-authoring mistake rather than an assumption.
 */
function topologicalSort(stages: StageDefinitionV1[]): StageDefinitionV1[] {
  const byId = new Map(stages.map((s) => [s.id, s] as const));
  const remainingDeps = new Map(stages.map((s) => [s.id, new Set(s.dependsOn)] as const));
  const sorted: StageDefinitionV1[] = [];
  const ready = stages.filter((s) => s.dependsOn.length === 0).map((s) => s.id);
  ready.sort(); // deterministic ordering among stages with no remaining deps

  const dependents = new Map<string, string[]>();
  for (const stage of stages) {
    for (const dep of stage.dependsOn) {
      dependents.set(dep, [...(dependents.get(dep) ?? []), stage.id]);
    }
  }

  while (ready.length > 0) {
    const id = ready.shift();
    if (id === undefined) break;
    const stage = byId.get(id);
    if (!stage) continue;
    sorted.push(stage);
    const nextReady: string[] = [];
    for (const dependentId of dependents.get(id) ?? []) {
      const deps = remainingDeps.get(dependentId);
      if (!deps) continue;
      deps.delete(id);
      if (deps.size === 0) nextReady.push(dependentId);
    }
    nextReady.sort();
    ready.push(...nextReady);
  }

  if (sorted.length !== stages.length) {
    const unresolved = stages.filter((s) => !sorted.includes(s)).map((s) => s.id);
    throw new ContractCompilationError(`stage graph is cyclic; could not order: ${unresolved.join(", ")}`);
  }
  return sorted;
}

/**
 * RC-REL-4's compile-time enforcement: a success criterion may only cite
 * evidence from a stage that is actually `required: true` in the compiled
 * graph. A criterion pointing at an optional stage (or one excluded
 * entirely) can never be satisfied on purpose, which would silently make
 * the criterion permanently unsatisfiable — better to fail contract
 * compilation with a clear reason than accept a contract that can never
 * pass.
 */
function assertSuccessCriteriaReferenceRequiredStages(contract: RunContractV1, stages: StageDefinitionV1[]): void {
  const requiredValidate = stages.find((s) => s.kind === "validate")?.required ?? false;
  const requiredReviewLike = new Set(
    stages.filter((s) => (s.kind === "review" || s.kind === "adversarial_review") && s.required).map((s) => s.id),
  );
  const requiredHumanGate = new Set(stages.filter((s) => s.kind === "human_gate" && s.required).map((s) => s.id));

  for (const criterion of contract.successCriteria) {
    for (const req of criterion.evidence) {
      if (req.kind === "validation_step" && !requiredValidate) {
        throw new ContractCompilationError(
          `successCriteria '${criterion.id}' cites validation step '${req.stepId}', but no required validate stage exists in the compiled '${contract.mode}' graph`,
        );
      }
      if (req.kind === "review_gate" && !requiredReviewLike.has(req.gateId)) {
        throw new ContractCompilationError(
          `successCriteria '${criterion.id}' cites review_gate '${req.gateId}', which is not a required review-kind stage in the compiled '${contract.mode}' graph`,
        );
      }
      if (req.kind === "human_gate" && !requiredHumanGate.has(req.gateId)) {
        throw new ContractCompilationError(
          `successCriteria '${criterion.id}' cites human_gate '${req.gateId}', which is not a required human-gate stage in the compiled '${contract.mode}' graph`,
        );
      }
    }
  }
}
