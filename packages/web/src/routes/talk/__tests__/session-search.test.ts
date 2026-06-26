import { describe, it, expect } from "vitest"
import {
  parseSnippet,
  hasEngageAttachment,
  mapSearchResults,
  type TalkSearchApiResponse,
} from "../session-search"
import type { GraphNode } from "../graph-store"

const node = (id: string, over: Partial<GraphNode> = {}): GraphNode => ({
  id,
  parentId: "root",
  depth: 1,
  label: id,
  employee: null,
  status: "running",
  lastActivity: "2026-06-10T00:00:00Z",
  ...over,
})

describe("parseSnippet", () => {
  it("returns a single plain segment when there are no markers", () => {
    expect(parseSnippet("fixed the refunds")).toEqual([{ text: "fixed the refunds", hit: false }])
  })

  it("returns [] for an empty string", () => {
    expect(parseSnippet("")).toEqual([])
  })

  it("parses one marker pair into plain + hit + plain segments", () => {
    expect(parseSnippet("…fixed the «Stripe» refunds…")).toEqual([
      { text: "…fixed the ", hit: false },
      { text: "Stripe", hit: true },
      { text: " refunds…", hit: false },
    ])
  })

  it("parses multiple marker pairs", () => {
    expect(parseSnippet("«Stripe» and «refunds» both")).toEqual([
      { text: "Stripe", hit: true },
      { text: " and ", hit: false },
      { text: "refunds", hit: true },
      { text: " both", hit: false },
    ])
  })

  it("renders a hit at the very start with no leading plain segment", () => {
    expect(parseSnippet("«hit» tail")).toEqual([
      { text: "hit", hit: true },
      { text: " tail", hit: false },
    ])
  })

  it("treats unbalanced markers gracefully as plain text (markers stripped, no hits)", () => {
    const segs = parseSnippet("…fixed the «Stripe refunds…")
    expect(segs.every((s) => !s.hit)).toBe(true)
    expect(segs.map((s) => s.text).join("")).toBe("…fixed the Stripe refunds…")
  })

  it("treats a lone closing marker as plain text", () => {
    expect(parseSnippet("refunds» done")).toEqual([{ text: "refunds done", hit: false }])
  })

  it("merges plain text across an empty highlight into a single segment", () => {
    // An empty «» pair contributes no hit span; the surrounding plain text must
    // collapse into ONE segment rather than two adjacent plain spans.
    expect(parseSnippet("a«»b")).toEqual([{ text: "ab", hit: false }])
  })
})

describe("hasEngageAttachment", () => {
  it("is false for an empty graph", () => {
    expect(hasEngageAttachment([])).toBe(false)
  })

  it("is false when nodes are owned (no attached flag)", () => {
    expect(hasEngageAttachment([node("a"), node("b")])).toBe(false)
  })

  it("is false when the only attachment is observe-mode", () => {
    expect(hasEngageAttachment([node("a", { attached: true, mode: "observe" })])).toBe(false)
  })

  it("is true when any node is attached in engage mode", () => {
    expect(
      hasEngageAttachment([node("a"), node("b", { attached: true, mode: "engage" })]),
    ).toBe(true)
  })
})

describe("mapSearchResults", () => {
  const apiResponse: TalkSearchApiResponse = {
    ok: true,
    results: [
      {
        sessionId: "s1",
        title: "Stripe refunds",
        employee: "support-lead",
        source: "employee",
        lastActivity: "2026-06-10T00:00:00Z",
        status: "idle",
        isTalkChild: true,
        hits: [{ snippet: "…fixed the «Stripe» refunds…", role: "assistant", ts: 1 }],
      },
      {
        sessionId: "s2",
        title: "",
        employee: null,
        source: "direct",
        lastActivity: "2026-06-10T00:00:00Z",
        status: "running",
        isTalkChild: false,
        hits: [],
      },
    ],
  }

  it("maps title with a fallback to 'untitled'", () => {
    const rows = mapSearchResults(apiResponse, [])
    expect(rows[0].title).toBe("Stripe refunds")
    expect(rows[1].title).toBe("untitled")
  })

  it("builds meta from employee · source · relative time", () => {
    const rows = mapSearchResults(apiResponse, [], Date.parse("2026-06-10T00:05:00Z"))
    expect(rows[0].meta).toBe("support-lead · employee · 5m ago")
    // No employee → source · time only.
    expect(rows[1].meta).toBe("direct · 5m ago")
  })

  it("parses the first hit's snippet into segments", () => {
    const rows = mapSearchResults(apiResponse, [])
    expect(rows[0].snippetSegments).toEqual([
      { text: "…fixed the ", hit: false },
      { text: "Stripe", hit: true },
      { text: " refunds…", hit: false },
    ])
    // No hits → empty segments.
    expect(rows[1].snippetSegments).toEqual([])
  })

  it("carries isTalkChild through", () => {
    const rows = mapSearchResults(apiResponse, [])
    expect(rows[0].isTalkChild).toBe(true)
    expect(rows[1].isTalkChild).toBe(false)
  })

  it("derives attachedState from live graph nodes", () => {
    const nodes = [
      node("s1", { attached: true, mode: "engage" }),
      node("s2", { attached: true, mode: "observe" }),
    ]
    const rows = mapSearchResults(apiResponse, nodes)
    expect(rows[0].attachedState).toBe("attached-engage")
    expect(rows[1].attachedState).toBe("attached-observe")
  })

  it("attachedState is null when the node isn't attached (owned child) or absent", () => {
    const nodes = [node("s1")] // present but not attached
    const rows = mapSearchResults(apiResponse, nodes)
    expect(rows[0].attachedState).toBeNull()
    expect(rows[1].attachedState).toBeNull()
  })

  it("tolerates a degraded/empty response", () => {
    expect(mapSearchResults({ ok: true, results: [] }, [])).toEqual([])
    expect(mapSearchResults(undefined as unknown as TalkSearchApiResponse, [])).toEqual([])
  })
})
