/**
 * Cuttlefish Talk — ConversationStream model (Task 9).
 *
 * A persistent, scrollable conversation replaces the old single-exchange
 * transcript + hidden history rail. This module is the pure reducer behind it
 * plus a thin `useConversation` hook of stable action creators.
 *
 * Row model:
 *   - user   — one spoken/typed line (optionally `pending` while STT finalizes).
 *   - aura   — ONE row per assistant turn that ACCUMULATES every sentence; the
 *              spoken sentence (`liveIdx`) is the karaoke head. `partial` is true
 *              while the turn streams/speaks, false once finalized.
 *   - system — a delegation chip (delegated / reported / attached / detached /
 *              error / info) that narrates what just happened. A new chip is
 *              inserted BEFORE the in-progress aura row so it reads in causal
 *              order ("…I'll delegate" → ⟶ delegated → child → narration).
 *
 * Sentence splitting reuses `splitSentences` (use-speak) verbatim so the stream
 * segments text exactly like the spoken pass — one source of truth.
 */
import { useCallback, useMemo, useReducer, useRef } from "react"
import { splitSentences } from "./use-speak"
import type { TranscriptEntry, SystemEntry } from "./types"

export type StreamRow =
  | { kind: "user"; id: string; text: string; pending?: boolean }
  | { kind: "aura"; id: string; sentences: string[]; liveIdx: number | null; partial: boolean }
  | {
      kind: "system"
      id: string
      event: "delegated" | "reported" | "attached" | "detached" | "error" | "info"
      threadId?: string
      label: string
      hue?: number
      ts: number
    }

export type SystemEvent = Extract<StreamRow, { kind: "system" }>["event"]

/** Hard cap on retained rows — the stream is bottom-anchored, old rows age out. */
export const MAX_ROWS = 200

export type ConversationAction =
  | { type: "user"; id: string; text: string; pending?: boolean }
  /** Live-update a (pending) user row's text without clearing `pending`. */
  | { type: "updateUser"; id: string; text: string }
  /** Drop a user row entirely (pending row removed on cancel/abort/error). */
  | { type: "removeUser"; id: string }
  | { type: "finalizeUser"; id: string; text?: string }
  /** `text` is the FULL accumulated, markdown-stripped reply text for the turn. */
  | { type: "assistant"; id: string; text: string }
  | { type: "markSpoken"; id: string; idx: number }
  | { type: "finalizeAssistant"; id: string }
  | {
      type: "system"
      id: string
      event: SystemEvent
      label: string
      threadId?: string
      hue?: number
      ts?: number
    }
  | { type: "rehydrate"; entries: Array<TranscriptEntry | SystemEntry> }
  | { type: "reset" }

/** Keep at most MAX_ROWS, dropping the oldest (front of the list). */
function cap(rows: StreamRow[]): StreamRow[] {
  return rows.length > MAX_ROWS ? rows.slice(rows.length - MAX_ROWS) : rows
}

/** Map a rehydrated (finalized) entry to a stream row. */
function entryToRow(e: TranscriptEntry | SystemEntry): StreamRow {
  if ("kind" in e && e.kind === "system") {
    return { kind: "system", id: e.id, event: e.event, label: e.label, ts: 0 }
  }
  const te = e as TranscriptEntry
  if (te.role === "user") return { kind: "user", id: te.id, text: te.text }
  return {
    kind: "aura",
    id: te.id,
    sentences: splitSentences(te.full ?? te.text),
    liveIdx: null,
    partial: false,
  }
}

