import { describe, expect, it, vi } from "vitest";
import type { CuttlefishConfig } from "../../shared/types.js";
import type { UsageStatus } from "../../shared/usage-status.js";
import { engineHasHeadroom, filterWorkersWithHeadroom } from "../routing-headroom.js";
import type { Worker } from "../types.js";

const config = {
  boardWorker: {
    usage: { minRemainingPercent: 20 },
  },
} as CuttlefishConfig;

describe("engineHasHeadroom", () => {
  it("allows healthy live engines", async () => {
    const result = await engineHasHeadroom(worker("claude"), config, {
      isEngineAvailable: () => true,
      getUsageStatus: async () => status("claude", "ok", 80),
    });

    expect(result).toMatchObject({ ok: true, provider: "claude", reason: "usage_ok" });
  });

  it("filters exhausted engines and engines under the remaining-percent floor", async () => {
    const exhausted = await engineHasHeadroom(worker("codex"), config, {
      isEngineAvailable: () => true,
      getUsageStatus: async () => status("codex", "exhausted", 0),
    });
    const belowFloor = await engineHasHeadroom(worker("grok"), config, {
      isEngineAvailable: () => true,
      getUsageStatus: async () => status("grok", "ok", 10),
    });

    expect(exhausted).toMatchObject({ ok: false, reason: "usage_exhausted" });
    expect(belowFloor).toMatchObject({ ok: false, reason: "usage_below_min_remaining", minRemainingPercent: 20 });
  });

  it("filters unavailable live engines before usage probing", async () => {
    const getUsageStatus = vi.fn(async () => status("pi", "ok", 90));
    const result = await engineHasHeadroom(worker("pi"), config, {
      isEngineAvailable: () => false,
      getUsageStatus,
    });

    expect(result).toMatchObject({ ok: false, provider: "pi", reason: "engine_unavailable" });
    expect(getUsageStatus).not.toHaveBeenCalled();
  });

  it("leaves inert and unknown providers untouched so simulation stays pure", async () => {
    const getUsageStatus = vi.fn(async () => status("local_echo", "exhausted", 0));
    const result = await engineHasHeadroom(worker("local_echo"), config, {
      isEngineAvailable: () => false,
      getUsageStatus,
    });

    expect(result).toEqual({ ok: true, provider: "local_echo", reason: "non_live_provider" });
    expect(getUsageStatus).not.toHaveBeenCalled();
  });

  it("preserves worker ordering while separating rejected workers", async () => {
    const workers = [worker("claude", "a"), worker("codex", "b"), worker("local_echo", "c")];
    const result = await filterWorkersWithHeadroom(workers, config, {
      isEngineAvailable: () => true,
      getUsageStatus: async (engine) =>
        engine === "codex" ? status(engine, "exhausted", 0) : status(engine, "ok", 90),
    });

    expect(result.allowed.map((item) => item.id)).toEqual(["a", "c"]);
    expect(result.rejected.map((item) => [item.worker.id, item.headroom.reason])).toEqual([["b", "usage_exhausted"]]);
  });
});

function status(engine: string, state: UsageStatus["state"], remainingPercent?: number): UsageStatus {
  return { engine, state, remainingPercent, source: "live" };
}

function worker(provider: string, id = provider): Worker {
  return {
    id,
    provider,
    family: "test",
    tier: "frontier",
    capabilities: ["coding"],
    tools: ["git"],
    maxConcurrentTasks: 1,
    costClass: "low",
    workspacePolicy: "isolated_worktree",
  };
}
