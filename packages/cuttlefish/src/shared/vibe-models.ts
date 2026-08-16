import type { ModelInfo } from "./types.js";

export const VIBE_EFFORT_LEVELS: string[] = [];

export interface VibeModelDiscovery {
  defaultModel?: string;
  models: ModelInfo[];
}

function vibeModelInfo(id: string, label?: string): ModelInfo {
  return { id, label: label || id, supportsEffort: false, effortLevels: [] };
}

/**
 * Static catalog (no live discovery): Vibe's model choice is a per-user
 * `~/.vibe/config.toml` setting rather than something the CLI exposes as a
 * queryable list, so — like Kilo and Ollama — Cuttlefish just offers the
 * known Mistral model ids and lets `engines.vibe.model` (or Vibe's own
 * `active_model` default when unset) pick the actual one.
 */
export function knownVibeModels(pinned?: string): VibeModelDiscovery {
  const ids = ["mistral-medium-3.5", "mistral-large-2.2", "codestral-2.2", "mistral-small-3.5"];
  if (pinned && !ids.includes(pinned)) ids.unshift(pinned);
  return { defaultModel: pinned || ids[0], models: ids.map((id) => vibeModelInfo(id)) };
}
