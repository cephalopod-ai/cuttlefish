import { createOrchestrationRuntimeFromConfig, type OrchestrationRuntime } from "../orchestration/runtime.js";
import { logger } from "../shared/logger.js";
import type { CuttlefishConfig } from "../shared/types.js";
import type { ApiContext } from "./api/context.js";

export interface OrchestrationRuntimeRefreshState {
  pending: boolean;
  reason?: "config_reload" | "org_reload";
}

export interface OrchestrationRuntimeSwapOptions {
  refreshState?: OrchestrationRuntimeRefreshState;
  reason?: OrchestrationRuntimeRefreshState["reason"];
}

export function swapOrchestrationRuntime(
  apiContext: ApiContext,
  config: CuttlefishConfig,
  currentRuntime?: OrchestrationRuntime,
  createRuntime: (nextConfig: CuttlefishConfig) => OrchestrationRuntime | undefined = createOrchestrationRuntimeFromConfig,
  opts: OrchestrationRuntimeSwapOptions = {},
): OrchestrationRuntime | undefined {
  if (currentRuntime?.hasActiveWork()) {
    markRefreshDeferred(opts);
    bindRuntime(apiContext, currentRuntime);
    logger.warn("Orchestration runtime refresh deferred until active work drains");
    return currentRuntime;
  }

  if (config.orchestration?.enabled === true) {
    let nextRuntime: OrchestrationRuntime | undefined;
    try {
      nextRuntime = createRuntime(config);
    } catch (err) {
      logger.error(`Orchestration runtime refresh failed: ${err instanceof Error ? err.message : err}`);
      if (currentRuntime) bindRuntime(apiContext, currentRuntime);
      else unbindRuntime(apiContext);
      return currentRuntime;
    }
    if (nextRuntime) {
      bindRuntime(apiContext, nextRuntime);
      currentRuntime?.close();
      return nextRuntime;
    }
  }

  currentRuntime?.close();
  unbindRuntime(apiContext);
  return undefined;
}

export function refreshOrchestrationRuntimeForOrgReload(
  apiContext: ApiContext,
  config: CuttlefishConfig,
  currentRuntime: OrchestrationRuntime | undefined,
  createRuntime: (nextConfig: CuttlefishConfig) => OrchestrationRuntime | undefined = createOrchestrationRuntimeFromConfig,
  opts: OrchestrationRuntimeSwapOptions = {},
): OrchestrationRuntime | undefined {
  if (config.orchestration?.enabled !== true) return currentRuntime;
  if (currentRuntime?.hasActiveWork()) {
    markRefreshDeferred(opts);
    logger.warn("Orchestration org-worker bridge refresh deferred until active work drains");
    return currentRuntime;
  }
  return swapOrchestrationRuntime(apiContext, config, currentRuntime, createRuntime, opts);
}

export function refreshDeferredOrchestrationRuntimeIfDrained(
  apiContext: ApiContext,
  config: CuttlefishConfig,
  currentRuntime: OrchestrationRuntime | undefined,
  refreshState: OrchestrationRuntimeRefreshState,
  createRuntime: (nextConfig: CuttlefishConfig) => OrchestrationRuntime | undefined = createOrchestrationRuntimeFromConfig,
): OrchestrationRuntime | undefined {
  if (!refreshState.pending) return currentRuntime;
  if (currentRuntime?.hasActiveWork()) return currentRuntime;
  const reason = refreshState.reason;
  refreshState.pending = false;
  refreshState.reason = undefined;
  logger.info(`Applying deferred orchestration runtime refresh${reason ? ` after ${reason}` : ""}`);
  return swapOrchestrationRuntime(apiContext, config, currentRuntime, createRuntime);
}

function markRefreshDeferred(opts: OrchestrationRuntimeSwapOptions): void {
  if (!opts.refreshState) return;
  opts.refreshState.pending = true;
  opts.refreshState.reason = opts.reason;
}

function bindRuntime(apiContext: ApiContext, runtime: OrchestrationRuntime): void {
  apiContext.orchestration = {
    ...(apiContext.orchestration ?? {}),
    runtime,
  };
}

function unbindRuntime(apiContext: ApiContext): void {
  if (!apiContext.orchestration) return;
  delete apiContext.orchestration.runtime;
  if (Object.keys(apiContext.orchestration).length === 0) {
    delete apiContext.orchestration;
  }
}
