import { describe, expect, it } from "vitest";
import { scopedTokenForbidden, scopedTokenSessionMismatch } from "../scoped-token.js";

describe("scopedTokenForbidden — operator control plane", () => {
  it("blocks the pre-existing operator surfaces", () => {
    expect(scopedTokenForbidden("PUT", "/api/config")).toBe(true);
    expect(scopedTokenForbidden("GET", "/api/logs")).toBe(true);
    expect(scopedTokenForbidden("GET", "/api/instances")).toBe(true);
    expect(scopedTokenForbidden("POST", "/api/auth/pair")).toBe(true);
    expect(scopedTokenForbidden("POST", "/api/org/employees")).toBe(true);
  });

  it("blocks human-oversight writes (approvals, checkpoints) but allows reads", () => {
    expect(scopedTokenForbidden("POST", "/api/approvals/abc/approve")).toBe(true);
    expect(scopedTokenForbidden("POST", "/api/checkpoints/xyz/decision")).toBe(true);
    expect(scopedTokenForbidden("POST", "/api/checkpoints")).toBe(true);
    // An agent may still poll the status of its own pending approval/checkpoint.
    expect(scopedTokenForbidden("GET", "/api/approvals")).toBe(false);
    expect(scopedTokenForbidden("GET", "/api/checkpoints/xyz")).toBe(false);
  });

  it("blocks cron and orchestration mutations but allows reads", () => {
    expect(scopedTokenForbidden("POST", "/api/cron")).toBe(true);
    expect(scopedTokenForbidden("DELETE", "/api/cron/job-1")).toBe(true);
    expect(scopedTokenForbidden("POST", "/api/orchestration/queue/pause")).toBe(true);
    expect(scopedTokenForbidden("POST", "/api/orchestration/leases/stop")).toBe(true);
    expect(scopedTokenForbidden("POST", "/api/orchestration/run")).toBe(true);
    expect(scopedTokenForbidden("GET", "/api/cron")).toBe(false);
    expect(scopedTokenForbidden("GET", "/api/orchestration/status")).toBe(false);
  });

  it("still allows the endpoints an agent legitimately needs", () => {
    expect(scopedTokenForbidden("GET", "/api/org")).toBe(false);
    expect(scopedTokenForbidden("GET", "/api/status")).toBe(false);
    expect(scopedTokenForbidden("POST", "/api/sessions")).toBe(false);
    expect(scopedTokenForbidden("POST", "/api/sessions/s-1/message")).toBe(false);
    expect(scopedTokenForbidden("POST", "/api/files")).toBe(false);
  });

  it("blocks path-traversal, redundant-slash, and case bypass attempts", () => {
    // The router resolves `..` before dispatch, so the deny list must too.
    expect(scopedTokenForbidden("POST", "/api/sessions/../approvals/abc/approve")).toBe(true);
    expect(scopedTokenForbidden("POST", "/api/sessions/../org/employees")).toBe(true);
    expect(scopedTokenForbidden("POST", "/api/foo/../../api/config")).toBe(true);
    // Redundant slashes collapse to the canonical path.
    expect(scopedTokenForbidden("POST", "/api/approvals//abc/approve")).toBe(true);
    // Case-folding closes a case-mismatch gap regardless of router casing.
    expect(scopedTokenForbidden("POST", "/api/Approvals/abc/approve")).toBe(true);
    expect(scopedTokenForbidden("PUT", "/api/Config")).toBe(true);
    // A traversal that resolves back to an allowed path stays allowed.
    expect(scopedTokenForbidden("POST", "/api/approvals/../sessions/s-1/message")).toBe(false);
  });

  it("blocks operator onboarding and bulk session delete for agent tokens (IAPI-CF-001, IAPI-CF-002)", () => {
    expect(scopedTokenForbidden("POST", "/api/onboarding")).toBe(true);
    expect(scopedTokenForbidden("POST", "/api/onboarding/step")).toBe(true);
    expect(scopedTokenForbidden("POST", "/api/sessions/bulk-delete")).toBe(true);
    expect(scopedTokenForbidden("POST", "/api/sessions/cancel-all")).toBe(true);
    // Onboarding bypass via traversal collapses and is still blocked.
    expect(scopedTokenForbidden("POST", "/api/sessions/../onboarding")).toBe(true);
  });
});

describe("scopedTokenSessionMismatch — per-session confinement (ARC-CF-001)", () => {
  it("allows a token to reach its own session's routes", () => {
    expect(scopedTokenSessionMismatch("s-1", "/api/sessions/s-1")).toBe(false);
    expect(scopedTokenSessionMismatch("s-1", "/api/sessions/s-1/message")).toBe(false);
    expect(scopedTokenSessionMismatch("s-1", "/api/sessions/s-1/queue/pause")).toBe(false);
    expect(scopedTokenSessionMismatch("s-1", "/api/sessions/s-1/queue/item-9")).toBe(false);
  });

  it("blocks a token from reaching another session's routes", () => {
    expect(scopedTokenSessionMismatch("s-1", "/api/sessions/s-2")).toBe(true);
    expect(scopedTokenSessionMismatch("s-1", "/api/sessions/s-2/message")).toBe(true);
    expect(scopedTokenSessionMismatch("s-1", "/api/sessions/s-2/reset")).toBe(true);
    expect(scopedTokenSessionMismatch("s-1", "/api/sessions/other/duplicate")).toBe(true);
  });

  it("does not apply to non-:id collection routes (governed elsewhere)", () => {
    expect(scopedTokenSessionMismatch("s-1", "/api/sessions")).toBe(false);
    expect(scopedTokenSessionMismatch("s-1", "/api/sessions/bulk-delete")).toBe(false);
    expect(scopedTokenSessionMismatch("s-1", "/api/status")).toBe(false);
    expect(scopedTokenSessionMismatch("s-1", "/api/org")).toBe(false);
  });

  it("collapses traversal/case before comparing so it cannot be bypassed", () => {
    // Encoded/relative variant that resolves to another session is blocked.
    expect(scopedTokenSessionMismatch("s-1", "/api/sessions/s-1/../s-2/message")).toBe(true);
    // Case-folding: the id compare is case-insensitive both ways.
    expect(scopedTokenSessionMismatch("S-1", "/api/sessions/s-1/message")).toBe(false);
    // A traversal resolving back to the own session stays allowed.
    expect(scopedTokenSessionMismatch("s-1", "/api/sessions/s-2/../s-1/message")).toBe(false);
  });
});
