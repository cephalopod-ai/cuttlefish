import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempCuttlefishHomeForTest } from "../../test-utils/cuttlefish-home.js";

const homeHandle = createTempCuttlefishHomeForTest("cuttlefish-begin-run-");

type Reg = typeof import("../registry.js");
type Ledger = typeof import("../../run-ledger/index.js");
let reg: Reg;
let ledger: Ledger;

beforeEach(async () => {
  homeHandle.setup();
  reg = await import("../registry.js");
  ledger = await import("../../run-ledger/index.js");
  reg.initDb();
});

afterEach(() => {
  ledger.resetRunLedgerForTest();
  homeHandle.cleanup();
});

describe("beginSessionRun", () => {
  it("creates a canonical run, stamps the active run id, and is queryable from the ledger", () => {
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:1" });

    const updated = reg.beginSessionRun({ sessionId: session.id, prompt: "do the work" });
    expect(updated).toBeDefined();

    const runId = (updated!.transportMeta as Record<string, unknown>).activeRunId as string;
    expect(typeof runId).toBe("string");
    expect((updated!.transportMeta as Record<string, unknown>).latestRunId).toBe(runId);

    const runs = ledger.getRunLedger().listRunsForSession(session.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].runId).toBe(runId);
    expect(runs[0].currentState).toBe("created");
    expect(runs[0].promptExcerpt).toBe("do the work");
  });

  it("links a child run to its parent's active run", () => {
    const parent = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:1" });
    const parentRun = reg.beginSessionRun({ sessionId: parent.id, prompt: "parent" });
    const parentRunId = (parentRun!.transportMeta as Record<string, unknown>).activeRunId as string;

    const child = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:2",
      parentSessionId: parent.id,
    });
    const childRun = reg.beginSessionRun({ sessionId: child.id, prompt: "child" });
    const childRunId = (childRun!.transportMeta as Record<string, unknown>).activeRunId as string;

    const links = ledger.getRunLedger().listChildRunLinks(parentRunId);
    expect(links.map((l) => l.childRunId)).toContain(childRunId);
  });

  it("returns undefined for a missing session", () => {
    expect(reg.beginSessionRun({ sessionId: "nope" })).toBeUndefined();
  });
});

describe("updateSession ledger sync", () => {
  it("transitions the active run to completed when a running session settles to idle", () => {
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:1" });
    const started = reg.beginSessionRun({ sessionId: session.id, prompt: "go" });
    const runId = (started!.transportMeta as Record<string, unknown>).activeRunId as string;

    reg.updateSession(session.id, { status: "running" });
    expect(ledger.getRunLedger().getRun(runId)!.currentState).toBe("running");

    reg.updateSession(session.id, { status: "idle" });
    expect(ledger.getRunLedger().getRun(runId)!.currentState).toBe("completed");
  });

  it("transitions the active run to failed and records the error on a session error", () => {
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:1" });
    const started = reg.beginSessionRun({ sessionId: session.id, prompt: "go" });
    const runId = (started!.transportMeta as Record<string, unknown>).activeRunId as string;

    reg.updateSession(session.id, { status: "running" });
    reg.updateSession(session.id, { status: "error", lastError: "explode" });

    const run = ledger.getRunLedger().getRun(runId)!;
    expect(run.currentState).toBe("failed");
    expect(ledger.getRunLedger().listRunErrors(runId).some((e) => e.errorMessage === "explode")).toBe(true);
  });
});

describe("recoverStaleSessions ledger sync", () => {
  it("marks the active run interrupted when a running session is recovered", () => {
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:1" });
    const started = reg.beginSessionRun({ sessionId: session.id, prompt: "go" });
    const runId = (started!.transportMeta as Record<string, unknown>).activeRunId as string;
    reg.updateSession(session.id, { status: "running" });

    const recovered = reg.recoverStaleSessions();
    expect(recovered).toBe(1);
    expect(ledger.getRunLedger().getRun(runId)!.currentState).toBe("interrupted");
  });
});
