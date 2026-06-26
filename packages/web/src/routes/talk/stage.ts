/**
 * Cuttlefish Talk — stage state machine (stage redesign).
 *
 * One derived mode decides who owns the centre of the screen:
 *   hero       — nothing to show; the orb is the hero (idle/listening, empty).
 *   conversing — words exist (or are imminent); the transcript owns the stage
 *                and the orb docks small at the top. Includes the FIRST
 *                thinking beat (state alone, zero rows) so the orb yields
 *                immediately, not only after text lands.
 *   content    — an unresolved blocking card (approval/choice) exists; the
 *                card is the single focal point, the transcript dims.
 *
 * Pure + total: unknown inputs fall through to "conversing" (transcript
 * visible is the safest default).
 */
import { useEffect, useRef, useState } from "react"

export type StageMode = "hero" | "conversing" | "content"

export interface StageInput {
  state: "idle" | "listening" | "thinking" | "speaking"
  hasRows: boolean
  pinnedCount: number
}

export function deriveStage(input: StageInput): StageMode {
  if (input.pinnedCount > 0) return "content"
  if (input.hasRows || input.state === "thinking" || input.state === "speaking") return "conversing"
  if (input.state === "idle" || input.state === "listening") return "hero"
  return "conversing"
}

/** Only a downgrade to hero is debounced — sub-second state flickers must not
 *  bounce the orb back to hero size mid-conversation. Everything else is
 *  immediate (content always wins instantly). */
export function shouldDelayStageChange(prev: StageMode, next: StageMode): boolean {
  return next === "hero" && prev !== "hero"
}

export const STAGE_DOWNGRADE_HOLD_MS = 600

export const DOCKED_ORB_SIZE = 56

/** Hero orb size from the stage cell rect: half the min dimension, clamped. */
export function heroOrbSize(width: number, height: number): number {
  const base = Math.min(width || 0, height || width || 0)
  return Math.max(140, Math.min(base * 0.5, 300))
}

/** React binding: derives the mode and applies the downgrade hold. */
export function useStageMode(input: StageInput): StageMode {
  const target = deriveStage(input)
  const [mode, setMode] = useState<StageMode>(target)
  const timerRef = useRef<number | null>(null)
  useEffect(() => {
    if (target === mode) return
    if (!shouldDelayStageChange(mode, target)) {
      setMode(target)
      return
    }
    timerRef.current = window.setTimeout(() => setMode(target), STAGE_DOWNGRADE_HOLD_MS)
    return () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [target, mode])
  return mode
}
