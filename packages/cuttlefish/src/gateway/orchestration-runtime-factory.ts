import { loadOrchestrationConfig } from "../orchestration/config.js";
import {
  createOrchestrationRuntimeFromConfig,
  type OrchestrationRuntime,
  type OrchestrationRuntimeOptions,
} from "../orchestration/runtime.js";
import { ORCH_CONFIG_DIR } from "../shared/paths.js";
import type { Employee, CuttlefishConfig } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { augmentOrchestrationConfigWithOrgWorkers } from "./org-worker-bridge.js";

export function createGatewayOrchestrationRuntime(
  config: CuttlefishConfig,
  registry: ReadonlyMap<string, Employee>,
  opts: OrchestrationRuntimeOptions = {},
): OrchestrationRuntime | undefined {
  if (config.orchestration?.enabled !== true) return undefined;
  const baseConfig = opts.config ?? loadOrchestrationConfig(config.orchestration.configDir ?? ORCH_CONFIG_DIR);
  const augmented = augmentOrchestrationConfigWithOrgWorkers(baseConfig, registry);
  for (const issue of augmented.skipped) {
    logger.warn(`[orchestration-org-bridge] ${issue.reason}: ${issue.name} (${issue.detail})`);
  }
  logger.info(
    `[orchestration-org-bridge] synthesized ${augmented.config.workers.length - baseConfig.workers.length} worker(s) ` +
    `and ${augmented.config.roles.length - baseConfig.roles.length} role(s)`,
  );
  return createOrchestrationRuntimeFromConfig(config, {
    ...opts,
    config: augmented.config,
  });
}
