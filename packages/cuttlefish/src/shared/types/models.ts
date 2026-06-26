export interface PortalConfig {
  portalName?: string;
  operatorName?: string;
  language?: string;
  onboarded?: boolean;
  setupComplete?: boolean;
}

/**
 * Model + capability registry.
 *
 * The resolved registry (see shared/models.ts) is the single source of truth for
 * which engines/models exist and what they support. A NEW model shipping is a
 * config edit (`models:` block in config.yaml), zero code change. When the block
 * is absent, the registry is synthesized from `engines.<name>.model` so existing
 * configs keep working.
 */

/** How an engine conveys reasoning-effort to its CLI. */
export type EffortMechanism = "claude-flag" | "codex-config" | "grok-flag" | "pi-flag" | "kiro-flag" | "none";

/** A single model and its capabilities, as exposed to the UI / validation. */
export interface ModelInfo {
  id: string;
  label: string;
  supportsEffort: boolean;
  /** Valid effort levels for THIS model (empty when supportsEffort is false). */
  effortLevels: string[];
  /** Context window size in tokens (for the UI context meter). Omit if unknown. */
  contextWindow?: number;
}

/** Resolved per-engine registry entry. */
export interface EngineRegistryEntry {
  name: string;
  /** Engine is registered/usable in this build. */
  available: boolean;
  /** Default model id for new sessions on this engine. */
  defaultModel: string;
  effortMechanism: EffortMechanism;
  models: ModelInfo[];
}

/** Resolved registry, keyed by engine name. */
export type ModelRegistry = Record<string, EngineRegistryEntry>;

export interface EngineLimitWindow {
  name: string;
  usedPercent?: number;
  windowDurationMins?: number;
  /** Unix timestamp in seconds. */
  resetsAt?: number;
  resetsAtIso?: string;
}

export interface EngineLimitContext {
  usedPercent?: number;
  remainingPercent?: number;
  contextWindowSize?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
}

export interface EngineLimitCredits {
  hasCredits?: boolean;
  unlimited?: boolean;
  balance?: string;
  limit?: number;
  used?: number;
  remainingPercent?: number;
  resetsAt?: number;
  resetsAtIso?: string;
}

export interface EngineLimitBucket {
  id: string;
  name?: string;
  planType?: string;
  primary?: EngineLimitWindow;
  secondary?: EngineLimitWindow;
  credits?: EngineLimitCredits;
}

export interface EngineLimitEngineSnapshot {
  name: string;
  available: boolean;
  status: "live" | "snapshot" | "static" | "unsupported" | "error";
  source: string;
  refreshedAt: string;
  defaultModel?: string;
  models: ModelInfo[];
  accountPlan?: string;
  windows?: EngineLimitWindow[];
  buckets?: EngineLimitBucket[];
  credits?: EngineLimitCredits;
  context?: EngineLimitContext;
  costUsd?: number;
  unsupportedReason?: string;
  error?: string;
  stale?: boolean;
}

export interface EngineLimitsResponse {
  generatedAt: string;
  default: string;
  engines: Record<string, EngineLimitEngineSnapshot>;
}

export interface ModelConfigEntry {
  id: string;
  label?: string;
  supportsEffort?: boolean;
  effortLevels?: string[];
  contextWindow?: number;
}

export interface EngineModelsConfig {
  default?: string;
  effortMechanism?: EffortMechanism;
  models: ModelConfigEntry[];
}

/** `models:` block keyed by engine name (claude | codex | antigravity | grok | pi). */
export type ModelsConfig = Record<string, EngineModelsConfig>;
