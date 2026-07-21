import { beforeEach, describe, expect, it, vi } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

const hoisted = vi.hoisted(() => ({
  dispatchEmployeeSessionRun: vi.fn(),
}));

vi.mock("../mid-pair-orchestrator.js", () => ({
  dispatchEmployeeSessionRun: hoisted.dispatchEmployeeSessionRun,
}));

withStaticTempCuttlefishHome("cuttlefish-session-dispatch-manager-");

describe("dispatchSessionNotification manager synthesis barrier", () => {
  beforeEach(async () => {
    hoisted.dispatchEmployeeSessionRun.mockReset();
    const reg = await import("../../sessions/registry.js");
    reg.initDb();
  });

  it("does not bypass the manager-child barrier through the in-process notification sink", async () => {
    const reg = await import("../../sessions/registry.js");
    const { dispatchSessionNotification } = await import("../api/session-dispatch.js");
    const parent = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:parent-sink", prompt: "parent" });
    const firstChild = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:child-sink-a", parentSessionId: parent.id, prompt: "child a" });
    const secondChild = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:child-sink-b", parentSessionId: parent.id, prompt: "child b" });
    reg.updateSession(firstChild.id, { transportMeta: { activeRunId: "child-a", latestRunId: "child-a" } as any });
    reg.updateSession(secondChild.id, {
      status: "running",
      transportMeta: { activeRunId: "child-b", latestRunId: "child-b" } as any,
    });
    reg.updateSession(parent.id, {
      transportMeta: {
        managerDelegationEnforcement: {
          promptHash: "sink-barrier",
          childSessionIds: [firstChild.id, secondChild.id],
          completedChildSessionIds: [firstChild.id, secondChild.id],
          synthesisDispatched: false,
        },
      } as any,
    });

    const context = {
      getConfig: () => ({ gateway: {}, engines: { default: "claude", claude: { bin: "node" } } }),
      emit: vi.fn(),
      sessionManager: {
        getEngine: () => ({ name: "claude" }),
        getQueue: () => ({ clearCancelled: vi.fn() }),
      },
    } as any;

    await dispatchSessionNotification(parent.id, "📩 Employee \"Explorer\" replied in child session", undefined, context);

    expect(hoisted.dispatchEmployeeSessionRun).not.toHaveBeenCalled();
    expect(reg.getMessages(parent.id).at(-1)).toMatchObject({ role: "notification" });
    expect((reg.getSession(parent.id)?.transportMeta as any)?.managerDelegationEnforcement?.synthesisDispatched).toBe(false);
  });

  it("claims the final in-process notification once after every child is terminal", async () => {
    const reg = await import("../../sessions/registry.js");
    const { dispatchSessionNotification } = await import("../api/session-dispatch.js");
    const parent = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:parent-sink-final", prompt: "parent" });
    const child = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:child-sink-final", parentSessionId: parent.id, prompt: "child" });
    reg.updateSession(child.id, { transportMeta: { activeRunId: "child-final", latestRunId: "child-final" } as any });
    reg.updateSession(parent.id, {
      transportMeta: {
        managerDelegationEnforcement: {
          promptHash: "sink-final",
          childSessionIds: [child.id],
          completedChildSessionIds: [child.id],
          synthesisDispatched: false,
        },
      } as any,
    });
    const context = {
      getConfig: () => ({ gateway: {}, engines: { default: "claude", claude: { bin: "node" } } }),
      emit: vi.fn(),
      sessionManager: {
        getEngine: () => ({ name: "claude" }),
        getQueue: () => ({ clearCancelled: vi.fn() }),
      },
    } as any;

    await dispatchSessionNotification(parent.id, "first completion", undefined, context);
    await dispatchSessionNotification(parent.id, "duplicate completion", undefined, context);

    expect(hoisted.dispatchEmployeeSessionRun).toHaveBeenCalledTimes(1);
    expect((reg.getSession(parent.id)?.transportMeta as any)?.managerDelegationEnforcement?.synthesisDispatched).toBe(true);
  });

  it("does not let a completed old delegation batch silence a later unrelated child", async () => {
    const reg = await import("../../sessions/registry.js");
    const { dispatchSessionNotification } = await import("../api/session-dispatch.js");
    const parent = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:parent-old-batch", prompt: "parent" });
    const oldChild = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:old-child", parentSessionId: parent.id, prompt: "old" });
    const laterChild = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:later-child", parentSessionId: parent.id, prompt: "later" });
    reg.updateSession(parent.id, {
      transportMeta: {
        managerDelegationEnforcement: {
          promptHash: "old-batch",
          childSessionIds: [oldChild.id],
          completedChildSessionIds: [oldChild.id],
          synthesisDispatched: true,
          synthesisDispatchedAt: new Date(Date.now() - 60_000).toISOString(),
        },
      } as any,
    });
    const context = {
      getConfig: () => ({ gateway: {}, engines: { default: "claude", claude: { bin: "node" } } }),
      emit: vi.fn(),
      sessionManager: {
        getEngine: () => ({ name: "claude" }),
        getQueue: () => ({ clearCancelled: vi.fn() }),
      },
    } as any;

    await dispatchSessionNotification(parent.id, "later child completed", undefined, context, {
      sourceChildSessionId: laterChild.id,
    });

    expect(hoisted.dispatchEmployeeSessionRun).toHaveBeenCalledOnce();
  });

  it("lets a forced supervisor reminder bypass a stale synthesis barrier", async () => {
    const reg = await import("../../sessions/registry.js");
    const { dispatchSessionNotification } = await import("../api/session-dispatch.js");
    const parent = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:parent-reminder", prompt: "parent" });
    reg.updateSession(parent.id, {
      transportMeta: {
        managerDelegationEnforcement: {
          promptHash: "settled-batch",
          childSessionIds: ["old-child"],
          completedChildSessionIds: ["old-child"],
          synthesisDispatched: true,
          synthesisDispatchedAt: new Date().toISOString(),
        },
      } as any,
    });
    const context = {
      getConfig: () => ({ gateway: {}, engines: { default: "claude", claude: { bin: "node" } } }),
      emit: vi.fn(),
      sessionManager: {
        getEngine: () => ({ name: "claude" }),
        getQueue: () => ({ clearCancelled: vi.fn() }),
      },
    } as any;

    await dispatchSessionNotification(parent.id, "second supervisor notice", undefined, context, {
      bypassManagerDelegationBarrier: true,
    });

    expect(hoisted.dispatchEmployeeSessionRun).toHaveBeenCalledOnce();
  });
});
