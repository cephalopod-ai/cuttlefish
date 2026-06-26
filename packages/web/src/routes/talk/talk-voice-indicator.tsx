/**
 * Cuttlefish Talk — neural-vs-fallback voice indicator.
 *
 * A tiny dot + label showing which voice produced the last spoken turn:
 *   • "Neural" — the gateway streamed Kokoro audio and it played.
 *   • "Fallback" — the browser Web-Speech synth (Kokoro absent/unavailable).
 * Driven by useTalk's `voiceMode` (set per turn from whether talk:audio arrived).
 * Renders nothing until the first turn has been spoken, so it stays invisible
 * on the calm idle surface.
 *
 * Note: it deliberately does NOT show a "Muted" state — the active top-right mute
 * button already conveys that, so a bottom chip would be redundant. When muted,
 * `voiceMode` is null, so this renders nothing.
 */
import type { VoiceMode } from "./use-talk"

export function TalkVoiceIndicator({ voiceMode }: { voiceMode: VoiceMode }) {
  // Fallback is a state the operator should NOTICE (degraded voice), so it renders
  // as a small bordered chip. Neural is the expected, calm state — a quiet dot +
  // label so it doesn't shout on the surface.
  if (!voiceMode) return null
  const neural = voiceMode === "neural"
  if (neural) {
    return (
      <span
        className="inline-flex items-center gap-1 text-[length:var(--text-caption2)] text-[var(--text-quaternary)]"
        title="Spoken with the neural Kokoro voice"
      >
        <span aria-hidden className="size-1.5 rounded-full" style={{ background: "var(--accent)" }} />
        Neural
      </span>
    )
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-[var(--separator)] bg-[var(--material-regular)] px-1.5 py-0.5 text-[length:var(--text-caption2)] font-medium text-[var(--system-orange)]"
      title="Spoken with the browser fallback voice (neural voice unavailable)"
    >
      <span aria-hidden className="size-1.5 rounded-full" style={{ background: "var(--system-orange)" }} />
      Fallback
    </span>
  )
}
