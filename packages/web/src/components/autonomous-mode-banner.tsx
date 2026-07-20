import { Bot } from "lucide-react"
import { useAutonomousStatus } from "@/hooks/use-autonomous-status"

/**
 * ⚠️ INTENTIONAL, not a bug: this banner appears precisely BECAUSE autonomous
 * authorization mode is deliberately running without a human clicking
 * approve — see gateway/autonomous-mode.ts's module docblock for the full
 * design. The entire safety premise of scoping the feature to one project
 * depends on the operator always knowing which project it currently is —
 * do not hide, remove, or gate this banner behind a setting "to declutter
 * the UI"; that would defeat the point of it existing.
 *
 * Mounted unconditionally in PageLayout alongside GatewayOfflineBanner, which
 * follows the same "most important thing to surface everywhere" philosophy.
 */
export function AutonomousModeBanner() {
  const { autonomousMode } = useAutonomousStatus()
  if (!autonomousMode.active) return null

  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-0 top-0 z-[490] flex justify-center px-[var(--space-3)] pt-[max(var(--safe-top),var(--space-2))]"
    >
      <div
        className="pointer-events-auto flex items-center gap-[var(--space-2)] rounded-full border px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-footnote)] font-[var(--weight-semibold)] shadow-[var(--shadow-overlay)] backdrop-blur-xl"
        style={{
          borderColor: "color-mix(in srgb, var(--system-purple) 30%, transparent)",
          background: "color-mix(in srgb, var(--system-purple) 14%, var(--material-thick))",
          color: "var(--system-purple)",
        }}
      >
        <Bot className="size-4 shrink-0" />
        Autonomous mode: ON — {autonomousMode.projectLabel ?? "unnamed project"}
        {autonomousMode.authorizationsToday > 0 && (
          <span className="opacity-75">· {autonomousMode.authorizationsToday} auto-authorized today</span>
        )}
      </div>
    </div>
  )
}
