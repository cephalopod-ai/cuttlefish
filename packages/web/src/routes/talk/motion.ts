/**
 * Cuttlefish Talk — motion system (Concept AURA).
 *
 * Shared spring/easing tokens + transition primitives used by both the avatar
 * and the content cards. We deliberately avoid a heavy animation lib
 * (framer-motion): the Ledger theme already exposes spring/smooth/snappy
 * cubic-beziers as CSS vars, and a ~40-line rAF spring covers the one case CSS
 * can't (continuously chasing a moving numeric target — orb amplitude, ring
 * radius). Keep this file dependency-free apart from React.
 */
import { useEffect, useRef, useState } from "react"

// ---------------------------------------------------------------------------
// Easing — mirrors the CSS custom properties in globals.css so JS-driven and
// CSS-driven motion feel identical.
// ---------------------------------------------------------------------------
export const EASING = {
  /** Overshooting spring — playful Apple "pop". */
  spring: "cubic-bezier(0.34, 1.56, 0.64, 1)",
  /** Standard ease-in-out. */
  smooth: "cubic-bezier(0.4, 0, 0.2, 1)",
  /** Decisive snap, no overshoot. */
  snappy: "cubic-bezier(0.2, 0, 0, 1)",
} as const

/** Durations in ms, named by intent. */
export const DURATION = {
  fast: 180,
  base: 320,
  slow: 600,
  slower: 1100,
} as const

/** Build a CSS transition string for one or more properties. */
export function transition(
  props: string | string[],
  ms: number = DURATION.base,
  ease: keyof typeof EASING = "spring",
): string {
  const list = Array.isArray(props) ? props : [props]
  return list.map((p) => `${p} ${ms}ms ${EASING[ease]}`).join(", ")
}

// ---------------------------------------------------------------------------
// Spring presets for useSpringValue.
// ---------------------------------------------------------------------------
export interface SpringConfig {
  /** Pull toward target. Higher = faster. */
  stiffness: number
  /** Resistance. Lower = bouncier. */
  damping: number
  /** Inertia. Higher = heavier. */
  mass: number
}

export const SPRING_PRESETS = {
  /** Slow, organic — orb breathing / glow. */
  gentle: { stiffness: 60, damping: 18, mass: 1 },
  /** Quick and crisp — state pills, UI chrome. */
  snappy: { stiffness: 210, damping: 26, mass: 1 },
  /** Overshooting — card pops, hero numbers. */
  bouncy: { stiffness: 180, damping: 12, mass: 1 },
  /** Tight tracking for audio-reactive values. */
  reactive: { stiffness: 320, damping: 30, mass: 0.8 },
  /** Overdamped hero↔dock morph — decisive, no bounce (the "one mover"). */
  stage: { stiffness: 170, damping: 26, mass: 1 },
} as const satisfies Record<string, SpringConfig>

/**
 * Spring-animate a numeric value toward `target` using a rAF integrator.
 * Returns the current animated value. Ideal for continuously-changing targets
 * (orb amplitude, ring radius) where a CSS transition would constantly restart.
 *
 * Honours prefers-reduced-motion by snapping to target.
 */
export function useSpringValue(
  target: number,
  config: SpringConfig = SPRING_PRESETS.gentle,
): number {
  const [value, setValue] = useState(target)
  const valueRef = useRef(target)
  const velocityRef = useRef(0)
  const targetRef = useRef(target)
  const rafRef = useRef<number | null>(null)
  const lastRef = useRef<number | null>(null)
  const configRef = useRef(config)
  configRef.current = config
  targetRef.current = target

  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    if (reduce) {
      valueRef.current = target
      velocityRef.current = 0
      setValue(target)
      return
    }

    const step = (now: number) => {
      const last = lastRef.current ?? now
      // Clamp dt so a backgrounded tab doesn't explode the integrator.
      const dt = Math.min((now - last) / 1000, 1 / 30)
      lastRef.current = now

      const { stiffness, damping, mass } = configRef.current
      const x = valueRef.current
      const v = velocityRef.current
      const tgt = targetRef.current

      const springForce = -stiffness * (x - tgt)
      const dampingForce = -damping * v
      const accel = (springForce + dampingForce) / mass

      const nextV = v + accel * dt
      const nextX = x + nextV * dt

      valueRef.current = nextX
      velocityRef.current = nextV
      setValue(nextX)

      // Settle: close enough and slow enough → snap and idle the loop.
      if (Math.abs(nextX - tgt) < 0.0005 && Math.abs(nextV) < 0.0005) {
        valueRef.current = tgt
        velocityRef.current = 0
        setValue(tgt)
        rafRef.current = null
        lastRef.current = null
        return
      }
      rafRef.current = requestAnimationFrame(step)
    }

    if (rafRef.current == null) {
      lastRef.current = null
      rafRef.current = requestAnimationFrame(step)
    }

    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      lastRef.current = null
    }
    // Re-arm the loop whenever the target changes.
  }, [target])

  return value
}

/** True when the user prefers reduced motion (SSR-safe). */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)")
    setReduced(mq.matches)
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches)
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [])
  return reduced
}
