/**
 * Cuttlefish Talk — rehydration transforms (server snapshot → UI state).
 */
import { describe, it, expect } from "vitest"
import { messagesToEntries } from "../rehydrate"

describe("messagesToEntries", () => {
  it("maps user/assistant messages to finalized entries (markdown stripped)", () => {
    const session = {
      messages: [
        { id: "u1", role: "user", content: "hello there" },
        { id: "a1", role: "assistant", content: "## Hi\n**bold** reply" },
      ],
    }
    expect(messagesToEntries(session)).toEqual([
      { id: "u1", role: "user", text: "hello there", partial: false, full: "hello there" },
      { id: "a1", role: "assistant", text: "Hi\nbold reply", partial: false, full: "Hi\nbold reply" },
    ])
  })

  it("maps notification rows to system entries; drops empty bodies", () => {
    const session = {
      messages: [
        { id: "n1", role: "notification", content: "joined" },
        { id: "a1", role: "assistant", content: "   " },
        { id: "a2", role: "assistant", content: "kept" },
      ],
    }
    expect(messagesToEntries(session)).toEqual([
      { id: "n1", kind: "system", event: "info", label: "joined" },
      { id: "a2", role: "assistant", text: "kept", partial: false, full: "kept" },
    ])
  })

  it('maps 📩 Thread "label" reported back to system/reported', () => {
    const session = {
      messages: [
        {
          id: "n1",
          role: "notification",
          content: '📩 Thread "Content draft" reported back. Summary here.',
        },
      ],
    }
    expect(messagesToEntries(session)).toEqual([
      { id: "n1", kind: "system", event: "reported", label: "Content draft" },
    ])
  })

  it('maps ⚠️ Thread "X" hit an error to system/error', () => {
    const session = {
      messages: [{ id: "n2", role: "notification", content: '⚠️ Thread "X" hit an error' }],
    }
    expect(messagesToEntries(session)).toEqual([
      { id: "n2", kind: "system", event: "error", label: "X" },
    ])
  })

  it('maps 🔄 Employee "X" resumed to system/reported', () => {
    const session = {
      messages: [
        {
          id: "n3",
          role: "notification",
          content: '🔄 Employee "cuttlefish-dev" has resumed after rate limit cleared.',
        },
      ],
    }
    expect(messagesToEntries(session)).toEqual([
      { id: "n3", kind: "system", event: "reported", label: "cuttlefish-dev" },
    ])
  })

  it('maps 📩 Employee "X" replied (persisted format) to system/reported', () => {
    const content =
      '📩 Employee "content-lead" replied in child session abc123.\n\nReply preview:\nDone.'
    const session = {
      messages: [{ id: "n4", role: "notification", content }],
    }
    expect(messagesToEntries(session)).toEqual([
      { id: "n4", kind: "system", event: "reported", label: "content-lead" },
    ])
  })

  it("maps unparseable notification (no emoji, no quotes) to system/info with first 60 chars", () => {
    const content = "Some plain notification message that has no emoji or quotes here"
    const session = {
      messages: [{ id: "n5", role: "notification", content }],
    }
    expect(messagesToEntries(session)).toEqual([
      { id: "n5", kind: "system", event: "info", label: content.slice(0, 60) },
    ])
  })

  it("synthesizes id for notification without an id", () => {
    const session = {
      messages: [{ role: "notification", content: "ping" }],
    }
    const result = messagesToEntries(session)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ kind: "system", event: "info", label: "ping" })
    expect(typeof result[0].id).toBe("string")
  })

  it("falls back to .history and synthesizes ids", () => {
    const session = { history: [{ role: "user", text: "no id here" }] }
    expect(messagesToEntries(session)).toEqual([
      { id: "user-0", role: "user", text: "no id here", partial: false, full: "no id here" },
    ])
  })

  it("returns [] for missing/!array history", () => {
    expect(messagesToEntries(undefined)).toEqual([])
    expect(messagesToEntries({})).toEqual([])
    expect(messagesToEntries({ messages: "nope" })).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// snapshotDelegationChips — delegation cards rebuilt from the graph snapshot
// ---------------------------------------------------------------------------
import { snapshotDelegationChips } from "../rehydrate"
import { conversationReducer, type StreamRow } from "../use-conversation"
import type { TalkGraphNodeWire } from "../protocol"

const wire = (over: Partial<TalkGraphNodeWire>): TalkGraphNodeWire => ({
  id: "t1",
  parentId: "root",
  depth: 1,
  label: "Platform Lead",
  employee: null,
  status: "running",
  lastActivity: "2026-06-11T00:00:00Z",
  ...over,
})

describe("snapshotDelegationChips", () => {
  it("maps depth-1 owned nodes to delegated chips (stable sys-del ids, ts from lastActivity)", () => {
    const chips = snapshotDelegationChips([wire({})])
    expect(chips).toHaveLength(1)
    expect(chips[0]).toMatchObject({
      id: "sys-del-t1",
      event: "delegated",
      label: "Platform Lead",
      threadId: "t1",
      ts: Date.parse("2026-06-11T00:00:00Z"),
    })
    expect(typeof chips[0].hue).toBe("number")
  })

  it("skips attached and depth-2+ nodes", () => {
    const chips = snapshotDelegationChips([
      wire({}),
      wire({ id: "att1", attached: true, mode: "observe" }),
      wire({ id: "g1", parentId: "t1", depth: 2, label: "Analyst" }),
    ])
    expect(chips.map((c) => c.threadId)).toEqual(["t1"])
  })

  it("reducer-level: snapshot chips append once AFTER history; a second snapshot doesn't duplicate", () => {
    let rows: StreamRow[] = []
    rows = conversationReducer(rows, {
      type: "rehydrate",
      entries: [{ id: "u1", role: "user", text: "hi", partial: false, full: "hi" }],
    })
    const nodes = [wire({}), wire({ id: "t2", label: "Other Lead" })]
    for (const chip of snapshotDelegationChips(nodes)) rows = conversationReducer(rows, { type: "system", ...chip })
    expect(rows.map((r) => r.id)).toEqual(["u1", "sys-del-t1", "sys-del-t2"])
    // Second snapshot (reconnect) — reducer dedups by row id, nothing duplicates.
    for (const chip of snapshotDelegationChips(nodes)) rows = conversationReducer(rows, { type: "system", ...chip })
    expect(rows.map((r) => r.id)).toEqual(["u1", "sys-del-t1", "sys-del-t2"])
  })

  it("a chip already added live (talk:graph delta) is not re-appended on snapshot", () => {
    let rows: StreamRow[] = []
    // Live "added" path uses the same sys-del-<id> id.
    rows = conversationReducer(rows, { type: "system", id: "sys-del-t1", event: "delegated", label: "Platform Lead", threadId: "t1", ts: 1 })
    for (const chip of snapshotDelegationChips([wire({})])) rows = conversationReducer(rows, { type: "system", ...chip })
    expect(rows.filter((r) => r.id === "sys-del-t1")).toHaveLength(1)
  })
})
