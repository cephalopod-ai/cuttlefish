/**
 * Cuttlefish Talk — ConversationStream reducer (Task 9).
 *
 * The reducer is the persistent conversation model: user lines, a per-turn AURA
 * row that accumulates every sentence (karaoke), and system delegation chips.
 * Pure (no React/DOM) so every contract bullet is unit-tested here.
 */
import { describe, it, expect } from "vitest"
import {
  conversationReducer,
  MAX_ROWS,
  anchorRowId,
  anchorsReducer,
  resolveCardAnchor,
  type StreamRow,
  type CardAnchors,
} from "../use-conversation"
import type { TranscriptEntry, SystemEntry } from "../types"

function auraRow(rows: StreamRow[], id: string) {
  const r = rows.find((x) => x.id === id)
  if (r && r.kind === "aura") return r
  throw new Error(`no aura row ${id}`)
}

describe("conversationReducer — user rows", () => {
  it("appends a user row", () => {
    const rows = conversationReducer([], { type: "user", id: "u1", text: "hello" })
    expect(rows).toEqual([{ kind: "user", id: "u1", text: "hello" }])
  })

  it("appends a pending user row then finalizes/replaces it", () => {
    let rows = conversationReducer([], { type: "user", id: "u1", text: "hel", pending: true })
    expect(rows[0]).toEqual({ kind: "user", id: "u1", text: "hel", pending: true })
    rows = conversationReducer(rows, { type: "finalizeUser", id: "u1", text: "hello there" })
    expect(rows).toEqual([{ kind: "user", id: "u1", text: "hello there" }])
  })

  it("finalizeUser keeps existing text when no override is given", () => {
    let rows = conversationReducer([], { type: "user", id: "u1", text: "draft", pending: true })
    rows = conversationReducer(rows, { type: "finalizeUser", id: "u1" })
    expect(rows).toEqual([{ kind: "user", id: "u1", text: "draft" }])
  })

  it("updateUser live-updates a pending row's text WITHOUT clearing pending", () => {
    let rows = conversationReducer([], { type: "user", id: "u1", text: "…", pending: true })
    rows = conversationReducer(rows, { type: "updateUser", id: "u1", text: "hello wor" })
    expect(rows[0]).toEqual({ kind: "user", id: "u1", text: "hello wor", pending: true })
    rows = conversationReducer(rows, { type: "updateUser", id: "u1", text: "hello world" })
    expect(rows[0]).toEqual({ kind: "user", id: "u1", text: "hello world", pending: true })
  })

  it("updateUser returns the same reference when text is unchanged (stable for React)", () => {
    const rows = conversationReducer([], { type: "user", id: "u1", text: "x", pending: true })
    expect(conversationReducer(rows, { type: "updateUser", id: "u1", text: "x" })).toBe(rows)
  })

  it("updateUser on an unknown id is a no-op", () => {
    const rows: StreamRow[] = [{ kind: "user", id: "u1", text: "x" }]
    expect(conversationReducer(rows, { type: "updateUser", id: "ghost", text: "y" })).toBe(rows)
  })

  it("removeUser drops a pending row (cancel/abort/error)", () => {
    let rows = conversationReducer([], { type: "user", id: "u1", text: "keep" })
    rows = conversationReducer(rows, { type: "user", id: "u2", text: "…", pending: true })
    rows = conversationReducer(rows, { type: "removeUser", id: "u2" })
    expect(rows).toEqual([{ kind: "user", id: "u1", text: "keep" }])
  })

  it("removeUser on an unknown id is a no-op (same reference)", () => {
    const rows: StreamRow[] = [{ kind: "user", id: "u1", text: "x" }]
    expect(conversationReducer(rows, { type: "removeUser", id: "ghost" })).toBe(rows)
  })

  it("pending lifecycle: add → live-update → finalize replaces the placeholder", () => {
    let rows = conversationReducer([], { type: "user", id: "u1", text: "…", pending: true })
    rows = conversationReducer(rows, { type: "updateUser", id: "u1", text: "partial" })
    rows = conversationReducer(rows, { type: "finalizeUser", id: "u1", text: "the final words" })
    expect(rows).toEqual([{ kind: "user", id: "u1", text: "the final words" }])
  })
})

