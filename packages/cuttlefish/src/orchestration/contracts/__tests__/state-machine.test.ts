import { describe, expect, it } from "vitest";
import {
  ATTEMPT_STATES,
  CONTRACT_PHASES,
  TERMINAL_CONTRACT_PHASES,
  canTransitionAttemptState,
  canTransitionContractPhase,
  canTransitionStageState,
  computeContractOutcome,
  isRetryEligible,
  TERMINAL_STAGE_STATES,
  type AttemptState,
  type ContractPhase,
  type StageOutcomeInput,
  type StageState,
} from "../state-machine.js";

describe("contract phase state machine", () => {
  it("RC-REL-1 regression: dead_lettered is reachable from blocked_resource and awaiting_human", () => {
    expect(canTransitionContractPhase("blocked_resource", "dead_lettered")).toBe(true);
    expect(canTransitionContractPhase("awaiting_human", "dead_lettered")).toBe(true);
  });

  it("every terminal phase has zero outgoing edges, including to cancelled", () => {
    for (const terminal of TERMINAL_CONTRACT_PHASES) {
      for (const target of CONTRACT_PHASES) {
        expect(canTransitionContractPhase(terminal, target)).toBe(false);
      }
    }
  });

  it("every non-terminal phase can transition to cancelled", () => {
    for (const phase of CONTRACT_PHASES) {
      if (TERMINAL_CONTRACT_PHASES.has(phase)) continue;
      expect(canTransitionContractPhase(phase, "cancelled")).toBe(true);
    }
  });

  it("RC-FLOW-3 regression: applying has a mandatory edge into validating", () => {
    expect(canTransitionContractPhase("applying", "validating")).toBe(true);
    // and applying is not itself a dead end (the original proposal's gap)
    expect(canTransitionContractPhase("applying", "passed")).toBe(false);
  });

  it("RC-FLOW-2 regression: reviewing has an explicit exit to failed (revision budget exhaustion)", () => {
    expect(canTransitionContractPhase("reviewing", "failed")).toBe(true);
    expect(canTransitionContractPhase("revising", "failed")).toBe(true);
  });

  it("RC-REL-3 regression: executing can re-enter blocked_resource for a stage-level allocation timeout", () => {
    expect(canTransitionContractPhase("executing", "blocked_resource")).toBe(true);
  });

  it("accepted can go straight to preparing (immediate allocation) or via blocked_resource", () => {
    expect(canTransitionContractPhase("accepted", "preparing")).toBe(true);
    expect(canTransitionContractPhase("accepted", "blocked_resource")).toBe(true);
  });

  it("rejects illegal forward-skipping and backward edges", () => {
    expect(canTransitionContractPhase("accepted", "passed")).toBe(false);
    expect(canTransitionContractPhase("validating", "executing")).toBe(false);
    expect(canTransitionContractPhase("passed", "executing")).toBe(false);
    expect(canTransitionContractPhase("preparing", "passed")).toBe(false);
  });

  it("validating only reaches passed directly (outcome is computed, not implied by phase shape)", () => {
    expect(canTransitionContractPhase("validating", "passed")).toBe(true);
    expect(canTransitionContractPhase("validating", "failed")).toBe(true);
    expect(canTransitionContractPhase("validating", "awaiting_human")).toBe(true);
  });
});

describe("attempt state machine", () => {
  it("RC-STATE-2 regression: running can transition to cancelled", () => {
    expect(canTransitionAttemptState("running", "cancelled")).toBe(true);
  });

  it("RC-CONC-1 regression: claimed can transition to claim_lost", () => {
    expect(canTransitionAttemptState("claimed", "claim_lost")).toBe(true);
  });

  it("every terminal attempt state has zero outgoing edges", () => {
    const terminals: AttemptState[] = ["succeeded", "failed", "interrupted", "timed_out", "cancelled", "claim_lost"];
    for (const terminal of terminals) {
      for (const target of ATTEMPT_STATES) {
        expect(canTransitionAttemptState(terminal, target)).toBe(false);
      }
    }
  });

  it("rejects skipping allocation/claim stages", () => {
    expect(canTransitionAttemptState("pending", "running")).toBe(false);
    expect(canTransitionAttemptState("pending", "succeeded")).toBe(false);
  });
});

