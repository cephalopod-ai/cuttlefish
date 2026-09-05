import { describe, expect, it, vi } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import { SessionQueue } from "../../sessions/queue.js";
import type { Engine, CuttlefishConfig } from "../../shared/types.js";

withStaticTempCuttlefishHome("cuttlefish-checkpoint-completion-");

describe("checkpoint created during an engine turn", () => {
  it("preserves the human wait when the requesting turn returns", async () => {
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
      return { result: "I am waiting for your choice.", sessionId: "native-checkpoint-turn", cost: 0.03, numTurns: 1 };
    }) };
    const context = { getConfig: () => config, connectors: new Map(), emit: vi.fn(), startTime: Date.now(), sessionManager: { getEngine: () => engine, getEngines: () => new Map([["codex", engine]]), getQueue: () => queue } } as any;
    await runWebSession(session, "Ask the operator", engine, config, context);
    expect(engine.run).toHaveBeenCalledTimes(1);
    const latest = reg.getSession(session.id)!;
    expect(latest.status).toBe("waiting");
    expect(latest.totalTurns).toBe(1);
    expect(latest.totalCost).toBeCloseTo(0.03);
    expect(latest.lastError).toContain("Choose A or B");
    expect(latest.transportMeta?.humanCheckpoint).toMatchObject({ checkpointId, state: "pending" });
    expect(reg.getMessages(session.id).some((m) => m.content === "I am waiting for your choice.")).toBe(true);
  });
});
