/**
 * useMessageTts — React binding for the per-message read-aloud button.
 *
 * One process-wide TtsController (lazy, browser-deps) enforces single-active
 * playback across every message row; this hook subscribes to it and exposes the
 * phase for ONE message plus a toggle. Components stay dumb: render play / pause /
 * spinner from `phase` and call `toggle()`.
 */
import { useCallback, useSyncExternalStore } from "react"
import { TtsController, TTS_IDLE_SNAPSHOT, type TtsPhase } from "./tts-controller"
import { createTtsStart, defaultTtsDeps } from "./tts-engine"

let controller: TtsController | null = null

/** The shared controller (created on first use, in the browser). */
export function getMessageTtsController(): TtsController {
  if (!controller) controller = new TtsController(createTtsStart(defaultTtsDeps()))
  return controller
}

export interface MessageTts {
  phase: TtsPhase
  toggle: () => void
}

export function useMessageTts(id: string, text: string): MessageTts {
  const ctrl = getMessageTtsController()
  const snapshot = useSyncExternalStore(
    ctrl.subscribe,
    ctrl.getSnapshot,
    () => TTS_IDLE_SNAPSHOT, // SSR / static export: nothing is playing
  )
  const phase: TtsPhase = snapshot.id === id ? snapshot.phase : "idle"
  const toggle = useCallback(() => ctrl.toggle(id, text), [ctrl, id, text])
  return { phase, toggle }
}

/** Stop any active read-aloud (call on chat unmount / navigation). */
export function stopMessageTts(): void {
  controller?.stop()
}
