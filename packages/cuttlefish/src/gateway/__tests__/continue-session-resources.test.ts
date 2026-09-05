import { afterEach, describe, expect, it, vi } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import type { ApiContext } from "../api/context.js";

withStaticTempCuttlefishHome("cuttlefish-continue-resource-validation-");

vi.mock("../mid-pair-orchestrator.js", () => ({ dispatchEmployeeSessionRun: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const reg = await import("../../sessions/registry.js");
  const { continueSession } = await import("../continue-session.js");
  const { SessionQueue } = await import("../../sessions/queue.js");
  reg.initDb();
  const session = reg.createSession({ engine: "codex", source: "web", sourceRef: `web:${crypto.randomUUID()}`, prompt: "Original work" });
  reg.updateSession(session.id, { status: "running" });
  const engine = { name: "codex", run: vi.fn(), isAlive: () => true, isTurnRunning: () => true, kill: vi.fn(), killAll: vi.fn() };
  const queue = new SessionQueue();
  const context = {
    getConfig: () => ({ gateway: {}, engines: { default: "codex" }, portal: {} }),
    emit: vi.fn(), connectors: new Map(), startTime: Date.now(),
    sessionManager: { getEngine: () => engine, getQueue: () => queue },
  } as unknown as ApiContext;
  return { reg, session, engine, context, continueSession };
}

describe("follow-up resource validation and interruption", () => {
  it("keeps the original turn eligible to finish when an attachment is rejected", async () => {
    const { reg, session, engine, context, continueSession } = await fixture();
    const result = await continueSession({ sessionId: session.id, body: { message: "Replacement work", attachments: ["nonexistent-upload"] }, context });

    expect(result.statusCode).toBe(400);
    expect(engine.kill).not.toHaveBeenCalled();
    expect(reg.getSession(session.id)?.transportMeta?.supersededRunningTurnAt).toBeUndefined();
    expect(reg.getSession(session.id)?.status).toBe("running");
    expect(reg.getMessages(session.id)).toEqual([]);
    expect(reg.listPendingQueueItems(session.sessionKey)).toEqual([]);
  });

  it("does not supersede or kill a turn that completes while attachments are resolving", async () => {
    const { reg, session, engine, context, continueSession } = await fixture();
    const resources = await import("../session-resources.js");
    const original = resources.attachResourcesToSession;
    vi.spyOn(resources, "attachResourcesToSession").mockImplementation(async (...args) => {
      reg.updateSession(session.id, { status: "idle" });
      return original(...args);
    });
    const result = await continueSession({ sessionId: session.id, body: { message: "Next work" }, context });

    expect(result.statusCode).toBe(200);
    expect(engine.kill).not.toHaveBeenCalled();
    expect(reg.getSession(session.id)?.transportMeta?.supersededRunningTurnAt).toBeUndefined();
  });

  it("still supersedes and interrupts a valid follow-up to an active turn", async () => {
    const { reg, session, engine, context, continueSession } = await fixture();
    const result = await continueSession({ sessionId: session.id, body: { message: "Replacement work" }, context });

    expect(result.statusCode).toBe(200);
    expect(engine.kill).toHaveBeenCalledWith(session.id, "Interrupted: new message received");
    expect(reg.getSession(session.id)?.transportMeta?.supersededRunningTurnAt).toEqual(expect.any(String));
    expect(reg.getMessages(session.id).some((message) => message.content === "Replacement work")).toBe(true);
  });

  it("retains the follow-up behind a checkpoint opened during resource validation", async () => {
    const { reg, session, engine, context, continueSession } = await fixture();
    const resources = await import("../session-resources.js");
    const original = resources.attachResourcesToSession;
    vi.spyOn(resources, "attachResourcesToSession").mockImplementation(async (...args) => {
      reg.updateSession(session.id, { status: "waiting", lastError: "Operator decision required" });
      return original(...args);
    });
    const result = await continueSession({ sessionId: session.id, body: { message: "Next work" }, context });

    expect(result.statusCode).toBe(200);
    expect(engine.kill).not.toHaveBeenCalled();
    expect(reg.getSession(session.id)?.transportMeta?.supersededRunningTurnAt).toBeUndefined();
    expect(reg.getSession(session.id)?.status).toBe("waiting");
    expect(reg.listPendingQueueItems(session.sessionKey).map((item) => item.prompt)).toEqual(["Next work"]);
  });

  it("returns not found if the session is deleted while resource validation awaits", async () => {
    const { reg, session, engine, context, continueSession } = await fixture();
    const resources = await import("../session-resources.js");
    vi.spyOn(resources, "attachResourcesToSession").mockImplementation(async () => {
      reg.deleteSession(session.id);
      return { session, blocked: false, promptBlock: null, engineAttachments: [] };
    });
    const result = await continueSession({ sessionId: session.id, body: { message: "Next work" }, context });
    expect(result.statusCode).toBe(404);
    expect(engine.kill).not.toHaveBeenCalled();
    expect(reg.listPendingQueueItems(session.sessionKey)).toEqual([]);
  });
});
