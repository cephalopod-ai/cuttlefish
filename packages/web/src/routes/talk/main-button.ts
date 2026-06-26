/**
 * Cuttlefish Talk — main control-button mode.
 *
 * One big action-aware button drives the loop. Its meaning depends on context:
 *   - recording → "stop" (tap to stop the mic and send the transcript)
 *   - text in the input → "send" (the mic morphs into a send button)
 *   - otherwise → "mic" (tap to start talking)
 *
 * Pure + dependency-free so it can be unit-tested without the DOM. The page
 * computes `hasText` (the typed-input has trimmed content) and `listening`.
 */
export type MainButtonMode = "mic" | "send" | "stop"

export function mainButtonMode({
  listening,
  hasText,
}: {
  listening: boolean
  hasText: boolean
}): MainButtonMode {
  if (listening) return "stop"
  if (hasText) return "send"
  return "mic"
}
