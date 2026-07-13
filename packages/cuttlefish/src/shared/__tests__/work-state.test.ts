import { describe, it, expect } from "vitest";
import { deriveWorkState, emptyWorkCounts, WORK_STATES } from "../work-state.js";

describe("deriveWorkState — precedence", () => {
  it("approvalRequired beats running and waiting", () => {
    expect(deriveWorkState({ status: "running", approvalRequired: true })).toBe("waiting_on_human");
    expect(deriveWorkState({ status: "waiting", approvalRequired: true })).toBe("waiting_on_human");
    expect(deriveWorkState({ status: "waiting", transportState: "running", approvalRequired: true })).toBe(
      "waiting_on_human",
    );
  });

  it("non-approval 'waiting' → blocked", () => {
    expect(deriveWorkState({ status: "waiting" })).toBe("blocked");
    expect(deriveWorkState({ status: "waiting", approvalRequired: false })).toBe("blocked");
  });

  it("'error' → failed", () => {
    expect(deriveWorkState({ status: "error" })).toBe("failed");
  });

  it("transport 'queued' → queued", () => {
    expect(deriveWorkState({ status: "idle", transportState: "queued" })).toBe("queued");
  });

  it("running via status or transport → running", () => {
    expect(deriveWorkState({ status: "running" })).toBe("running");
    expect(deriveWorkState({ status: "idle", transportState: "running" })).toBe("running");
  });

  it("'interrupted' → blocked", () => {
    expect(deriveWorkState({ status: "interrupted" })).toBe("blocked");
  });

  it("idle after a durable run → completed", () => {
    expect(deriveWorkState({ status: "idle", hasRun: true })).toBe("completed");
    expect(deriveWorkState({ status: "idle", transportState: "idle", hasRun: true })).toBe("completed");
  });

  it("never-run idle sessions remain queued", () => {
    expect(deriveWorkState({ status: "idle", hasRun: false })).toBe("queued");
  });

  it("queued does not override an active approval", () => {
    expect(deriveWorkState({ status: "idle", transportState: "queued", approvalRequired: true })).toBe(
      "waiting_on_human",
    );
  });

  it("error does not override an active approval", () => {
    // approvalRequired is checked first by design (a session can be errored on a
    // prior turn yet still hold a pending approval — the human gate wins).
    expect(deriveWorkState({ status: "error", approvalRequired: true })).toBe("waiting_on_human");
  });
});

describe("emptyWorkCounts", () => {
  it("has a zero for every work state", () => {
    const counts = emptyWorkCounts();
    for (const s of WORK_STATES) expect(counts[s]).toBe(0);
    expect(Object.keys(counts).sort()).toEqual([...WORK_STATES].sort());
  });
});
