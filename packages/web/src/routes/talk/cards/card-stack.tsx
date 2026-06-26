/**
 * Cuttlefish Talk — CardStack (Concept AURA).
 *
 * A horizontally-centered deck of glass cards that materialize next to the orb.
 * Owns the *presence* lifecycle the parent's `cards` prop only describes
 * declaratively:
 *
 *   - Entrance: each newly-seen card mounts with a springy entrance (translateY
 *     + scale-up + deblur), staggered by index (~70ms).
 *   - Exit: when a card id disappears from `cards`, it is kept mounted and
 *     plays a downward drift/fade exit, then removed from the DOM once the exit
 *     animation finishes.
 *
 * Honours prefers-reduced-motion (handled in cards.css: opacity-only fades).
 * The deck has pointer-events:none so it never blocks the page; interactive
 * cards (links) re-enable pointer-events on themselves.
 */
import {
  useEffect,
  useRef,
  useState,
  type AnimationEvent as ReactAnimationEvent,
  type CSSProperties,
  type JSX,
} from "react"
import type { Card } from "../types"
import { DURATION } from "../motion"
import { CardRenderer } from "./card-renderer"
import "./cards.css"

const STAGGER_MS = 70
const ENTER_MS = DURATION.slow // 600ms springy entrance
const EXIT_MS = DURATION.base // 320ms exit drift

type Phase = "entering" | "present" | "exiting"

interface TrackedCard {
  card: Card
  phase: Phase
  /** Index at mount time — drives entrance stagger. */
  enterIndex: number
}

/** Shell for one card: applies glass class, phase animation, and stagger. */
function CardShell({
  tracked,
  onExited,
  onAction,
}: {
  tracked: TrackedCard
  onExited: (id: string) => void
  onAction?: (message: string) => void
}): JSX.Element {
  const { card, phase, enterIndex } = tracked
  const isLink = card.type === "link"

  // Phase → animation class. "present" carries no animation so finished cards
  // stay put without re-triggering keyframes on re-render.
  const phaseClass =
    phase === "entering"
      ? "jt-card--entering"
      : phase === "exiting"
        ? "jt-card--exiting"
        : ""

  const style = {
    "--jt-stagger": `${enterIndex * STAGGER_MS}ms`,
    "--jt-in-ms": `${ENTER_MS}ms`,
    "--jt-out-ms": `${EXIT_MS}ms`,
  } as CSSProperties

  const className = `jt-card${isLink ? " jt-card--link" : ""} ${phaseClass}`.trim()

  const handleAnimationEnd = (e: ReactAnimationEvent) => {
    // Only react to the shell's own animation, not a child's.
    if (e.target !== e.currentTarget) return
    if (phase === "exiting") onExited(card.id)
  }

  if (isLink && card.type === "link") {
    return (
      <a
        className={className}
        style={style}
        href={card.url}
        target="_blank"
        rel="noopener noreferrer"
        onAnimationEnd={handleAnimationEnd}
      >
        <CardRenderer card={card} />
      </a>
    )
  }

  return (
    <div className={className} style={style} onAnimationEnd={handleAnimationEnd}>
      <CardRenderer card={card} onAction={onAction} />
    </div>
  )
}

// ============================================================================
// Inline vs pinned partition (Task 11).
//
// UX CHOICE: blocking cards (approval/choice) render ONLY in the pinned bottom
// strip while unresolved — they're always reachable/actionable without scrolling
// the transcript. Everything else renders INLINE, anchored to the turn that
// pushed it (its place in the conversation history). Once a blocking card is
// resolved (the user acted on it, or it was dismissed) it leaves the pinned
// strip; if it is still in the live `cards` array it then reads inline at its
// anchor as history. This avoids rendering the same actionable card twice.
// ============================================================================

/** Blocking = needs a human decision before the flow continues. */
export function isBlockingCard(card: Card): boolean {
  return card.type === "approval" || card.type === "choice"
}

/** Unresolved approval/choice cards — these pin to the bottom strip. */
export function selectPinnedCards(cards: Card[], resolvedIds: ReadonlySet<string>): Card[] {
  return cards.filter((c) => isBlockingCard(c) && !resolvedIds.has(c.id))
}

/** Everything that is NOT a currently-pinned (unresolved blocking) card. */
export function selectInlineCards(cards: Card[], resolvedIds: ReadonlySet<string>): Card[] {
  return cards.filter((c) => !(isBlockingCard(c) && !resolvedIds.has(c.id)))
}

/**
 * Inline card deck — rendered inside a stream row (or the end bucket), anchored
 * to the turn that pushed the cards. Left-aligned, in the scroll flow. Reuses
 * the same animated deck so entrance/exit stays consistent with the pinned strip.
 */
