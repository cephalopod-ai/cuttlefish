import { describe, expect, it } from "vitest";
import { ContractCompilationError, compileStageGraph } from "../compiler.js";
import { runContractV1Schema, type RunContractV1 } from "../schema.js";
import { LIVE_RUN_MODES, type LiveRunMode } from "../../live-run.js";

function contractFor(mode: LiveRunMode, overrides: Record<string, unknown> = {}): RunContractV1 {
  return runContractV1Schema.parse({
    schemaVersion: "1",
    taskId: "t1",
    coordinatorId: "default",
    mode,
    prompt: "do the thing",
    completionPolicy: "process_only",
    sourceDriftPolicy: "warn",
    ...overrides,
  });
}

describe("compileStageGraph — all five modes", () => {
  it.each(LIVE_RUN_MODES)("compiles a minimal process_only contract for mode '%s' into a non-empty acyclic graph", (mode) => {
    const graph = compileStageGraph(contractFor(mode));
    expect(graph.mode).toBe(mode);
    expect(graph.stages.length).toBeGreaterThan(0);
    // Ordinal ordering is a valid topological order: every stage's deps
    // appear earlier in the array.
    const seen = new Set<string>();
    for (const stage of graph.stages) {
      for (const dep of stage.dependsOn) expect(seen.has(dep)).toBe(true);
      seen.add(stage.id);
    }
  });
});

describe("compileStageGraph — conditional stage inclusion", () => {
  it("omits the validate stage when no validation is declared", () => {
    const graph = compileStageGraph(contractFor("single_worker"));
    expect(graph.stages.find((s) => s.kind === "validate")).toBeUndefined();
  });

  it("includes the validate stage when validation steps are declared", () => {
    const graph = compileStageGraph(
      contractFor("single_worker", {
        validation: { steps: [{ id: "t", argv: ["true"], timeoutMs: 1000, environment: "minimal", network: "inherit" }] },
      }),
    );
    const validate = graph.stages.find((s) => s.kind === "validate");
    expect(validate).toBeDefined();
    expect(validate?.required).toBe(true);
  });

  it("revise is always present but never required, in single_worker_with_review", () => {
    const graph = compileStageGraph(contractFor("single_worker_with_review"));
    const revise = graph.stages.find((s) => s.kind === "revise");
    expect(revise).toBeDefined();
    expect(revise?.required).toBe(false);
  });

  it("RC-FLOW-7: adversarial_review is required by default in architecture mode", () => {
    const graph = compileStageGraph(contractFor("architecture"));
    const adversarial = graph.stages.find((s) => s.kind === "adversarial_review");
    expect(adversarial?.required).toBe(true);
  });

  it("RC-FLOW-7: adversarial_review becomes advisory when review.adversarialGating is false", () => {
    const graph = compileStageGraph(
      contractFor("architecture", {
        review: { required: true, independence: "different_family_required", blockingSeverities: [], adversarialGating: false },
      }),
    );
    const adversarial = graph.stages.find((s) => s.kind === "adversarial_review");
    expect(adversarial?.required).toBe(false);
  });

  it("local_heavy includes the acceptance human gate only under human_acceptance completion policy", () => {
    const withoutGate = compileStageGraph(contractFor("local_heavy"));
    expect(withoutGate.stages.find((s) => s.id === "acceptance")).toBeUndefined();

    const withGate = compileStageGraph(
      contractFor("local_heavy", {
        completionPolicy: "human_acceptance",
        humanGates: [{ id: "acceptance-required", afterStage: "inspect", reason: "operator must accept the report", allowedDecisions: ["approve", "reject"] }],
      }),
    );
    expect(withGate.stages.find((s) => s.id === "acceptance")).toBeDefined();
  });

  it("dual_lane always includes the selection human gate between compare and apply", () => {
    const graph = compileStageGraph(contractFor("dual_lane"));
    const selection = graph.stages.find((s) => s.id === "selection");
    expect(selection?.kind).toBe("human_gate");
    expect(selection?.dependsOn).toEqual(["compare"]);
    const apply = graph.stages.find((s) => s.kind === "apply");
    expect(apply?.dependsOn).toEqual(["selection"]);
  });
});

