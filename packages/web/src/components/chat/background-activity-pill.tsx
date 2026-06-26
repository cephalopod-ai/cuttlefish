import type { BackgroundActivity } from '@/lib/api'

const BACKGROUND_ACTIVITY_STALE_MS = 5 * 60 * 1000

/**
 * Subtle informational pill shown when the session is officially idle but
 * background work (subagents / background tasks) is still making API calls.
 * Purely informational — never blocks input. The parent hides it while a
 * foreground turn is streaming (the "Thinking" indicator owns that state)
 * and it disappears when backgroundActivity clears (null / 0 streams).
 */
export function BackgroundActivityPill({
  activity,
}: {
  activity: BackgroundActivity | null
}) {
  const n = activity?.activeStreams ?? 0
  const lastActivityAt = activity?.lastActivityAt ? new Date(activity.lastActivityAt).getTime() : 0
  const stale = lastActivityAt > 0 && Date.now() - lastActivityAt > BACKGROUND_ACTIVITY_STALE_MS
  if (n <= 0 || stale) return null
  return (
    <div className="px-[var(--space-3)] pb-[var(--space-1)] lg:px-[var(--space-8)]">
      <span
        className="inline-flex items-center gap-1.5 rounded-full border border-[var(--separator)] bg-[var(--fill-tertiary)] py-0.5 px-2 text-[length:var(--text-caption2)] text-[var(--text-tertiary)]"
        title="Background work running after the turn ended"
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--system-orange)] animate-[cuttlefish-pulse_1.4s_infinite]" />
        {n === 1 ? 'Background agent working (1)' : `Background agents working (${n})`}
      </span>
      {/* Self-contained keyframes so the pill doesn't depend on ChatMessages
          (which defines the same animation) being mounted, e.g. in CLI view. */}
      <style>{`
        @keyframes cuttlefish-pulse {
          0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
          40% { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </div>
  )
}
