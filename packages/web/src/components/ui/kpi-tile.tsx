import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { ArrowRight } from "lucide-react"
import { cn } from "@/lib/utils"

interface KpiTileProps {
  title: string
  value: string
  detail: string
  href: string
  icon: ReactNode
  /** Visually lifts the tile — reserve for the single most important metric on a page. */
  emphasized?: boolean
  className?: string
}

/**
 * A big-number metric card that deep-links to the surface it summarizes.
 * The shared KPI primitive for dashboard-style pages (see
 * docs/plans/2026-07-10-fleetview-ux-implementation-plan.md, Section 8) —
 * extracted from Command Center's original inline MetricCard so any future
 * dashboard reuses the same shape instead of re-inventing it.
 */
export function KpiTile({ title, value, detail, href, icon, emphasized, className }: KpiTileProps) {
  return (
    <Link
      to={href}
      className={cn(
        "group relative overflow-hidden rounded-[var(--radius-xl)] border p-4 shadow-[var(--shadow-card)] transition-transform duration-150 hover:-translate-y-0.5",
        emphasized
          ? "border-[color:color-mix(in_srgb,var(--accent)_55%,transparent)] bg-[color:color-mix(in_srgb,var(--accent-fill)_65%,var(--material-regular))]"
          : "border-[var(--separator)] bg-[var(--material-regular)]",
        className,
      )}
    >
      <div className="absolute inset-x-0 top-0 h-px bg-[color:color-mix(in_srgb,var(--text-primary)_22%,transparent)] opacity-70" />
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--text-tertiary)]">{title}</div>
        <div className={emphasized ? "text-[var(--accent)]" : "text-[var(--text-secondary)]"}>{icon}</div>
      </div>
      <div className="mb-1.5 flex items-end gap-2">
        <span
          className={
            emphasized
              ? "text-4xl font-bold tracking-[-0.04em] text-[var(--accent)]"
              : "text-4xl font-bold tracking-[-0.04em] text-[var(--text-primary)]"
          }
        >
          {value}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
        <span>{detail}</span>
        <ArrowRight size={14} className="opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
    </Link>
  )
}
