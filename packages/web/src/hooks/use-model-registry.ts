import { useQuery } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import { api, type EnginesResponse, type EngineRegistryEntry, type ModelInfo } from '@/lib/api'

/**
 * Fetch + cache the model/capability registry (GET /api/engines). Single source
 * of truth for the Engine / Model / Effort selectors — never hardcode model lists.
 */
export function useModelRegistry() {
  return useQuery({
    queryKey: queryKeys.engines.all,
    queryFn: () => api.getEngines(),
  })
}

/** Installed engine entries as an array (uninstalled engines are hidden from the UI). */
export function engineList(reg: EnginesResponse | undefined): EngineRegistryEntry[] {
  if (!reg?.engines) return []
  return Object.values(reg.engines).filter((e) => e.available)
}

/** The model entry for a given engine+modelId (falls back to the engine's default). */
export function findModel(
  reg: EnginesResponse | undefined,
  engine: string | undefined,
  modelId: string | undefined,
): ModelInfo | undefined {
  if (!reg?.engines || !engine) return undefined
  const entry = reg.engines[engine]
  if (!entry) return undefined
  return (
    (modelId ? entry.models.find((m) => m.id === modelId) : undefined) ??
    entry.models.find((m) => m.id === entry.defaultModel) ??
    entry.models[0]
  )
}

/** Valid effort levels for an engine+model (empty when the model has no effort). */
export function effortLevelsFor(
  reg: EnginesResponse | undefined,
  engine: string | undefined,
  modelId: string | undefined,
): string[] {
  const model = findModel(reg, engine, modelId)
  return model?.supportsEffort ? model.effortLevels : []
}

/** Context window (tokens) for an engine+model, or undefined if unknown. */
export function contextWindowFor(
  reg: EnginesResponse | undefined,
  engine: string | undefined,
  modelId: string | undefined,
): number | undefined {
  return findModel(reg, engine, modelId)?.contextWindow
}

/** Sensible default effort: 'medium' if available, else the first level, else undefined. */
export function defaultEffort(levels: string[]): string | undefined {
  if (!levels.length) return undefined
  return levels.includes('medium') ? 'medium' : levels[0]
}

/** Keep `current` if still valid for the new level set, otherwise pick a default. */
export function clampEffort(levels: string[], current: string | undefined): string | undefined {
  if (current && levels.includes(current)) return current
  return defaultEffort(levels)
}
