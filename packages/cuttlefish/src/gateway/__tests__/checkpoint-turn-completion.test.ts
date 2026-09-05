import { describe, expect, it, vi } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import { SessionQueue } from "../../sessions/queue.js";
import type { Engine, CuttlefishConfig } from "../../shared/types.js";

withStaticTempCuttlefishHome("cuttlefish-checkpoint-completion-");

describe("checkpoint created during an engine turn", () => {
  it.each([false, true])("preserves the human wait when the requesting turn settles (throws=%s)", async (throws) => {
    const reg = await import("../../sessions/registry.js");
    const { createCheckpoint } = await import("../checkpoints.js");
    const { runWebSession } = await import("../run-web-session.js");
    reg.initDb();
    const session = reg.createSession({ engine: "codex", model: "gpt-5.5", source: "web", sourceRef: "web:in-turn-gate", prompt: "Ask the operator" });
    const config = { gateway: { host: "127.0.0.1", port: 8888 }, engines: { default: "codex", codex: { bin: "node", model: "gpt-5.5" } }, portal: {} } as CuttlefishConfig;
    const queue = new SessionQueue();
    let checkpointId = "";
    const engine: Engine = { name: "codex", run: vi.fn(async (options) => {
      checkpointId = createCheckpoint({ sessionId: session.id, payload: { decisionNeeded: "Choose A or B", why: "Operator owns this choice", resumePrompt: "Continue A" } }, context).checkpoint.id;
      options.onStream?.({ type: "text", content: "Waiting for your choice." });
      expect(reg.getSession(session.id)?.status).toBe("waiting");
      if (throws) throw new Error("engine fixture failed after checkpoint");
      return { result: "I am waiting for your choice.", sessionId: "native-checkpoint-turn", cost: 0.03, numTurns: 1 };
    }) };
    const context = { getConfig: () => config, connectors: new Map(), emit: vi.fn(), startTime: Date.now(), sessionManager: { getEngine: () => engine, getEngines: () => new Map([["codex", engine]]), getQueue: () => queue } } as any;
    await runWebSession(session, "Ask the operator", engine, config, context);
    expect(engine.run).toHaveBeenCalledTimes(1);
    const latest = reg.getSession(session.id)!;
    expect(latest.status).toBe("waiting");
    expect(latest.totalTurns).toBe(throws ? 0 : 1);
    expect(latest.totalCost).toBeCloseTo(throws ? 0 : 0.03);
    expect(latest.lastError).toContain("Choose A or B");
    expect(latest.transportMeta?.humanCheckpoint).toMatchObject({ checkpointId, state: "pending" });
    if (!throws) expect(reg.getMessages(session.id).some((m) => m.content === "I am waiting for your choice.")).toBe(true);
  });
  it.each(["user", "internal", "notification"].flatMap((kind) => [false, true].map((afterGate) => ({ kind, afterGate }))))("holds a $kind follower (afterGate=$afterGate)", async ({ kind, afterGate }) => {
    const reg = await import("../../sessions/registry.js");
    const { createCheckpoint, applyCheckpointDecision } = await import("../checkpoints.js");
    const { dispatchWebSessionRun, dispatchSessionNotification } = await import("../api/session-dispatch.js");
    const { continueSession } = await import("../continue-session.js");
    reg.initDb();
    const session = reg.createSession({ engine: "codex", model: "gpt-5.5", source: "web", sourceRef: "web:prequeued-gate", prompt: "First gated turn" });
    const config = { gateway: { host: "127.0.0.1", port: 8888 }, engines: { default: "codex", codex: { bin: "node", model: "gpt-5.5" } }, sessions: { interruptOnNewMessage: false }, portal: {} } as CuttlefishConfig;
    const queue = new SessionQueue();
    let started!: () => void;
    let openGate!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const mayOpen = new Promise<void>((resolve) => { openGate = resolve; });
    let checkpointId = "";
    const engine: Engine = { name: "codex", run: vi.fn(async (options) => {
      if (options.prompt === "First gated turn") {
        started();
        await mayOpen;
        checkpointId = createCheckpoint({ sessionId: session.id, payload: { decisionNeeded: "Choose", why: "Operator choice", resumePrompt: "Approved continuation" } }, context).checkpoint.id;
      }
      return { result: options.prompt, sessionId: "native-prequeue", numTurns: 1 };
    }) };
    const context = { getConfig: () => config, connectors: new Map(), emit: vi.fn(), startTime: Date.now(), sessionManager: { getEngine: () => engine, getEngines: () => new Map([["codex", engine]]), getQueue: () => queue } } as any;
    const first = dispatchWebSessionRun(session, "First gated turn", engine, config, context);
    await didStart;
    if (afterGate) { openGate(); await first; }
    if (kind === "internal") await dispatchSessionNotification(session.id, "Retained follower", undefined, context);
    else await continueSession({ sessionId: session.id, body: { message: "Retained follower", role: kind === "notification" ? "notification" : "user" }, context });
    await new Promise((resolve) => setTimeout(resolve, 20));
    openGate();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(engine.run).toHaveBeenCalledTimes(1);
    expect(reg.getSession(session.id)?.status).toBe("waiting");
    expect(reg.listPendingQueueItems(session.sessionKey).map((item) => item.prompt)).toEqual(["Retained follower"]);
    await applyCheckpointDecision(checkpointId, { decision: "approved", autonomous: kind === "internal" }, context);
    const resumeNotice = reg.getMessages(session.id).find((m) => m.role === "notification" && m.content.includes("Resuming"));
    expect(resumeNotice?.content).toContain(kind === "internal" ? "AI reviewers approved reconsideration" : "Human checkpoint approved");
    for (let i = 0; i < 100 && reg.listPendingQueueItems(session.sessionKey).length > 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(vi.mocked(engine.run).mock.calls.map(([options]) => options.prompt)).toEqual(["First gated turn", "Approved continuation", "Retained follower"]);
    expect(reg.listPendingQueueItems(session.sessionKey)).toEqual([]);
  });

  it.each(["onFallbackComplete", "onRetrySuccess"] as const)("preserves a checkpoint opened during %s", async (hook) => {
    const reg = await import("../../sessions/registry.js");
    const { createCheckpoint } = await import("../checkpoints.js");
    const rateLimit = await import("../../sessions/rate-limit-handler.js");
    const { runWebSession } = await import("../run-web-session.js");
    reg.initDb();
    const session = reg.createSession({ engine: "codex", model: "gpt-5.5", source: "web", sourceRef: `web:recovery-gate-${hook}`, prompt: "Recover" });
    const config = { gateway: { host: "127.0.0.1", port: 8888 }, engines: { default: "codex", codex: { bin: "node", model: "gpt-5.5" } }, sessions: { modelLadder: [] }, portal: {} } as unknown as CuttlefishConfig;
    const engine: Engine = { name: "codex", run: vi.fn(async () => ({ result: "", sessionId: "limited-turn", error: "429 rate limit", numTurns: 0 })) };
    const context = { getConfig: () => config, connectors: new Map(), emit: vi.fn(), startTime: Date.now(), sessionManager: { getEngine: () => engine, getEngines: () => new Map([["codex", engine]]), getQueue: () => new SessionQueue() } } as any;
    const recovery = vi.spyOn(rateLimit, "handleRateLimit").mockImplementation(async (opts) => {
      createCheckpoint({ sessionId: session.id, payload: { decisionNeeded: "Recovery choice", why: "Operator owns recovery", resumePrompt: "Continue" } }, context);
      const result = { result: "Waiting after recovery", sessionId: "recovery-turn", cost: 0.02, numTurns: 1 };
      await opts.hooks[hook]?.(result);
      return { kind: "fallback", result };
    });
    try {
      await runWebSession(session, "Recover", engine, config, context);
      expect(recovery).toHaveBeenCalledTimes(1);
      expect(reg.getSession(session.id)).toMatchObject({ status: "waiting", lastError: expect.stringContaining("Recovery choice"), totalTurns: 1, totalCost: 0.02 });
      expect(reg.getMessages(session.id).some((m) => m.content === "Waiting after recovery")).toBe(true);
    } finally { recovery.mockRestore(); }
  });

});
