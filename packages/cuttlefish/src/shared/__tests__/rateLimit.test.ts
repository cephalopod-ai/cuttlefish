import { describe, it, expect } from "vitest";
import type { EngineResult } from "../types.js";
import { isDeadSessionError, detectRateLimit } from "../rateLimit.js";

function makeResult(overrides: Partial<EngineResult> = {}): EngineResult {
  return {
    sessionId: "test-session",
    result: "",
    ...overrides,
  };
}

describe("isDeadSessionError", () => {
  it("returns true for error with zero cost and no rate limit", () => {
    const result = makeResult({
      error: "Claude exited with code 1 (no stderr output)",
      cost: 0,
      numTurns: 0,
    });
    expect(isDeadSessionError(result)).toBe(true);
  });

  it("returns true for error with undefined cost/turns (no work done)", () => {
    const result = makeResult({
      error: "Claude exited with code 1",
    });
    expect(isDeadSessionError(result)).toBe(true);
  });

  it("returns false when rate limit status is present", () => {
    const result = makeResult({
      error: "Claude usage limit reached",
      cost: 0,
      rateLimit: { status: "rejected" },
    });
    expect(isDeadSessionError(result)).toBe(false);
  });

  it("returns false when cost > 0 (work was done)", () => {
    const result = makeResult({
      error: "Some error after work",
      cost: 0.05,
      numTurns: 3,
    });
    expect(isDeadSessionError(result)).toBe(false);
  });

  it("returns false when numTurns > 0 (work was done)", () => {
    const result = makeResult({
      error: "Some error after work",
      cost: 0,
      numTurns: 1,
    });
    expect(isDeadSessionError(result)).toBe(false);
  });

  it("returns false when there is no error", () => {
    const result = makeResult({ result: "success" });
    expect(isDeadSessionError(result)).toBe(false);
  });

  // Secondary pattern matching — requires zero cost as conjunction
  it("returns true for 'error_during_execution' with zero cost", () => {
    const result = makeResult({
      error: "error_during_execution",
      cost: 0,
      numTurns: 0,
    });
    expect(isDeadSessionError(result)).toBe(true);
  });

  it("returns false for 'error_during_execution' when cost > 0 (real work done)", () => {
    const result = makeResult({
      error: "error_during_execution",
      cost: 0.05,
      numTurns: 1,
    });
    expect(isDeadSessionError(result)).toBe(false);
  });

  it("returns true for 'session not found' in error text", () => {
    const result = makeResult({
      error: "Session not found or expired",
      cost: 0,
    });
    expect(isDeadSessionError(result)).toBe(true);
  });

  it("returns true for 'invalid session' in error text", () => {
    const result = makeResult({
      error: "Invalid session ID provided",
      cost: 0,
    });
    expect(isDeadSessionError(result)).toBe(true);
  });

  it("returns true for 'session expired' in error text", () => {
    const result = makeResult({
      error: "The session has expired",
      cost: 0,
    });
    expect(isDeadSessionError(result)).toBe(true);
  });

  it("does not false-positive on rate limit errors with no cost", () => {
    const result = makeResult({
      error: "rate limit exceeded",
      cost: 0,
      rateLimit: { status: "rejected", resetsAt: 1234567890 },
    });
    expect(isDeadSessionError(result)).toBe(false);
  });

  it("does not interfere with detectRateLimit", () => {
    const rateLimited = makeResult({
      error: "Claude usage limit reached",
      rateLimit: { status: "rejected", resetsAt: 9999999999 },
    });
    expect(detectRateLimit(rateLimited).limited).toBe(true);
    expect(isDeadSessionError(rateLimited)).toBe(false);
  });
});

describe("detectRateLimit — extra usage / overage", () => {
  it("is not limited when isUsingOverage is true (Claude extra usage is active)", () => {
    const result = makeResult({
      rateLimit: { status: "rejected", isUsingOverage: true },
    });
    expect(detectRateLimit(result).limited).toBe(false);
  });

  it("is still limited when isUsingOverage is false", () => {
    const result = makeResult({
      rateLimit: { status: "rejected", isUsingOverage: false },
    });
    expect(detectRateLimit(result).limited).toBe(true);
  });

  it("is still limited when isUsingOverage is absent", () => {
    const result = makeResult({
      rateLimit: { status: "rejected" },
    });
    expect(detectRateLimit(result).limited).toBe(true);
  });
});