describe("isRetryEligible", () => {
  it("RC-STATE-2 / RC-CONC-1 regression: cancelled and claim_lost are never retry-eligible, even if retryOn would otherwise match", () => {
    // retryOn lists only accept AttemptFailureKind ("failed"|"interrupted"|"timed_out"),
    // so cancelled/claim_lost can never appear there — the point of this test is that
    // no combination of inputs can make them retry-eligible.
    expect(isRetryEligible("cancelled", ["failed", "interrupted", "timed_out"])).toBe(false);
    expect(isRetryEligible("claim_lost", ["failed", "interrupted", "timed_out"])).toBe(false);
  });

  it("failed/interrupted/timed_out are retry-eligible only when declared in retryOn", () => {
    expect(isRetryEligible("failed", ["failed"])).toBe(true);
    expect(isRetryEligible("failed", ["interrupted"])).toBe(false);
    expect(isRetryEligible("interrupted", [])).toBe(false);
    expect(isRetryEligible("timed_out", ["timed_out", "failed"])).toBe(true);
  });

  it("non-terminal-failure states are never retry-eligible", () => {
    expect(isRetryEligible("succeeded", ["failed", "interrupted", "timed_out"])).toBe(false);
    expect(isRetryEligible("running", ["failed", "interrupted", "timed_out"])).toBe(false);
  });
});

describe("stage state machine", () => {
  it("supports the retry loop-back from running to runnable", () => {
    expect(canTransitionStageState("running", "runnable")).toBe(true);
  });

  it("every terminal stage state has zero outgoing edges", () => {
    for (const terminal of TERMINAL_STAGE_STATES) {
      for (const target of ["pending", "runnable", "running", "succeeded", "failed", "skipped"] as StageState[]) {
        expect(canTransitionStageState(terminal, target)).toBe(false);
      }
    }
  });
});

describe("computeContractOutcome (RC-STATE-1)", () => {
  it("returns pending when a required stage has not reached a terminal state", () => {
    const stages: StageOutcomeInput[] = [
      { required: true, state: "succeeded" },
      { required: true, state: "pending" },
    ];
    expect(computeContractOutcome(stages)).toBe("pending");
  });

  it("RC-STATE-1 regression: cannot return passed when a required validate-equivalent stage was never attempted", () => {
    // Simulates the exact bug: reviewing "passes" but the graph's required
    // validate stage never ran. Outcome must be pending, never passed,
    // regardless of what the contract's phase column says.
    const stages: StageOutcomeInput[] = [
      { required: true, state: "succeeded" }, // implement
      { required: true, state: "succeeded" }, // review (passed)
      { required: true, state: "pending" }, // validate (never ran)
    ];
    expect(computeContractOutcome(stages)).toBe("pending");
  });

  it("returns failed when a required stage failed", () => {
    const stages: StageOutcomeInput[] = [
      { required: true, state: "succeeded" },
      { required: true, state: "failed" },
    ];
    expect(computeContractOutcome(stages)).toBe("failed");
  });

  it("RC-REL-4 regression: an optional stage's failure never blocks a passing outcome", () => {
    const stages: StageOutcomeInput[] = [
      { required: true, state: "succeeded" },
      { required: false, state: "failed" },
    ];
    expect(computeContractOutcome(stages)).toBe("passed");
  });

  it("an optional stage still pending does not block a passing outcome", () => {
    const stages: StageOutcomeInput[] = [
      { required: true, state: "succeeded" },
      { required: false, state: "pending" },
    ];
    expect(computeContractOutcome(stages)).toBe("passed");
  });

  it("passes vacuously when there are no required stages at all", () => {
    const stages: StageOutcomeInput[] = [{ required: false, state: "pending" }];
    expect(computeContractOutcome(stages)).toBe("passed");
    expect(computeContractOutcome([])).toBe("passed");
  });

  it("passes only once every required stage succeeded", () => {
    const stages: StageOutcomeInput[] = [
      { required: true, state: "succeeded" },
      { required: true, state: "succeeded" },
      { required: true, state: "succeeded" },
    ];
    expect(computeContractOutcome(stages)).toBe("passed");
  });
});