export function InlineCards({
  cards,
  onAction,
}: {
  cards: Card[]
  onAction?: (message: string) => void
}): JSX.Element | null {
  if (cards.length === 0) return null
  return <CardStack cards={cards} onAction={onAction} className="jt-deck--inline" />
}

/**
 * Pinned strip — the bottom band showing ONLY unresolved approval/choice cards.
 * Sits where the old full card stack used to live. Returns null when there is
 * nothing blocking, so the band collapses.
 *
 * Accepts the already-computed pinned cards array from the caller (no internal
 * selectPinnedCards call — single source of truth). The strip wrapper carries
 * a11y role/live attributes so screen readers announce new blocking decisions.
 */
export function PinnedCards({
  cards,
  onAction,
}: {
  /** Pre-filtered array of unresolved blocking cards (approval/choice only). */
  cards: Card[]
  onAction?: (message: string) => void
}): JSX.Element | null {
  if (cards.length === 0) return null
  return (
    <div role="region" aria-label="Pending decisions" aria-live="assertive">
      <CardStack cards={cards} onAction={onAction} className="jt-deck--pinned" />
    </div>
  )
}

export function CardStack({
  cards,
  className,
  onAction,
}: {
  cards: Card[]
  className?: string
  /** Action channel: a decision-card button sends this synthetic user message. */
  onAction?: (message: string) => void
}): JSX.Element {
  // The rendered set = incoming cards + cards still playing their exit.
  const [tracked, setTracked] = useState<TrackedCard[]>(() =>
    cards.map((card, i) => ({ card, phase: "entering", enterIndex: i })),
  )
  // Monotonic counter so cards entering in later waves still stagger sensibly
  // relative to their own wave rather than re-using stale indices.
  const waveBaseRef = useRef(0)

  useEffect(() => {
    setTracked((prev) => {
      const incomingIds = new Set(cards.map((c) => c.id))
      const prevById = new Map(prev.map((t) => [t.card.id, t]))

      // 1. New ids → fresh "entering" cards, staggered within this wave.
      const newCards = cards.filter((c) => !prevById.has(c.id))
      const waveBase = waveBaseRef.current
      const entering: TrackedCard[] = newCards.map((card, i) => ({
        card,
        phase: "entering",
        enterIndex: waveBase + i,
      }))
      if (newCards.length > 0) waveBaseRef.current = waveBase + newCards.length

      // 2. Existing ids → keep, refresh card data, promote entering→present is
      //    handled by the settle effect; just update the card payload here.
      const kept: TrackedCard[] = prev
        .filter((t) => incomingIds.has(t.card.id))
        .map((t) => {
          const fresh = cards.find((c) => c.id === t.card.id)
          return fresh ? { ...t, card: fresh } : t
        })

      // 3. Ids that left → flip to "exiting" (kept mounted to animate out).
      const exiting: TrackedCard[] = prev
        .filter((t) => !incomingIds.has(t.card.id) && t.phase !== "exiting")
        .map((t) => ({ ...t, phase: "exiting" as const }))

      // Already-exiting cards that are still leaving stay as-is.
      const stillExiting = prev.filter(
        (t) => !incomingIds.has(t.card.id) && t.phase === "exiting",
      )

      // Preserve incoming order for kept+entering; append exiting at the end so
      // they drift out from where they were without reflowing the live deck.
      const liveOrdered: TrackedCard[] = cards.map((c) => {
        const k = kept.find((t) => t.card.id === c.id)
        if (k) return k
        return entering.find((t) => t.card.id === c.id) as TrackedCard
      })

      return [...liveOrdered, ...exiting, ...stillExiting]
    })
  }, [cards])

  // Settle entrances → "present" after the entrance animation (incl. stagger)
  // so a later re-render doesn't replay the pop.
  useEffect(() => {
    const hasEntering = tracked.some((t) => t.phase === "entering")
    if (!hasEntering) return
    const maxStagger =
      Math.max(0, ...tracked.map((t) => t.enterIndex)) * STAGGER_MS
    const timer = window.setTimeout(
      () => {
        setTracked((prev) =>
          prev.map((t) =>
            t.phase === "entering" ? { ...t, phase: "present" } : t,
          ),
        )
      },
      ENTER_MS + maxStagger + 60,
    )
    return () => window.clearTimeout(timer)
  }, [tracked])

  const handleExited = (id: string) => {
    setTracked((prev) => prev.filter((t) => t.card.id !== id))
  }

  const deckClass = className ? `jt-deck ${className}` : "jt-deck"

  return (
    <div className={deckClass}>
      {tracked.map((t) => (
        <CardShell key={t.card.id} tracked={t} onExited={handleExited} onAction={onAction} />
      ))}
    </div>
  )
}