export function conversationReducer(
  rows: StreamRow[],
  action: ConversationAction,
): StreamRow[] {
  switch (action.type) {
    case "user":
      return cap([...rows, { kind: "user", id: action.id, text: action.text, ...(action.pending ? { pending: true } : {}) }])

    case "updateUser": {
      const i = rows.findIndex((r) => r.id === action.id && r.kind === "user")
      if (i === -1) return rows
      const prev = rows[i] as Extract<StreamRow, { kind: "user" }>
      if (prev.text === action.text) return rows
      const next = rows.slice()
      next[i] = { ...prev, text: action.text }
      return next
    }

    case "removeUser": {
      const i = rows.findIndex((r) => r.id === action.id && r.kind === "user")
      if (i === -1) return rows
      return [...rows.slice(0, i), ...rows.slice(i + 1)]
    }

    case "finalizeUser": {
      const i = rows.findIndex((r) => r.id === action.id && r.kind === "user")
      if (i === -1) return rows
      const next = rows.slice()
      const prev = next[i] as Extract<StreamRow, { kind: "user" }>
      next[i] = { kind: "user", id: prev.id, text: action.text ?? prev.text }
      return next
    }

    case "assistant": {
      const sentences = splitSentences(action.text)
      const i = rows.findIndex((r) => r.id === action.id && r.kind === "aura")
      if (i === -1) {
        return cap([...rows, { kind: "aura", id: action.id, sentences, liveIdx: null, partial: true }])
      }
      const next = rows.slice()
      const prev = next[i] as Extract<StreamRow, { kind: "aura" }>
      next[i] = { ...prev, sentences, partial: true }
      return next
    }

    case "markSpoken": {
      const i = rows.findIndex((r) => r.id === action.id && r.kind === "aura")
      if (i === -1) return rows
      const next = rows.slice()
      const prev = next[i] as Extract<StreamRow, { kind: "aura" }>
      if (prev.liveIdx === action.idx) return rows
      next[i] = { ...prev, liveIdx: action.idx }
      return next
    }

    case "finalizeAssistant": {
      const i = rows.findIndex((r) => r.id === action.id && r.kind === "aura")
      if (i === -1) return rows
      const next = rows.slice()
      const prev = next[i] as Extract<StreamRow, { kind: "aura" }>
      next[i] = { ...prev, partial: false, liveIdx: null }
      return next
    }

    case "system": {
      if (rows.some((r) => r.id === action.id)) return rows
      const chip: StreamRow = {
        kind: "system",
        id: action.id,
        event: action.event,
        label: action.label,
        ts: action.ts ?? Date.now(),
        ...(action.threadId ? { threadId: action.threadId } : {}),
        ...(action.hue != null ? { hue: action.hue } : {}),
      }
      // A chip narrates what just happened, so it belongs BEFORE the reply that
      // is still streaming. Insert ahead of the in-progress (partial) aura row;
      // otherwise append at the end.
      const partialIdx = rows.findIndex((r) => r.kind === "aura" && r.partial)
      if (partialIdx === -1) return cap([...rows, chip])
      const next = rows.slice()
      next.splice(partialIdx, 0, chip)
      return cap(next)
    }

    case "rehydrate":
      return cap(action.entries.map(entryToRow))

    case "reset":
      return []
  }
}

// ============================================================================
// Card anchoring (Task 11).
//
// Inline cards live in the conversation stream anchored to the turn that pushed
// them. We DON'T change StreamRow's shape — instead a side map `CardAnchors`
// records cardId → rowId. The map is the single source of truth for "which row
// does this card hang under"; the component looks it up at render time.
//
// Anchor target = the most recent aura/system row AT PUSH TIME. Trailing user
// rows are skipped so a card always belongs to the in-progress (or just-ended)
// assistant turn — even a partial aura row. An empty/user-only stream yields no
// anchor, which renders the card at the end of the stream.
// ============================================================================

/** cardId → the stream row id the card is anchored under. */
export type CardAnchors = Record<string, string>

export type AnchorAction =
  /** Anchor a freshly-pushed card to the latest aura/system row in `rows`. */
  | { type: "anchorCard"; cardId: string; rows: StreamRow[] }
  /** Drop one card's anchor (the card was dismissed). */
  | { type: "unanchorCard"; cardId: string }
  /** Keep only anchors whose card is still live (eviction/clear cleanup). */
  | { type: "pruneAnchors"; liveCardIds: string[] }

/**
 * The row a freshly-pushed card anchors to: the most recent aura OR system row,
 * scanning from the live edge. Returns null when there is none (empty or
 * user-only stream) → the card renders at the end of the stream.
 */
export function anchorRowId(rows: StreamRow[]): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]
    if (r.kind === "aura" || r.kind === "system") return r.id
  }
  return null
}

/** Pure transitions on the cardId → rowId anchor map. */
export function anchorsReducer(anchors: CardAnchors, action: AnchorAction): CardAnchors {
  switch (action.type) {
    case "anchorCard": {
      // An update (same id re-pushed) keeps its ORIGINAL anchor.
      if (anchors[action.cardId] != null) return anchors
      const rowId = anchorRowId(action.rows)
      if (rowId == null) return anchors // no anchor → render at end
      return { ...anchors, [action.cardId]: rowId }
    }
    case "unanchorCard": {
      if (anchors[action.cardId] == null) return anchors
      const { [action.cardId]: _drop, ...rest } = anchors
      return rest
    }
    case "pruneAnchors": {
      const live = new Set(action.liveCardIds)
      const next: CardAnchors = {}
      let changed = false
      for (const [cid, rid] of Object.entries(anchors)) {
        if (live.has(cid)) next[cid] = rid
        else changed = true
      }
      return changed ? next : anchors
    }
  }
}

/**
 * Resolve a card's anchor against the CURRENT rows. Returns the anchored row id
 * only if that row still exists; otherwise null. Null means "render at end" —
 * either the card was never anchored, or its anchor row aged out of the stream
 * (the 200-row cap). We fall back to end-render rather than dropping the card,
 * since cards carry their own MAX_CARDS lifecycle.
 */
export function resolveCardAnchor(
  anchors: CardAnchors,
  rows: StreamRow[],
  cardId: string,
): string | null {
  const rowId = anchors[cardId]
  if (rowId == null) return null
  return rows.some((r) => r.id === rowId) ? rowId : null
}

