import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { cn } from "@/lib/utils"

interface TriageChipProps {
  label: string
  count: number
  href: string
  icon: ReactNode
  className?: string
}

/**
 * One entry in the Command Center triage strip: "Needs approval (n)",
 * "Blocked (n)", etc. — each deep-links to the filtered surface (plan
 * Section 12, Phase 5). Amber/attention styling only when count > 0;
 * a zero count reads as calm/neutral, never alarming (see the plan's
 * "calm by default, loud on exception" principle, Section 2).
 */
export function TriageChip({ label, count, href, icon, className }: TriageChipProps) {
  const needsAttention = count > 0
  return (
    <Link
      to={href}
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[length:var(--text-footnote)] font-[var(--weight-semibold)] transition-transform duration-150 hover:-translate-y-0.5",
        needsAttention
          ? "border-[color-mix(in_srgb,var(--system-orange)_40%,transparent)] bg-[color-mix(in_srgb,var(--system-orange)_12%,transparent)] text-[var(--system-orange)]"
          : "border-[var(--separator)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]",
        className,
      )}
    >
      <span className={needsAttention ? "text-[var(--system-orange)]" : "text-[var(--text-tertiary)]"}>{icon}</span>
      {label}
      <span
        className={cn(
          "inline-flex min-w-[1.4em] items-center justify-center rounded-full px-1.5 text-[length:var(--text-caption1)] font-[var(--weight-bold)]",
          needsAttention ? "bg-[color-mix(in_srgb,var(--system-orange)_25%,transparent)]" : "bg-[var(--fill-tertiary)]",
        )}
      >
        {count}
      </span>
    </Link>
  )
}
