import { describe, expect, it } from "vitest";
import {
  isLegacyTaskPayload,
  runContractV1Schema,
  synthesizeProcessOnlyContract,
} from "../schema.js";
import type { LiveRunTaskPayload } from "../../live-run.js";

function minimalContract(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "1",
    taskId: "t1",
    coordinatorId: "default",
    mode: "single_worker",
    prompt: "do the thing",
    completionPolicy: "process_only",
    sourceDriftPolicy: "warn",
    ...overrides,
  };
}

describe("runContractV1Schema", () => {
  it("accepts a minimal process_only contract", () => {
    const parsed = runContractV1Schema.parse(minimalContract());
    expect(parsed.successCriteria).toEqual([]);
    expect(parsed.humanGates).toEqual([]);
  });

  it("rejects unknown top-level fields", () => {
    expect(() => runContractV1Schema.parse(minimalContract({ notAField: true }))).toThrow();
  });

  it("requires at least one success criterion when completionPolicy is evidence_required", () => {
    expect(() =>
      runContractV1Schema.parse(minimalContract({ completionPolicy: "evidence_required", successCriteria: [] })),
    ).toThrow(/success criterion/);
  });

  it("accepts evidence_required with a properly cross-referenced success criterion", () => {
    const parsed = runContractV1Schema.parse(
      minimalContract({
        completionPolicy: "evidence_required",
        validation: { steps: [{
          id: "tests", argv: ["pnpm", "test"], timeoutMs: 60_000, environment: "inherit_safe", network: "deny_if_supported",
        }] },
        successCriteria: [{
          id: "tests-pass",
          statement: "tests pass",
          evidence: [{ kind: "validation_step", stepId: "tests" }],
        }],
      }),
    );
    expect(parsed.successCriteria).toHaveLength(1);
  });

  it("rejects a success criterion referencing an undeclared validation step", () => {
    expect(() =>
      runContractV1Schema.parse(
        minimalContract({
          completionPolicy: "evidence_required",
          successCriteria: [{
            id: "c1",
            statement: "x",
            evidence: [{ kind: "validation_step", stepId: "does-not-exist" }],
          }],
        }),
      ),
    ).toThrow(/undeclared validation step/);
  });

  it("requires at least one human gate when completionPolicy is human_acceptance", () => {
    expect(() =>
      runContractV1Schema.parse(minimalContract({ completionPolicy: "human_acceptance", humanGates: [] })),
    ).toThrow(/human gate/);
  });

  it("rejects duplicate success-criterion ids", () => {
    expect(() =>
      runContractV1Schema.parse(
        minimalContract({
          completionPolicy: "evidence_required",
          validation: { steps: [{ id: "s", argv: ["true"], timeoutMs: 1000, environment: "minimal", network: "inherit" }] },
          successCriteria: [
            { id: "dup", statement: "a", evidence: [{ kind: "validation_step", stepId: "s" }] },
            { id: "dup", statement: "b", evidence: [{ kind: "validation_step", stepId: "s" }] },
          ],
        }),
      ),
    ).toThrow(/duplicate id/);
  });

  it("rejects an id that does not match the allowed pattern", () => {
    expect(() => runContractV1Schema.parse(minimalContract({ taskId: "has a space" }))).toThrow();
  });

  it("bounds the prompt length", () => {
    expect(() => runContractV1Schema.parse(minimalContract({ prompt: "x".repeat(20_001) }))).toThrow();
  });

  it("defaults review.adversarialGating to true and review.maxRevisionPasses to 2", () => {
    const parsed = runContractV1Schema.parse(
      minimalContract({
        review: { required: true, independence: "different_family_required", blockingSeverities: ["critical"] },
      }),
    );
    expect(parsed.review?.adversarialGating).toBe(true);
    expect(parsed.review?.maxRevisionPasses).toBe(2);
  });

  it("bounds maxRevisionPasses", () => {
    expect(() =>
      runContractV1Schema.parse(
        minimalContract({
          review: { required: true, maxRevisionPasses: 6, independence: "operator_selected", blockingSeverities: [] },
        }),
      ),
    ).toThrow();
  });
});

describe("isLegacyTaskPayload", () => {
  it("recognizes a legacy task payload with no schemaVersion", () => {
    const legacy: LiveRunTaskPayload = {
      taskId: "t1", coordinatorId: "default", priority: "normal", leaseDurationMs: 60_000, prompt: "do it",
    };
    expect(isLegacyTaskPayload(legacy)).toBe(true);
  });

  it("does not recognize a versioned contract body as legacy", () => {
    expect(isLegacyTaskPayload(minimalContract())).toBe(false);
  });

  it("rejects non-object input", () => {
    expect(isLegacyTaskPayload(null)).toBe(false);
    expect(isLegacyTaskPayload("string")).toBe(false);
  });
});

describe("synthesizeProcessOnlyContract", () => {
  it("produces a valid, unverified-labeled contract from a legacy task", () => {
    const legacy: LiveRunTaskPayload = {
      taskId: "t1", coordinatorId: "default", priority: "high", leaseDurationMs: 120_000, prompt: "legacy prompt",
      title: "Legacy task", model: "opus",
    };
    const contract = synthesizeProcessOnlyContract(legacy, "single_worker");
    expect(contract.completionPolicy).toBe("process_only");
    expect(contract.sourceDriftPolicy).toBe("warn");
    expect(contract.successCriteria).toEqual([]);
    expect(contract.routing?.priority).toBe("high");
    expect(contract.routing?.model).toBe("opus");
    // Must itself validate against the same schema real contracts do.
    expect(() => runContractV1Schema.parse(contract)).not.toThrow();
  });
});
