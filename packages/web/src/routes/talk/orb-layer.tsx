/**
 * Cuttlefish Talk — OrbLayer (stage redesign).
 *
 * ONE persistent orb that morphs between two measured anchors instead of
 * unmount/remount: the stage cell centre (hero) and the 56px dock anchor in the
 * orb-dock row (docked). x/y/size each chase their target with an overdamped
 * spring (motion.ts), so the morph is interruptible and honours
 * prefers-reduced-motion (useSpringValue snaps). Layout correctness never
 * depends on the animation: a missing anchor simply keeps the last target.
 *
 * While the dock row's height transition runs (mode change), anchors move
 * without resizing — ResizeObserver alone would miss it — so a short rAF
 * re-measure window chases the settling layout.
 *
 * Mount choreography: useSpringValue seeds its internal state from the FIRST
 * target it is called with and animates on every change after that. If the
 * springs lived in this component they'd be seeded with 0/0/DOCKED_ORB_SIZE on
 * the pre-measure render and then animate to the measured rect — a visible
 * fly-in from the top-left corner. So the springs live in OrbLayerInner, which
 * mounts only once the first measurement exists: its first useSpringValue call
 * already receives the measured values, and later target changes (mode flips,
 * resizes) animate as intended.
 */
import { useLayoutEffect, useState, type ComponentProps, type RefObject } from "react"
import { AuraAvatar } from "./aura-avatar"
import { SPRING_PRESETS, useSpringValue } from "./motion"
import { DOCKED_ORB_SIZE, heroOrbSize, type StageMode } from "./stage"

// Must cover the `--motion-hero` dock-row transition (500ms, talk-tokens.css)
// plus slack, so the rAF re-measure chase outlives the settling layout.
const SETTLE_WINDOW_MS = 700

interface OrbLayerProps {
  mode: StageMode
  state: ComponentProps<typeof AuraAvatar>["state"]
  level: number | undefined
  channelHue: number | undefined
  heroAnchorRef: RefObject<HTMLDivElement | null>
  dockAnchorRef: RefObject<HTMLDivElement | null>
}

interface OrbTarget {
  x: number
  y: number
  size: number
}

export function OrbLayer({ mode, state, level, channelHue, heroAnchorRef, dockAnchorRef }: OrbLayerProps) {
  const docked = mode !== "hero"
  const [target, setTarget] = useState<OrbTarget | null>(null)

  useLayoutEffect(() => {
    const measure = () => {
      const el = (docked ? dockAnchorRef : heroAnchorRef).current
      if (!el) return
      const r = el.getBoundingClientRect()
      const size = docked ? DOCKED_ORB_SIZE : heroOrbSize(r.width, r.height)
      const x = r.left + r.width / 2
      const y = r.top + r.height / 2
      // Keep the previous object when nothing moved so the rAF chase window
      // doesn't force a re-render per frame on a settled layout.
      setTarget((prev) =>
        prev && prev.x === x && prev.y === y && prev.size === size ? prev : { x, y, size },
      )
    }
    measure()
    // Chase the dock row's height transition (anchors translate w/o resizing).
    let raf = 0
    const started = performance.now()
    const chase = () => {
      measure()
      if (performance.now() - started < SETTLE_WINDOW_MS) raf = requestAnimationFrame(chase)
    }
    raf = requestAnimationFrame(chase)
    const ro = new ResizeObserver(measure)
    if (heroAnchorRef.current) ro.observe(heroAnchorRef.current)
    if (dockAnchorRef.current) ro.observe(dockAnchorRef.current)
    window.addEventListener("resize", measure)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [docked, heroAnchorRef, dockAnchorRef])

  // Nothing to show until the first measure; mounting the inner subtree only
  // now is what seeds the springs at the measured rect (see header comment).
  if (!target) return null
  return (
    <OrbLayerInner
      target={target}
      state={state}
      level={level}
      channelHue={channelHue}
      docked={docked}
    />
  )
}

interface OrbLayerInnerProps {
  target: OrbTarget
  state: ComponentProps<typeof AuraAvatar>["state"]
  level: number | undefined
  channelHue: number | undefined
  docked: boolean
}

function OrbLayerInner({ target, state, level, channelHue, docked }: OrbLayerInnerProps) {
  const x = useSpringValue(target.x, SPRING_PRESETS.stage)
  const y = useSpringValue(target.y, SPRING_PRESETS.stage)
  const size = useSpringValue(target.size, SPRING_PRESETS.stage)

  return (
    <div
      className="talk-orb-layer"
      style={{
        transform: `translate3d(${x - size / 2}px, ${y - size / 2}px, 0)`,
        width: Math.round(size),
        height: Math.round(size),
      }}
    >
      <AuraAvatar
        state={state}
        level={level}
        size={Math.round(size)}
        channelHue={channelHue}
        docked={docked}
      />
    </div>
  )
}