export interface UseConversationReturn {
  rows: StreamRow[]
  /** Add a user line (typed/STT). `pending` keeps it editable until finalized. */
  appendUser: (id: string, text: string, pending?: boolean) => void
  /** Live-update a pending user line's text (e.g. STT interim partials). */
  updatePendingUser: (id: string, text: string) => void
  /** Remove a pending user line (STT cancel/abort/error). */
  removePendingUser: (id: string) => void
  /** Finalize a pending user line (optionally replacing its text). */
  finalizeUser: (id: string, text?: string) => void
  /** Stream assistant text: pass the FULL accumulated, stripped reply text. */
  appendAssistant: (id: string, text: string) => void
  /** Advance the karaoke head to a spoken sentence index. */
  markSpoken: (id: string, idx: number) => void
  /** End the turn: stop highlighting, settle the row to history. */
  finalizeAssistant: (id: string) => void
  /** Insert a delegation chip (before the in-progress aura row if any). */
  addSystem: (chip: {
    id: string
    event: SystemEvent
    label: string
    threadId?: string
    hue?: number
    ts?: number
  }) => void
  /** Seed the stream from a server snapshot (replaces current rows). */
  rehydrate: (entries: Array<TranscriptEntry | SystemEntry>) => void
  /** Available for future use — engine switch currently preserves the conversation intentionally, matching the old entries behavior. */
  reset: () => void
  // ---- Card anchoring (Task 11) -------------------------------------------
  /** The live cardId → rowId anchor map. */
  anchors: CardAnchors
  /** Anchor a freshly-pushed card to the current live edge (no-op on re-push). */
  anchorCard: (cardId: string) => void
  /** Drop a dismissed card's anchor. */
  unanchorCard: (cardId: string) => void
  /** Keep only anchors whose card is still in the live set (eviction/clear). */
  pruneAnchors: (liveCardIds: string[]) => void
  /** Resolve a card's anchor against the current rows (null → render at end). */
  cardAnchorFor: (cardId: string) => string | null
}

export function useConversation(): UseConversationReturn {
  const [rows, dispatch] = useReducer(conversationReducer, [])
  const [anchors, dispatchAnchor] = useReducer(anchorsReducer, {} as CardAnchors)

  // Live mirror of rows so anchorCard captures the stream at the exact moment a
  // talk:card event fires (push time), independent of render timing.
  const rowsRef = useRef<StreamRow[]>(rows)
  rowsRef.current = rows

  const appendUser = useCallback(
    (id: string, text: string, pending?: boolean) => dispatch({ type: "user", id, text, pending }),
    [],
  )
  const updatePendingUser = useCallback(
    (id: string, text: string) => dispatch({ type: "updateUser", id, text }),
    [],
  )
  const removePendingUser = useCallback(
    (id: string) => dispatch({ type: "removeUser", id }),
    [],
  )
  const finalizeUser = useCallback(
    (id: string, text?: string) => dispatch({ type: "finalizeUser", id, text }),
    [],
  )
  const appendAssistant = useCallback(
    (id: string, text: string) => dispatch({ type: "assistant", id, text }),
    [],
  )
  const markSpoken = useCallback(
    (id: string, idx: number) => dispatch({ type: "markSpoken", id, idx }),
    [],
  )
  const finalizeAssistant = useCallback(
    (id: string) => dispatch({ type: "finalizeAssistant", id }),
    [],
  )
  const addSystem = useCallback<UseConversationReturn["addSystem"]>(
    (chip) => dispatch({ type: "system", ...chip }),
    [],
  )
  const rehydrate = useCallback(
    (entries: Array<TranscriptEntry | SystemEntry>) => dispatch({ type: "rehydrate", entries }),
    [],
  )
  const reset = useCallback(() => dispatch({ type: "reset" }), [])

  const anchorCard = useCallback(
    (cardId: string) => dispatchAnchor({ type: "anchorCard", cardId, rows: rowsRef.current }),
    [],
  )
  const unanchorCard = useCallback(
    (cardId: string) => dispatchAnchor({ type: "unanchorCard", cardId }),
    [],
  )
  const pruneAnchors = useCallback(
    (liveCardIds: string[]) => dispatchAnchor({ type: "pruneAnchors", liveCardIds }),
    [],
  )
  const cardAnchorFor = useCallback(
    (cardId: string) => resolveCardAnchor(anchors, rowsRef.current, cardId),
    [anchors],
  )

  return useMemo(
    () => ({
      rows,
      appendUser,
      updatePendingUser,
      removePendingUser,
      finalizeUser,
      appendAssistant,
      markSpoken,
      finalizeAssistant,
      addSystem,
      rehydrate,
      reset,
      anchors,
      anchorCard,
      unanchorCard,
      pruneAnchors,
      cardAnchorFor,
    }),
    [rows, appendUser, updatePendingUser, removePendingUser, finalizeUser, appendAssistant, markSpoken, finalizeAssistant, addSystem, rehydrate, reset, anchors, anchorCard, unanchorCard, pruneAnchors, cardAnchorFor],
  )
}