describe("conversationReducer — assistant streaming", () => {
  it("accumulates ALL sentences into ONE aura row per turn (partial)", () => {
    let rows = conversationReducer([], { type: "assistant", id: "a1", text: "First sentence." })
    rows = conversationReducer(rows, {
      type: "assistant",
      id: "a1",
      text: "First sentence. Second one!",
    })
    expect(rows).toHaveLength(1)
    expect(auraRow(rows, "a1")).toEqual({
      kind: "aura",
      id: "a1",
      sentences: ["First sentence.", "Second one!"],
      liveIdx: null,
      partial: true,
    })
  })

  it("markSpoken moves liveIdx on the aura row", () => {
    let rows = conversationReducer([], {
      type: "assistant",
      id: "a1",
      text: "One. Two. Three.",
    })
    rows = conversationReducer(rows, { type: "markSpoken", id: "a1", idx: 1 })
    expect(auraRow(rows, "a1").liveIdx).toBe(1)
  })

  it("finalizeAssistant clears partial + liveIdx", () => {
    let rows = conversationReducer([], { type: "assistant", id: "a1", text: "Done now." })
    rows = conversationReducer(rows, { type: "markSpoken", id: "a1", idx: 0 })
    rows = conversationReducer(rows, { type: "finalizeAssistant", id: "a1" })
    expect(auraRow(rows, "a1")).toMatchObject({ partial: false, liveIdx: null })
  })

  it("markSpoken/finalize on an unknown id is a no-op", () => {
    const rows = conversationReducer([], { type: "markSpoken", id: "ghost", idx: 2 })
    expect(rows).toEqual([])
  })
})

describe("conversationReducer — system chips", () => {
  it("appends a system chip when no aura row is in progress", () => {
    const rows = conversationReducer([{ kind: "user", id: "u1", text: "hi" }], {
      type: "system",
      id: "s1",
      event: "delegated",
      label: "content-lead",
      threadId: "c1",
      hue: 120,
      ts: 5,
    })
    expect(rows[1]).toEqual({
      kind: "system",
      id: "s1",
      event: "delegated",
      label: "content-lead",
      threadId: "c1",
      hue: 120,
      ts: 5,
    })
  })

  it("inserts the chip BEFORE the in-progress (partial) aura row", () => {
    let rows: StreamRow[] = [{ kind: "user", id: "u1", text: "hi" }]
    rows = conversationReducer(rows, { type: "assistant", id: "a1", text: "I'll delegate this." })
    rows = conversationReducer(rows, {
      type: "system",
      id: "s1",
      event: "delegated",
      label: "content-lead",
      ts: 9,
    })
    // order: user, system chip, partial aura
    expect(rows.map((r) => r.kind)).toEqual(["user", "system", "aura"])
    expect(rows[1].id).toBe("s1")
    expect(rows[2].id).toBe("a1")
  })

  it("deduplicates chips with the same id (second dispatch is a no-op)", () => {
    const chip = { type: "system" as const, id: "s1", event: "delegated" as const, label: "content-lead", ts: 1 }
    let rows = conversationReducer([], chip)
    rows = conversationReducer(rows, chip)
    expect(rows.filter((r) => r.id === "s1")).toHaveLength(1)
  })

  it("appends the chip after a FINALIZED aura row (not in progress)", () => {
    let rows = conversationReducer([], { type: "assistant", id: "a1", text: "Done." })
    rows = conversationReducer(rows, { type: "finalizeAssistant", id: "a1" })
    rows = conversationReducer(rows, {
      type: "system",
      id: "s1",
      event: "reported",
      label: "content-lead",
      ts: 9,
    })
    expect(rows.map((r) => r.kind)).toEqual(["aura", "system"])
  })
})

describe("conversationReducer — cap", () => {
  it("caps total rows at MAX_ROWS, dropping the oldest", () => {
    let rows: StreamRow[] = []
    for (let i = 0; i < MAX_ROWS + 25; i++) {
      rows = conversationReducer(rows, { type: "user", id: `u${i}`, text: `m${i}` })
    }
    expect(rows).toHaveLength(MAX_ROWS)
    expect(rows[0].id).toBe("u25") // oldest 25 dropped
    expect(rows[rows.length - 1].id).toBe(`u${MAX_ROWS + 24}`)
  })
})

describe("conversationReducer — rehydrate", () => {
  it("seeds the stream from mapped transcript + system entries", () => {
    const entries: Array<TranscriptEntry | SystemEntry> = [
      { id: "u1", role: "user", text: "hello", partial: false, full: "hello" },
      { id: "n1", kind: "system", event: "reported", label: "Content draft" },
      {
        id: "a1",
        role: "assistant",
        text: "Hi there.",
        partial: false,
        full: "Hi there. All set.",
      },
    ]
    const rows = conversationReducer([], { type: "rehydrate", entries })
    expect(rows[0]).toEqual({ kind: "user", id: "u1", text: "hello" })
    expect(rows[1]).toMatchObject({ kind: "system", id: "n1", event: "reported", label: "Content draft" })
    // assistant seeded from `full`, re-split into sentences, finalized
    expect(rows[2]).toEqual({
      kind: "aura",
      id: "a1",
      sentences: ["Hi there.", "All set."],
      liveIdx: null,
      partial: false,
    })
  })

  it("rehydrate replaces existing rows (seed) and respects the cap", () => {
    const big: Array<TranscriptEntry | SystemEntry> = []
    for (let i = 0; i < MAX_ROWS + 10; i++) {
      big.push({ id: `u${i}`, role: "user", text: `m${i}`, partial: false })
    }
    const rows = conversationReducer([{ kind: "user", id: "old", text: "x" }], {
      type: "rehydrate",
      entries: big,
    })
    expect(rows).toHaveLength(MAX_ROWS)
    expect(rows.some((r) => r.id === "old")).toBe(false)
  })
})

