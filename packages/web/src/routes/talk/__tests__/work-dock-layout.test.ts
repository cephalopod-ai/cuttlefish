import { describe, it, expect } from "vitest"
import {
  orderDockNodes,
  deriveLabel,
  focusNode,
  MAX_DOCK_NODES,
  type DockSideMap,
} from "../work-dock-layout"
import type { GraphNode } from "../graph-store"

/** depth-1 node helper (defaults to an idle, owned COO node). */
const d1 = (id: string, over: Partial<GraphNode> = {}): GraphNode => ({
  id,
  parentId: "root",
  depth: 1,
  label: id,
  employee: null,
  status: "idle",
  lastActivity: "2026-06-10T00:00:00Z",
  ...over,
})

/** depth-2+ descendant helper. */
const child = (id: string, parentId: string, over: Partial<GraphNode> = {}): GraphNode => ({
  id,
  parentId,
  depth: 2,
  label: id,
  employee: null,
  status: "running",
  lastActivity: "2026-06-10T00:00:00Z",
  ...over,
})

const at = (n: number) => new Date(2026, 5, 10, 0, 0, n).toISOString()
const empty: DockSideMap = new Map()

describe("orderDockNodes", () => {
  it("only considers depth-1 nodes (descendants excluded)", () => {
    const nodes = [
      d1("coo1", { lastActivity: at(1) }),
      child("e1", "coo1"),
      d1("coo2", { lastActivity: at(5) }),
    ]
    const v = orderDockNodes(nodes, empty)
    expect(v.shown.map((x) => x.id)).toEqual(["coo2", "coo1"]) // newest lastActivity first among idle
    expect(v.shown.every((x) => x.depth === 1)).toBe(true)
  })

  it("orders working (running) owned first, then idle/done newest-first", () => {
    const nodes = [
      d1("idle-old", { status: "idle", lastActivity: at(1) }),
      d1("working", { status: "running", lastActivity: at(2) }),
      d1("idle-new", { status: "idle", lastActivity: at(5) }),
    ]
    const v = orderDockNodes(nodes, empty)
    expect(v.shown.map((x) => x.id)).toEqual(["working", "idle-new", "idle-old"])
    expect(v.overflow).toBe(0)
  })

  it("orders owned-working before attached-working before idle/done", () => {
    const nodes = [
      d1("idle", { status: "idle", lastActivity: at(9) }),
      d1("attached-working", { status: "running", attached: true, lastActivity: at(2) }),
      d1("owned-working", { status: "running", lastActivity: at(1) }),
    ]
    const v = orderDockNodes(nodes, empty)
    expect(v.shown.map((x) => x.id)).toEqual(["owned-working", "attached-working", "idle"])
  })

  it("treats 'waiting' as working too", () => {
    const nodes = [
      d1("idle", { status: "idle", lastActivity: at(9) }),
      d1("waiting", { status: "waiting", lastActivity: at(1) }),
    ]
    const v = orderDockNodes(nodes, empty)
    expect(v.shown.map((x) => x.id)).toEqual(["waiting", "idle"])
  })

  it("orders concurrent working nodes newest-first", () => {
    const nodes = [
      d1("older-working", { status: "running", lastActivity: at(10) }),
      d1("newer-working", { status: "running", lastActivity: at(20) }),
    ]
    const v = orderDockNodes(nodes, empty)
    expect(v.shown.map((x) => x.id)).toEqual(["newer-working", "older-working"])
  })

  it("excludes dismissed (tombstoned) nodes", () => {
    const side: DockSideMap = new Map([["gone", { dismissed: true }]])
    const nodes = [d1("keep", { lastActivity: at(1) }), d1("gone", { lastActivity: at(9) })]
    const v = orderDockNodes(nodes, side)
    expect(v.shown.map((x) => x.id)).toEqual(["keep"])
  })

  it("caps at MAX_DOCK_NODES and reports overflow", () => {
    const nodes = Array.from({ length: MAX_DOCK_NODES + 3 }, (_, i) =>
      d1(`x${i}`, { lastActivity: at(i) }),
    )
    const v = orderDockNodes(nodes, empty)
    expect(v.shown).toHaveLength(MAX_DOCK_NODES)
    expect(v.overflow).toBe(3)
  })

  it("overflow counts only non-dismissed nodes", () => {
    const side: DockSideMap = new Map([["x0", { dismissed: true }]])
    const nodes = Array.from({ length: MAX_DOCK_NODES + 1 }, (_, i) =>
      d1(`x${i}`, { lastActivity: at(i) }),
    )
    const v = orderDockNodes(nodes, side)
    expect(v.shown).toHaveLength(MAX_DOCK_NODES)
    expect(v.overflow).toBe(0) // one dismissed → exactly MAX shown, none left over
  })
})

describe("focusNode", () => {
  it("returns the most-recent running depth-1 node", () => {
    const nodes = [
      d1("a", { status: "running", lastActivity: at(1) }),
      d1("b", { status: "running", lastActivity: at(5) }),
      d1("c", { status: "idle", lastActivity: at(9) }),
    ]
    expect(focusNode(nodes)!.id).toBe("b")
  })

  it("returns null when nothing depth-1 is running", () => {
    expect(focusNode([d1("a", { status: "idle" }), child("e", "a", { status: "running" })])).toBeNull()
  })
})

describe("deriveLabel", () => {
  it("collapses whitespace and strips leading markers", () => {
    expect(deriveLabel("  content   blog  ")).toBe("content blog")
    expect(deriveLabel("> * quoted")).toBe("quoted")
  })
  it("falls back to 'Thread' for empty input", () => {
    expect(deriveLabel("")).toBe("Thread")
    expect(deriveLabel("   ")).toBe("Thread")
  })
  it("truncates long labels with an ellipsis", () => {
    const out = deriveLabel("research the entire quarterly finance report end to end")
    expect(out.length).toBeLessThanOrEqual(32)
    expect(out.endsWith("…")).toBe(true)
  })
})
