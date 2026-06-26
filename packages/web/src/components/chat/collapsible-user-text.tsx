import { useEffect, useLayoutEffect, useRef, useState } from "react"
import type React from "react"

// Collapsed bubbles clamp to this rendered height. ~240px ≈ 9–10 lines of the
// user bubble's subheadline/relaxed type — long enough that short prompts and
// normal multi-line questions stay fully visible, short enough that a wall of
// pasted text earns a "Show more". SLACK ensures we only collapse when there's
// something worth revealing (≥ ~2 hidden lines), so the control never appears to
// hide a single clipped word.
export const USER_COLLAPSE_PX = 240
export const USER_COLLAPSE_SLACK = 40

/** Pure: should a user bubble of this full rendered height auto-collapse? */
export function shouldCollapse(
  fullHeight: number,
  threshold = USER_COLLAPSE_PX,
  slack = USER_COLLAPSE_SLACK,
): boolean {
  return fullHeight > threshold + slack
}

// Bottom-edge fade for the collapsed state. A mask (alpha, not color) fades the
// text into the bubble's own --accent-fill background, so it is theme-aware for
// free — no hardcoded rgba, works identically in dark and light.
const COLLAPSE_FADE_MASK =
  "linear-gradient(to bottom, #000 calc(100% - 44px), transparent 100%)"

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)")
    if (!mq) return
    setReduced(mq.matches)
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches)
    mq.addEventListener("change", handler)
    return () => mq.removeEventListener("change", handler)
  }, [])
  return reduced
}

// Wraps the user bubble's formatted content. Measures the rendered height; when
// it exceeds the threshold it clamps + fades the bottom edge and reveals a quiet
// "Show more / Show less" text control. Height animates via max-height + the
// smooth easing token; reduced-motion snaps with no animation.
export function CollapsibleUserText({ children }: { children: React.ReactNode }) {
  const contentRef = useRef<HTMLDivElement>(null)
  const [needsCollapse, setNeedsCollapse] = useState(false)
  const [collapsed, setCollapsed] = useState(true)
  const [fullHeight, setFullHeight] = useState(0)
  const reducedMotion = usePrefersReducedMotion()

  // scrollHeight reports the full content height regardless of the max-height
  // clamp, so measuring stays stable across collapse/expand (no feedback loop).
  useLayoutEffect(() => {
    const el = contentRef.current
    if (!el) return
    const measure = () => {
      const h = el.scrollHeight
      setFullHeight(h)
      setNeedsCollapse(shouldCollapse(h))
    }
    measure()
    let ro: ResizeObserver | undefined
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(measure)
      ro.observe(el)
    }
    return () => ro?.disconnect()
  }, [children])

  const clamped = needsCollapse && collapsed
  // +8px buffer absorbs sub-pixel/last-line rounding so expanded never clips.
  const maxHeight = !needsCollapse
    ? undefined
    : collapsed
      ? `${USER_COLLAPSE_PX}px`
      : `${fullHeight + 8}px`

  return (
    <>
      <div
        ref={contentRef}
        style={{
          maxHeight,
          overflow: needsCollapse ? "hidden" : undefined,
          transition:
            needsCollapse && !reducedMotion ? "max-height 320ms var(--ease-smooth)" : undefined,
          maskImage: clamped ? COLLAPSE_FADE_MASK : undefined,
          WebkitMaskImage: clamped ? COLLAPSE_FADE_MASK : undefined,
        }}
      >
        {children}
      </div>
      {needsCollapse && (
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          className="mt-[var(--space-1)] -ml-1.5 inline-flex items-center gap-1 rounded-[var(--radius-sm)] border-none bg-transparent py-0.5 px-1.5 text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-secondary)] cursor-pointer transition-colors duration-150 ease-[var(--ease-smooth)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]"
        >
          {collapsed ? "Show more" : "Show less"}
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`transition-transform duration-200 ease-[var(--ease-smooth)] opacity-70 ${collapsed ? "rotate-0" : "rotate-180"}`}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      )}
    </>
  )
}
