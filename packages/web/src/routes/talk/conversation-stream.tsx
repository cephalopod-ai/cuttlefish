/**
 * Cuttlefish Talk — ConversationStream (Task 9).
 *
 * The persistent conversation: every user line, every AURA reply (with a
 * karaoke highlight tracking the spoken sentence), and the delegation chips that
 * narrate what the orchestrator did. Replaces the old single-exchange transcript
 * AND the hidden history rail.
 *
 * Layout: the stream fills the `.talk-stage` grid cell (absolute inset:0 — the
 * grid allocates the space, so banner/cards/input growth reflows it instead of
 * overlapping). The positioning wrapper is pointer-events:none; the interactive
 * children (the scroll viewport, links, chips, the jump pill) re-enable
 * pointer-events on themselves. Auto-scrolls to the live edge unless the user
 * scrolls up, in which case a "jump to live" pill appears.
 *
 * Themed entirely from Ledger tokens (light + dark). Honors reduced motion.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import type { CSSProperties, JSX } from "react"
import type { AvatarState, Card } from "./types"
import type { StreamRow, SystemEvent } from "./use-conversation"
import type { GraphNode } from "./graph-store"
import type { ActivityMap } from "./thread-activity"
import type { DockSideMap } from "./work-dock-layout"
import { InlineCards } from "./cards/card-stack"
import { Linkified } from "./linkify"
import { ThreadCard } from "./thread-card"
import { EASING } from "./motion"
import "./conversation-stream.css"

export interface ConversationStreamProps {
  rows: StreamRow[]
  /**
   * Avatar state — exposed on the root as `data-state`. Currently a styling
   * hook with no CSS consumers (the idle-dim rule was removed); kept for
   * debugging and future state-targeted styling.
   */
  state: AvatarState
  /** Open a child session's chat (clicking a chip that carries a threadId). */
  onOpenThread?: (sessionId: string) => void
  /** Live delegation graph — drives the ThreadCards rendered for `delegated` rows. */
  graph?: GraphNode[]
  /** Per-node live activity / report excerpts (advisory overlay). */
  activity?: ActivityMap
  /** User side-state (rename overrides) so ThreadCards honor renames like the rail. */
  sideState?: DockSideMap
  /**
   * Inline cards (already filtered to NON-pinned cards) to render anchored under
   * the turn that pushed them. Blocking approval/choice cards are excluded here
   * — they live in the pinned bottom strip until resolved.
   */
  inlineCards?: Card[]
  /** Resolve a card's anchor to a row id (null → render in the end bucket). */
  cardAnchorFor?: (cardId: string) => string | null
  /** Action channel for any interactive card rendered inline. */
  onCardAction?: (message: string) => void
}

const EASE_VARS: CSSProperties = {
  ["--ease-spring" as string]: EASING.spring,
  ["--ease-smooth" as string]: EASING.smooth,
}

/**
 * Reveal a sentence word-by-word with a blur-in (ported from the old
 * transcript). Keyed by the parent on a stable id so only newly-arrived words
 * mount/animate; already-revealed words stay settled.
 */
function WordReveal({ text }: { text: string }) {
  const words = useMemo(() => text.split(/\s+/).filter(Boolean), [text])
  return (
    <>
      {words.map((word, i) => (
        // The trailing space MUST be a sibling text node: the word span is
        // inline-block and browsers trim whitespace inside an inline-block box.
        // eslint-disable-next-line react/no-array-index-key
        <span key={i}>
          <span className="cstream__word">{word}</span>
          {i < words.length - 1 ? " " : ""}
        </span>
      ))}
    </>
  )
}

/** Phrasing + glyph for each delegation-chip event. */
function chipContent(event: SystemEvent, label: string): { glyph: string; text: string } {
  switch (event) {
    case "delegated":
      return { glyph: "⟶", text: `delegated → ${label}` }
    case "reported":
      return { glyph: "⟵", text: `${label} reported back` }
    case "attached":
      return { glyph: "⇄", text: `attached to ${label}` }
    case "detached":
      return { glyph: "⇄", text: `detached from ${label}` }
    case "error":
      return { glyph: "⚠", text: label }
    case "info":
    default:
      return { glyph: "·", text: label }
  }
}

function SystemChip({
  row,
  onOpenThread,
}: {
  row: Extract<StreamRow, { kind: "system" }>
  onOpenThread?: (sessionId: string) => void
}) {
  const { glyph, text } = chipContent(row.event, row.label)
  const clickable = !!(row.threadId && onOpenThread)
  const dotStyle = row.hue != null ? ({ ["--chip-hue" as string]: String(row.hue) } as CSSProperties) : undefined
  return (
    <div className={`cstream__row cstream__row--system cstream__row--${row.event}`}>
      <button
        type="button"
        className="cstream__chip"
        data-clickable={clickable ? "true" : undefined}
        disabled={!clickable}
        onClick={clickable ? () => onOpenThread!(row.threadId!) : undefined}
      >
        <span className="cstream__chip-dot" style={dotStyle} aria-hidden="true" />
        <span className="cstream__chip-glyph" aria-hidden="true">
          {glyph}
        </span>
        <span className="cstream__chip-text">{text}</span>
      </button>
    </div>
  )
}