describe("conversationReducer — reset", () => {
  it("clears the stream", () => {
    const rows = conversationReducer([{ kind: "user", id: "u1", text: "hi" }], { type: "reset" })
    expect(rows).toEqual([])
  })
})

// ============================================================================
// Task 11 — card anchoring. A pushed card anchors to the most recent aura/system
// row at push time (the in-progress turn). Updates keep the anchor; dismiss and
// eviction drop it; a card whose anchor row aged out of the stream falls back to
// end-render (resolveCardAnchor → null).
// ============================================================================

const aura = (id: string, partial = false): StreamRow => ({
  kind: "aura",
  id,
  sentences: ["x."],
  liveIdx: null,
  partial,
})
const user = (id: string): StreamRow => ({ kind: "user", id, text: "hi" })
const sys = (id: string): StreamRow => ({
  kind: "system",
  id,
  event: "delegated",
  label: "content-lead",
  ts: 0,
})

describe("anchorRowId — anchor target selection", () => {
  it("anchors to the latest aura row (partial preferred — belongs to the in-progress turn)", () => {
    expect(anchorRowId([user("u1"), aura("a1", true)])).toBe("a1")
    // Trailing user rows are skipped: the in-progress aura still owns the card.
    expect(anchorRowId([aura("a1", true), user("u2")])).toBe("a1")
  })

  it("anchors to the most recent aura even when finalized", () => {
    expect(anchorRowId([aura("a1"), user("u2")])).toBe("a1")
  })

  it("anchors to a system row when it is the latest aura/system row", () => {
    expect(anchorRowId([aura("a1"), sys("s1")])).toBe("s1")
  })

  it("returns null for an empty stream or a user-only stream (render at end)", () => {
    expect(anchorRowId([])).toBeNull()
    expect(anchorRowId([user("u1"), user("u2")])).toBeNull()
  })
})

describe("anchorsReducer — anchor map transitions", () => {
  it("anchorCard records cardId → latest aura/system row id", () => {
    const a = anchorsReducer({}, { type: "anchorCard", cardId: "c1", rows: [user("u1"), aura("a1", true)] })
    expect(a).toEqual({ c1: "a1" })
  })

  it("anchorCard on an empty/user-only stream records no anchor (renders at end)", () => {
    const a = anchorsReducer({}, { type: "anchorCard", cardId: "c1", rows: [user("u1")] })
    expect(a).toEqual({})
  })

  it("a re-pushed (updated) card keeps its ORIGINAL anchor", () => {
    let a = anchorsReducer({}, { type: "anchorCard", cardId: "c1", rows: [aura("a1")] })
    expect(a).toEqual({ c1: "a1" })
    // The turn moved on (a2 is now latest), but the card update must not re-anchor.
    a = anchorsReducer(a, { type: "anchorCard", cardId: "c1", rows: [aura("a1"), aura("a2", true)] })
    expect(a).toEqual({ c1: "a1" })
  })

  it("unanchorCard (dismiss) removes the anchor", () => {
    const a = anchorsReducer({ c1: "a1", c2: "a2" }, { type: "unanchorCard", cardId: "c1" })
    expect(a).toEqual({ c2: "a2" })
  })

  it("pruneAnchors (eviction/clear) drops anchors for cards no longer live", () => {
    const a = anchorsReducer({ c1: "a1", c2: "a2", c3: "a3" }, { type: "pruneAnchors", liveCardIds: ["c2"] })
    expect(a).toEqual({ c2: "a2" })
  })

  it("pruneAnchors with no live cards clears everything", () => {
    expect(anchorsReducer({ c1: "a1" }, { type: "pruneAnchors", liveCardIds: [] })).toEqual({})
  })

  it("returns the same reference when nothing changes (stable for React)", () => {
    const a: CardAnchors = { c1: "a1" }
    expect(anchorsReducer(a, { type: "unanchorCard", cardId: "ghost" })).toBe(a)
    expect(anchorsReducer(a, { type: "pruneAnchors", liveCardIds: ["c1"] })).toBe(a)
  })
})

describe("resolveCardAnchor — lookup against live rows", () => {
  it("resolves to the anchored row id when that row is still present", () => {
    expect(resolveCardAnchor({ c1: "a1" }, [user("u1"), aura("a1")], "c1")).toBe("a1")
  })

  it("falls back to end-render (null) when the anchored row has aged out of the stream", () => {
    expect(resolveCardAnchor({ c1: "a1" }, [user("u2"), aura("a2")], "c1")).toBeNull()
  })

  it("returns null for an unanchored card", () => {
    expect(resolveCardAnchor({}, [aura("a1")], "c1")).toBeNull()
  })
})
