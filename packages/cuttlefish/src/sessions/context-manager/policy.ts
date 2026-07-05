import type { CuttlefishConfig } from "../../shared/types.js";
import type { ContextManagerMode } from "./block.js";

const MODES = new Set<ContextManagerMode>(["off", "shadow", "on"]);

export function parseContextManagerMode(value: unknown): ContextManagerMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return MODES.has(normalized as ContextManagerMode) ? normalized as ContextManagerMode : undefined;
}

export function contextManagerMode(config: CuttlefishConfig): ContextManagerMode {
  if (process.env.CUTTLEFISH_CONTEXT_MANAGER !== undefined) {
    return parseContextManagerMode(process.env.CUTTLEFISH_CONTEXT_MANAGER) ?? "off";
  }
  return parseContextManagerMode(config.context?.managerMode) ?? "off";
}

export function isContextManagedHistoryEngine(engine: string): boolean {
  return engine === "ollama" || engine === "kilo" || engine === "aider";
}
