import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { ORCH_CONFIG_DIR } from "../shared/paths.js";
import {
  buildAllocationRequest,
  emptyQuotaPolicy,
  parseCoordinatorTemplates,
  parseQuotaPolicy,
  parseRoles,
  parseWorkers,
  simulationScenarioSchema,
} from "./schemas.js";
import type { AllocationRequest, OrchestrationConfig } from "./types.js";

export interface SimulationScenario {
  name?: string;
  steps: Array<
    | { allocate: AllocationRequest }
    | { release: { leaseId?: string; taskId?: string; role?: string; workerId?: string } }
    | { heartbeat: { leaseId: string } }
    | { expire: { now: string } }
  >;
}

function readYamlFile(filePath: string): unknown {
  try {
    return yaml.load(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    throw new Error(`failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function requireFile(configDir: string, filename: string): string {
  const filePath = path.join(configDir, filename);
  if (!fs.existsSync(filePath)) throw new Error(`missing orchestration config file: ${filePath}`);
  return filePath;
}

export function loadOrchestrationConfig(configDir: string): OrchestrationConfig {
  const workers = parseWorkers(readYamlFile(requireFile(configDir, "workers.yaml")));
  const roles = parseRoles(readYamlFile(requireFile(configDir, "roles.yaml")));
  const coordinatorTemplates = parseCoordinatorTemplates(readYamlFile(requireFile(configDir, "coordinators.yaml")));
  const quotasPath = path.join(configDir, "quotas.yaml");
  const quotas = fs.existsSync(quotasPath) ? parseQuotaPolicy(readYamlFile(quotasPath)) : emptyQuotaPolicy();
  return { workers, roles, coordinatorTemplates, quotas };
}

export function loadDefaultOrchestrationConfig(): OrchestrationConfig {
  return loadOrchestrationConfig(ORCH_CONFIG_DIR);
}

export function loadAllocationRequest(filePath: string, config: OrchestrationConfig): AllocationRequest {
  return buildAllocationRequest(readYamlFile(filePath), config);
}

export function loadSimulationScenario(filePath: string, config: OrchestrationConfig): SimulationScenario {
  const parsed = simulationScenarioSchema.parse(readYamlFile(filePath));
  return {
    name: parsed.name,
    steps: parsed.steps.map((step) => {
      if ("allocate" in step) return { allocate: buildAllocationRequest(step.allocate, config) };
      return step;
    }),
  };
}
