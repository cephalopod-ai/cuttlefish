import { describe, expect, it, vi } from "vitest";
import {
  refreshDeferredOrchestrationRuntimeIfDrained,
  refreshOrchestrationRuntimeForOrgReload,
  swapOrchestrationRuntime,
} from "../orchestration-runtime-manager.js";
import type { ApiContext } from "../api/context.js";
import type { CuttlefishConfig } from "../../shared/types.js";

describe("swapOrchestrationRuntime", () => {
  it("binds a newly constructed runtime and closes the old one", () => {
    const oldRuntime = runtime(false);
    const nextRuntime = runtime(false);
    const ctx = makeContext(oldRuntime.instance);

    const bound = swapOrchestrationRuntime(ctx, config(true), oldRuntime.instance, () => nextRuntime.instance);

    expect(bound).toBe(nextRuntime.instance);
    expect(ctx.orchestration?.runtime).toBe(nextRuntime.instance);
    expect(oldRuntime.close).toHaveBeenCalledOnce();
  });

  it("keeps the current runtime bound in drain mode when orchestration is disabled with active work", () => {
    const current = runtime(true);
    const ctx = makeContext(current.instance);

    const bound = swapOrchestrationRuntime(ctx, config(false), current.instance, () => undefined);

    expect(bound).toBe(current.instance);
    expect(ctx.orchestration?.runtime).toBe(current.instance);
    expect(current.close).not.toHaveBeenCalled();
  });

  it("defers enabled runtime replacement while active work is running", () => {
    const current = runtime(true);
    const next = runtime(false);
    const createRuntime = vi.fn(() => next.instance);
    const refreshState = { pending: false };
    const ctx = makeContext(current.instance);

    const bound = swapOrchestrationRuntime(ctx, config(true), current.instance, createRuntime, {
      refreshState,
      reason: "config_reload",
    });

    expect(bound).toBe(current.instance);
    expect(ctx.orchestration?.runtime).toBe(current.instance);
    expect(createRuntime).not.toHaveBeenCalled();
    expect(current.close).not.toHaveBeenCalled();
    expect(refreshState).toEqual({ pending: true, reason: "config_reload" });
  });

  it("unbinds and closes the runtime when orchestration is disabled and there is no active work", () => {
    const current = runtime(false);
    const ctx = makeContext(current.instance);

    const bound = swapOrchestrationRuntime(ctx, config(false), current.instance, () => undefined);

    expect(bound).toBeUndefined();
    expect(ctx.orchestration?.runtime).toBeUndefined();
    expect(current.close).toHaveBeenCalledOnce();
  });
});

describe("refreshOrchestrationRuntimeForOrgReload", () => {
  it("defers org-worker refresh while active orchestration work is running", () => {
    const current = runtime(true);
    const next = runtime(false);
    const ctx = makeContext(current.instance);

    const bound = refreshOrchestrationRuntimeForOrgReload(ctx, config(true), current.instance, () => next.instance);

    expect(bound).toBe(current.instance);
    expect(ctx.orchestration?.runtime).toBe(current.instance);
    expect(current.close).not.toHaveBeenCalled();
    expect(next.close).not.toHaveBeenCalled();
  });

  it("replays a deferred refresh after active work drains", () => {
    const current = runtime(false);
    const next = runtime(false);
    const refreshState = { pending: true, reason: "org_reload" as const };
    const ctx = makeContext(current.instance);

    const bound = refreshDeferredOrchestrationRuntimeIfDrained(ctx, config(true), current.instance, refreshState, () => next.instance);

    expect(bound).toBe(next.instance);
    expect(ctx.orchestration?.runtime).toBe(next.instance);
    expect(current.close).toHaveBeenCalledOnce();
    expect(refreshState).toEqual({ pending: false, reason: undefined });
  });

  it("swaps to a fresh runtime on org reload after drain", () => {
    const current = runtime(false);
    const next = runtime(false);
    const ctx = makeContext(current.instance);

    const bound = refreshOrchestrationRuntimeForOrgReload(ctx, config(true), current.instance, () => next.instance);

    expect(bound).toBe(next.instance);
    expect(ctx.orchestration?.runtime).toBe(next.instance);
    expect(current.close).toHaveBeenCalledOnce();
  });
});

function makeContext(runtime?: unknown): ApiContext {
  return {
    config: config(true),
    getConfig: () => config(true),
    sessionManager: {} as any,
    startTime: Date.now(),
    emit: vi.fn(),
    connectors: new Map(),
    orchestration: runtime ? { runtime: runtime as any } : undefined,
  } as ApiContext;
}

function config(enabled: boolean): CuttlefishConfig {
  return {
    gateway: { port: 8888, host: "127.0.0.1" },
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "opus" },
      codex: { bin: "codex", model: "gpt" },
    },
    connectors: {},
    logging: { file: false, stdout: false, level: "error" },
    orchestration: { enabled },
  } as CuttlefishConfig;
}

function runtime(active: boolean) {
  const close = vi.fn();
  const instance = {
    close,
    hasActiveWork: () => active,
  };
  return { instance: instance as any, close };
}
