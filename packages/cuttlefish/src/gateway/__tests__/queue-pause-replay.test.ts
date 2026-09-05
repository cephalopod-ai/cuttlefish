import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../run-web-session.js", () => ({
  runWebSession: vi.fn(async () => {}),
}));

async function setup() {
  vi.resetModules();
  const dispatch = await import("../api/session-dispatch.js");
  const reg = await import("../../sessions/registry.js");
  const { SessionQueue } = await import("../../sessions/queue.js");
  reg.initDb();
  return { dispatch, reg, SessionQueue };
}

/** Polls instead of a fixed sleep — the mid_pair bypass fix routes every
 *  dispatch here through a couple of extra dynamic-import hops
 *  (org.js, mid-pair-orchestrator.js), so a fixed short timeout is no
 *  longer a reliable bound, especially with a fresh module graph per test
 *  (vi.resetModules() in beforeEach) paying full re-evaluation cost. */
async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!check()) throw new Error("waitFor: condition not met in time");
}

let tmpHome: string;
const testHome = withTempCuttlefishHome("cuttlefish-queue-pause-replay-");

beforeEach(() => {
  tmpHome = testHome.home();
  vi.resetModules();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("resumePendingWebQueueItems", () => {
  it.each(["boot", "drain"])("restores persisted files and resource context during %s replay", async (mode) => {
    const { dispatch, reg, SessionQueue } = await setup();
    const { attachResourcesToSession } = await import("../session-resources.js");
    const { runWebSession } = await import("../run-web-session.js");
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: `web:resources-${mode}`, prompt: "Inspect the resources" });
    const filePath = path.join(tmpHome, "empty.txt");
    fs.writeFileSync(filePath, "");
    const notesPath = path.join(tmpHome, "notes.txt");
    fs.writeFileSync(notesPath, "The acceptance criterion is a blue square.");
    const queue = new SessionQueue();
    const ctx = {
      getConfig: () => ({ gateway: {}, engines: { default: "claude" }, sessions: { autoResumeOnBoot: true } }),
      connectors: new Map(), startTime: Date.now(), emit: vi.fn(),
      sessionManager: { getEngine: () => ({}) as any, getQueue: () => queue },
    } as any;
    const attached = await attachResourcesToSession(session, {
      resources: [{ path: filePath }, { path: notesPath }, { url: "https://example.com/reference", intendedUse: "reference" }],
    }, ctx);
    expect(attached.blocked).toBe(false);
    const itemId = reg.enqueueQueueItem(session.id, session.sessionKey, "Inspect the resources");

    if (mode === "boot") await dispatch.resumePendingWebQueueItems(ctx);
    else await dispatch.redispatchPendingWebQueueItemsForSessionKey(ctx, session.sessionKey);
    await waitFor(() => reg.getQueueItem(itemId)?.status === "completed");

    const call = vi.mocked(runWebSession).mock.calls.find((args) => args[0].id === session.id)!;
    expect(call).toBeDefined();
    expect(call[5]).toEqual([filePath]);
    expect(call[6]).toContain("Attached resources:");
    expect(call[6]).toContain("https://example.com/reference");
    expect(call[6]).toContain("The acceptance criterion is a blue square.");
  }, 15_000);

  it("leaves pending work untouched on startup unless autoResumeOnBoot is enabled", async () => {
    const { dispatch, reg, SessionQueue } = await setup();
    const session = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:auto-resume-disabled",
      prompt: "queued work",
    });
    const itemId = reg.enqueueQueueItem(session.id, session.sessionKey, "do not replay by default");

    const queue = new SessionQueue();
    const getEngine = vi.fn(() => ({}) as any);
    const ctx = {
      getConfig: () => ({ gateway: {}, engines: { default: "claude" }, sessions: {} }),
      connectors: new Map(),
      startTime: Date.now(),
      emit: vi.fn(),
      sessionManager: {
        getEngine,
        getQueue: () => queue,
      },
    } as any;

    await dispatch.resumePendingWebQueueItems(ctx);

    expect(reg.getQueueItem(itemId)?.status).toBe("pending");
    expect(getEngine).not.toHaveBeenCalled();
  });

  it("leaves paused pending work untouched across a restarted queue until resume", async () => {
    const { dispatch, reg, SessionQueue } = await setup();
    const session = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:paused-replay",
      prompt: "queued work",
    });

    const originalQueue = new SessionQueue();
    originalQueue.pauseQueue(session.sessionKey);
    const itemId = reg.enqueueQueueItem(session.id, session.sessionKey, "continue after restart");

    // Simulate restart: a new in-memory queue must hydrate the durable pause row.
    const restartedQueue = new SessionQueue();
    const getEngine = vi.fn(() => ({}) as any);
    const ctx = {
      getConfig: () => ({ gateway: {}, engines: { default: "claude" }, sessions: { autoResumeOnBoot: true } }),
      connectors: new Map(),
      startTime: Date.now(),
      emit: vi.fn(),
      sessionManager: {
        getEngine,
        getQueue: () => restartedQueue,
      },
    } as any;

    await dispatch.resumePendingWebQueueItems(ctx);

    expect(restartedQueue.isPaused(session.sessionKey)).toBe(true);
    expect(reg.getQueueItem(itemId)?.status).toBe("pending");
    expect(getEngine).not.toHaveBeenCalled();

    restartedQueue.resumeQueue(session.sessionKey);
    await dispatch.redispatchPendingWebQueueItemsForSessionKey(ctx, session.sessionKey);
    await waitFor(() => reg.getQueueItem(itemId)?.status === "completed");

    expect(getEngine).toHaveBeenCalledWith("claude");
    expect(reg.getQueueItem(itemId)?.status).toBe("completed");
  });

  it("does not replay human-waiting work on boot or queue drain, but resumes after a decision", async () => {
    const { dispatch, reg, SessionQueue } = await setup();
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:checkpoint-wait", prompt: "seed" });
    reg.updateSession(session.id, { status: "waiting" });
    const itemId = reg.enqueueQueueItem(session.id, session.sessionKey, "wait for approval");
    const queue = new SessionQueue();
    const getEngine = vi.fn(() => ({}) as any);
    const ctx = {
      getConfig: () => ({ gateway: {}, engines: { default: "claude" }, sessions: { autoResumeOnBoot: true } }),
      connectors: new Map(), startTime: Date.now(), emit: vi.fn(),
      sessionManager: { getEngine, getQueue: () => queue },
    } as any;
    await dispatch.resumePendingWebQueueItems(ctx);
    expect(await dispatch.redispatchPendingWebQueueItemsForSessionKey(ctx, session.sessionKey)).toBe(0);
    expect(getEngine).not.toHaveBeenCalled();
    expect(reg.getQueueItem(itemId)?.status).toBe("pending");
    reg.updateSession(session.id, { status: "idle" });
    expect(await dispatch.redispatchPendingWebQueueItemsForSessionKey(ctx, session.sessionKey)).toBe(1);
    await waitFor(() => reg.getQueueItem(itemId)?.status === "completed");
  });

  it("drains durable pending web queue items in FIFO order", async () => {
    const { dispatch, reg, SessionQueue } = await setup();
    const { runWebSession } = await import("../run-web-session.js");
    const session = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "employee:hr-manager",
      sessionKey: "employee:hr-manager",
      prompt: "queued work",
    });
    const first = reg.enqueueQueueItem(session.id, session.sessionKey, "first pending");
    const second = reg.enqueueQueueItem(session.id, session.sessionKey, "second pending");

    const queue = new SessionQueue();
    const getEngine = vi.fn(() => ({}) as any);
    const ctx = {
      getConfig: () => ({ gateway: {}, engines: { default: "claude" }, sessions: { autoResumeOnBoot: true } }),
      connectors: new Map(),
      startTime: Date.now(),
      emit: vi.fn(),
      sessionManager: {
        getEngine,
        getQueue: () => queue,
      },
    } as any;

    expect(await dispatch.redispatchPendingWebQueueItemsForSessionKey(ctx, session.sessionKey)).toBe(1);
    await waitFor(() => reg.getQueueItem(second)?.status === "completed");

    expect(vi.mocked(runWebSession).mock.calls.map((call) => call[1])).toEqual([
      "first pending",
      "second pending",
    ]);
    expect(reg.getQueueItem(first)?.status).toBe("completed");
    expect(reg.getQueueItem(second)?.status).toBe("completed");
  });
});