describe("compileStageGraph — RC-FLOW-2 bounded review/revise loop", () => {
  it("caps review attempts at 1 + maxRevisionPasses and revise at maxRevisionPasses", () => {
    const graph = compileStageGraph(
      contractFor("single_worker_with_review", {
        review: { required: true, maxRevisionPasses: 3, independence: "operator_selected", blockingSeverities: ["critical"] },
      }),
    );
    const review = graph.stages.find((s) => s.kind === "review");
    const revise = graph.stages.find((s) => s.kind === "revise");
    expect(review?.retryPolicy.maxAttempts).toBe(4);
    expect(revise?.retryPolicy.maxAttempts).toBe(3);
  });

  it("defaults to maxRevisionPasses=2 when review policy is declared without an explicit count", () => {
    const graph = compileStageGraph(
      contractFor("single_worker_with_review", {
        review: { required: true, independence: "operator_selected", blockingSeverities: [] },
      }),
    );
    expect(graph.stages.find((s) => s.kind === "review")?.retryPolicy.maxAttempts).toBe(3);
  });

  it("uses zero revision passes (review-only, no loop) when no review policy is declared at all", () => {
    const graph = compileStageGraph(contractFor("single_worker_with_review"));
    expect(graph.stages.find((s) => s.kind === "review")?.retryPolicy.maxAttempts).toBe(1);
    expect(graph.stages.find((s) => s.kind === "revise")?.retryPolicy.maxAttempts).toBe(1);
  });
});

describe("compileStageGraph — contract-declared human gates", () => {
  it("injects a gate stage positioned after the named stage", () => {
    const graph = compileStageGraph(
      contractFor("architecture", {
        humanGates: [{ id: "plan-approval", afterStage: "plan", reason: "operator reviews the plan first", allowedDecisions: ["approve", "reject"] }],
      }),
    );
    const gate = graph.stages.find((s) => s.id === "plan-approval");
    expect(gate?.kind).toBe("human_gate");
    expect(gate?.dependsOn).toEqual(["plan"]);
    expect(gate?.required).toBe(true);
    // ordinal position: plan-approval must appear after plan
    const planIndex = graph.stages.findIndex((s) => s.id === "plan");
    const gateIndex = graph.stages.findIndex((s) => s.id === "plan-approval");
    expect(gateIndex).toBeGreaterThan(planIndex);
  });

  it("throws when afterStage does not name a stage in the compiled graph", () => {
    expect(() =>
      compileStageGraph(
        contractFor("single_worker", {
          humanGates: [{ id: "g1", afterStage: "does-not-exist", reason: "x", allowedDecisions: ["approve"] }],
        }),
      ),
    ).toThrow(ContractCompilationError);
  });

  it("throws when a gate id collides with an existing stage key", () => {
    expect(() =>
      compileStageGraph(
        contractFor("single_worker", {
          humanGates: [{ id: "implement", afterStage: "implement", reason: "x", allowedDecisions: ["approve"] }],
        }),
      ),
    ).toThrow(ContractCompilationError);
  });
});

describe("compileStageGraph — RC-REL-4 success-criteria-references-required-stage enforcement", () => {
  it("throws when a review_gate criterion references a non-required (advisory) review stage", () => {
    const contract = contractFor("architecture", {
      completionPolicy: "evidence_required",
      review: { required: true, independence: "operator_selected", blockingSeverities: [], adversarialGating: false },
      successCriteria: [{ id: "c1", statement: "adversarial review passes", evidence: [{ kind: "review_gate", gateId: "adversarial_review" }] }],
    });
    expect(() => compileStageGraph(contract)).toThrow(/adversarial_review.*not a required review-kind stage/);
  });

  it("accepts a review_gate criterion referencing a required review stage", () => {
    const contract = contractFor("architecture", {
      completionPolicy: "evidence_required",
      successCriteria: [{ id: "c1", statement: "review passes", evidence: [{ kind: "review_gate", gateId: "review" }] }],
    });
    expect(() => compileStageGraph(contract)).not.toThrow();
  });

  it("accepts a human_gate criterion referencing a contract-declared gate (always required)", () => {
    // Note: the validation_step branch of this same guard
    // (`req.kind === "validation_step" && !requiredValidate`) is currently
    // unreachable through the public schema — `validate` is always
    // `required: true` once included, and it can only be excluded when no
    // validation.steps are declared, which schema.ts already forbids a
    // criterion from referencing. The check is kept as a defensive
    // safety net against a future template making `validate` conditionally
    // optional, not because it fires today.
    const contract = contractFor("dual_lane", {
      completionPolicy: "evidence_required",
      humanGates: [{ id: "extra-gate", afterStage: "compare", reason: "x", allowedDecisions: ["approve", "defer"] }],
      successCriteria: [{ id: "c1", statement: "extra gate approved", evidence: [{ kind: "human_gate", gateId: "extra-gate" }] }],
    });
    // extra-gate is required:true (contract-declared gates always are), so
    // this should NOT throw — documents the positive case explicitly.
    expect(() => compileStageGraph(contract)).not.toThrow();
  });
});