function AuraRow({ row }: { row: Extract<StreamRow, { kind: "aura" }> }) {
  // Finalized rows read as plain history (full opacity). While partial, the
  // spoken sentence (liveIdx) is the karaoke head; earlier sentences are settled
  // and later (streamed-ahead) sentences are dimmed. liveIdx null while partial
  // → nothing spoken yet → treat all as streamed-ahead.
  const head = row.partial ? (row.liveIdx ?? -1) : Number.MAX_SAFE_INTEGER
  return (
    <div className="cstream__row cstream__row--aura">
      <span className="cstream__eyebrow cstream__eyebrow--aura">AURA</span>
      <p className="cstream__reply">
        {row.sentences.map((sentence, i) => {
          const cls =
            !row.partial || i < head
              ? "cstream__sentence cstream__sentence--spoken"
              : i === head
                ? "cstream__sentence cstream__sentence--live"
                : "cstream__sentence cstream__sentence--ahead"
          return (
            // eslint-disable-next-line react/no-array-index-key
            <span key={i} className={cls}>
              {i === head && row.partial ? <WordReveal text={sentence} /> : <Linkified text={sentence} />}
              {i < row.sentences.length - 1 ? " " : ""}
            </span>
          )
        })}
        {row.partial ? <span className="cstream__cursor" aria-hidden="true" /> : null}
      </p>
    </div>
  )
}

function UserRow({ row }: { row: Extract<StreamRow, { kind: "user" }> }) {
  return (
    <div className={`cstream__row cstream__row--user${row.pending ? " cstream__row--pending" : ""}`}>
      <span className="cstream__eyebrow cstream__eyebrow--user">you</span>
      <p className="cstream__caption">
        <Linkified text={row.text} />
      </p>
    </div>
  )
}

export function ConversationStream({
  rows,
  state,
  onOpenThread,
  graph,
  activity,
  sideState,
  inlineCards,
  cardAnchorFor,
  onCardAction,
}: ConversationStreamProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const endRef = useRef<HTMLDivElement | null>(null)
  // Pinned to the live edge unless the user scrolls up. A scroll listener flips
  // `pinned`; while pinned, new rows keep the view glued to the bottom.
  const [pinned, setPinned] = useState(true)

  // Group inline cards by their anchored row id. Cards whose anchor doesn't
  // resolve (never anchored, or the row aged out of the 200-row cap) fall into
  // the end bucket so they still render at the live edge.
  const { byRow, endBucket } = useMemo(() => {
    const byRow = new Map<string, Card[]>()
    const endBucket: Card[] = []
    for (const card of inlineCards ?? []) {
      const rowId = cardAnchorFor?.(card.id) ?? null
      if (rowId == null) {
        endBucket.push(card)
        continue
      }
      const list = byRow.get(rowId)
      if (list) list.push(card)
      else byRow.set(rowId, [card])
    }
    return { byRow, endBucket }
    // `rows` is a dep so anchors re-resolve when a row ages out of the 200-row
    // cap: cardAnchorFor then returns null for the dropped row and the card falls
    // into the end bucket instead of vanishing with its (unrendered) row.
  }, [inlineCards, cardAnchorFor, rows])

  useEffect(() => {
    if (pinned) endRef.current?.scrollIntoView({ block: "end" })
  }, [rows, inlineCards, pinned])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    setPinned(dist < 48)
  }

  const jumpToLive = () => {
    setPinned(true)
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" })
  }

  return (
    <div className="cstream" data-state={state} style={EASE_VARS}>
      <div
        ref={scrollRef}
        className="cstream__scroll"
        onScroll={onScroll}
        role="log"
        aria-label="Conversation"
        aria-live="polite"
      >
        {rows.map((row) => {
          const anchored = byRow.get(row.id)
          return (
            <div key={row.id} className="cstream__group">
              {row.kind === "user" ? (
                <UserRow row={row} />
              ) : row.kind === "aura" ? (
                <AuraRow row={row} />
              ) : row.event === "delegated" && row.threadId ? (
                <div className="cstream__row cstream__row--thread">
                  <ThreadCard
                    threadId={row.threadId}
                    graph={graph ?? []}
                    activity={activity ?? new Map()}
                    fallbackLabel={row.label}
                    hue={row.hue}
                    sideState={sideState}
                    onOpenThread={onOpenThread}
                  />
                </div>
              ) : (
                <SystemChip row={row} onOpenThread={onOpenThread} />
              )}
              {anchored && anchored.length > 0 ? (
                <InlineCards cards={anchored} onAction={onCardAction} />
              ) : null}
            </div>
          )
        })}
        {endBucket.length > 0 ? <InlineCards cards={endBucket} onAction={onCardAction} /> : null}
        <div ref={endRef} />
      </div>

      {!pinned && (
        <button type="button" className="cstream__jump" onClick={jumpToLive}>
          Jump to live ↓
        </button>
      )}
    </div>
  )
}
