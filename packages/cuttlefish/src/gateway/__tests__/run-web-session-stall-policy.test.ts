import { describe, it, expect } from "vitest";
import {
  resolveFallbackContinuationSession,
  isEngineDiedNoOutput,
  resolveStallLeaderName,
  resolveTurnStallWatchdogConfig,
  shouldNotifyLeaderReviewOnStall,
  shouldRetrySameEngineAfterStall,
} from "../run-web-session.js";
import type { Employee, OrgHierarchy, OrgNode, Session } from "../../shared/types.js";

describe("resolveTurnStallWatchdogConfig", () => {
  it("uses the tuned defaults when the gateway block omits stall settings", () => {
    const policy = resolveTurnStallWatchdogConfig({
      gateway: { port: 8888, host: "127.0.0.1" },
      engines: {
        default: "claude",
        claude: { bin: "claude", model: "opus" },
        codex: { bin: "codex", model: "gpt-5.5" },
      },
      connectors: {},
      logging: { file: true, stdout: true, level: "info" },
    });

    expect(policy).toMatchObject({
      tickMs: 30_000,
      leaderCheckMs: 240_000,
      inactivityMs: 900_000,
      hardCeilingMs: 2_700_000,
      maxRetries: 0,
    });
  });

  it("accepts explicit gateway stall overrides", () => {
    const policy = resolveTurnStallWatchdogConfig({
      gateway: {
        port: 8888,
        host: "127.0.0.1",
        turnStallLeaderCheckMs: 240_000,
        turnStallInactivityMs: 120_000,
        turnStallCeilingMs: 900_000,
        turnStallRetries: 2,
      },
      engines: {
        default: "claude",
        claude: { bin: "claude", model: "opus" },
        codex: { bin: "codex", model: "gpt-5.5" },
      },
      connectors: {},
      logging: { file: true, stdout: true, level: "info" },
    });

    expect(policy).toMatchObject({
      leaderCheckMs: 240_000,
      inactivityMs: 120_000,
      hardCeilingMs: 900_000,
      maxRetries: 2,
    });
  });
});

describe("isEngineDiedNoOutput", () => {
  it("recognizes a raw interrupted engine-exit result as a failure", () => {
    expect(isEngineDiedNoOutput({
      wasInterrupted: true,
      wasSuperseded: false,
      hasPartialOutput: false,
      error: "Interrupted: claude process exited",
      result: "Interrupted: claude process exited",
    })).toBe(true);
  });

  it("does not turn a superseded or partially streamed turn into an engine crash", () => {
    expect(isEngineDiedNoOutput({
      wasInterrupted: true,
      wasSuperseded: true,
      hasPartialOutput: false,
      error: "Interrupted: claude process exited",
      result: "",
    })).toBe(false);
    expect(isEngineDiedNoOutput({
      wasInterrupted: true,
      wasSuperseded: false,
      hasPartialOutput: true,
      error: "Interrupted: claude process exited",
      result: "",
    })).toBe(false);
  });
});

describe("shouldRetrySameEngineAfterStall", () => {
  it("allows one same-engine retry when maxRetries is 1", () => {
    expect(shouldRetrySameEngineAfterStall(0, 1)).toBe(true);
    expect(shouldRetrySameEngineAfterStall(1, 1)).toBe(false);
  });

  it("supports immediate fallback when maxRetries is 0", () => {
    expect(shouldRetrySameEngineAfterStall(0, 0)).toBe(false);
  });
});

describe("shouldNotifyLeaderReviewOnStall", () => {
  it("fires once after the leader-check threshold and before the hard inactivity kill", () => {
    expect(shouldNotifyLeaderReviewOnStall({
      idleMs: 239_000,
      leaderCheckMs: 240_000,
      inactivityMs: 900_000,
      alreadyNotified: false,
    })).toBe(false);

    expect(shouldNotifyLeaderReviewOnStall({
      idleMs: 240_000,
      leaderCheckMs: 240_000,
      inactivityMs: 900_000,
      alreadyNotified: false,
    })).toBe(true);

    expect(shouldNotifyLeaderReviewOnStall({
      idleMs: 500_000,
      leaderCheckMs: 240_000,
      inactivityMs: 900_000,
      alreadyNotified: true,
    })).toBe(false);

    expect(shouldNotifyLeaderReviewOnStall({
      idleMs: 900_000,
      leaderCheckMs: 240_000,
      inactivityMs: 900_000,
      alreadyNotified: false,
    })).toBe(false);
  });
});

describe("resolveStallLeaderName", () => {
  function node(name: string, rank: Employee["rank"], parentName: string | null): OrgNode {
    return {
      employee: { name, rank } as Employee,
      parentName,
      directReports: [],
      depth: 0,
      chain: [],
    };
  }

  function hierarchy(nodes: Record<string, OrgNode>): OrgHierarchy {
    return { root: null, nodes, sorted: Object.keys(nodes), warnings: [] };
  }

  const h = hierarchy({
    ceo: node("ceo", "executive", null),
    lead: node("lead", "manager", "ceo"),
    senior: node("senior", "senior", "lead"),
    worker: node("worker", "employee", "senior"),
  });

  it("climbs to the nearest manager ancestor", () => {
    expect(resolveStallLeaderName(h, "worker")).toBe("lead");
    expect(resolveStallLeaderName(h, "senior")).toBe("lead");
  });

  it("returns the executive when no manager sits between", () => {
    expect(resolveStallLeaderName(h, "lead")).toBe("ceo");
  });

  it("returns null for a missing employee name", () => {
    expect(resolveStallLeaderName(h, undefined)).toBeNull();
    expect(resolveStallLeaderName(h, null)).toBeNull();
    expect(resolveStallLeaderName(h, "ghost")).toBeNull();
  });

  it("returns null when the chain has no manager/executive ancestor", () => {
    const flat = hierarchy({
      a: node("a", "senior", "b"),
      b: node("b", "employee", null),
    });
    expect(resolveStallLeaderName(flat, "a")).toBeNull();
  });

  it("returns null when a parent reference dangles", () => {
    const broken = hierarchy({
      worker: node("worker", "employee", "ghost-parent"),
    });
    expect(resolveStallLeaderName(broken, "worker")).toBeNull();
  });
});

describe("resolveFallbackContinuationSession", () => {
  it("returns undefined instead of forcing a cold getSession lookup to exist", () => {
    const lookup = () => undefined;

    expect(resolveFallbackContinuationSession(undefined, "missing-session", lookup)).toBeUndefined();
  });

  it("prefers the updated session when updateSession returned one", () => {
    const updated = { id: "sess-1" } as Session;
    const lookup = () => {
      throw new Error("lookup should not be called");
    };

    expect(resolveFallbackContinuationSession(updated, "sess-1", lookup)).toBe(updated);
  });
});
