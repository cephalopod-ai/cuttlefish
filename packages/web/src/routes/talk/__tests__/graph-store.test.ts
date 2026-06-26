import { describe, it, expect } from "vitest"
import { graphReducer, graphIds, depth1Of, childrenOf, type GraphNode } from "../graph-store"

const n = (id: string, over: Partial<GraphNode> = {}): GraphNode => ({
  id, parentId: "root", depth: 1, label: id, employee: null, status: "running",
  lastActivity: "2026-06-10T00:00:00Z", ...over,
})

describe("graphReducer", () => {
  it("snapshot merges additively (live nodes never dropped)", () => {
    const live = [n("a", { status: "running" })]
    const next = graphReducer(live, { type: "snapshot", nodes: [n("a", { status: "idle" }), n("b")] })
    expect(next.map((x) => x.id).sort()).toEqual(["a", "b"])
    expect(next.find((x) => x.id === "a")!.status).toBe("running") // live wins over stale snapshot
  })
  it("upsert adds or replaces a node", () => {
    const one = graphReducer([], { type: "upsert", node: n("a") })
    expect(one).toHaveLength(1)
    const two = graphReducer(one, { type: "upsert", node: n("a", { status: "idle" }) })
    expect(two).toHaveLength(1)
    expect(two[0].status).toBe("idle")
  })
  it("setStatus patches one node's status in place", () => {
    const nodes = [n("a"), n("b")]
    const next = graphReducer(nodes, { type: "setStatus", id: "b", status: "idle" })
    expect(next.find((x) => x.id === "b")!.status).toBe("idle")
    expect(next.find((x) => x.id === "a")!.status).toBe("running")
    expect(graphReducer(nodes, { type: "setStatus", id: "zz", status: "idle" })).toBe(nodes) // unknown id: no-op, same ref
  })
  it("remove drops the node and its descendants", () => {
    const nodes = [n("a"), n("e1", { parentId: "a", depth: 2 }), n("b")]
    const next = graphReducer(nodes, { type: "remove", id: "a" })
    expect(next.map((x) => x.id)).toEqual(["b"])
  })
})

describe("attachment nodes", () => {
  it("upserts an attached node (carrying attached + mode) and removes it on detach", () => {
    const att = n("ext", { attached: true, mode: "engage", parentId: "root", depth: 1 })
    const added = graphReducer([n("a")], { type: "upsert", node: att })
    const stored = added.find((x) => x.id === "ext")!
    expect(stored.attached).toBe(true)
    expect(stored.mode).toBe("engage")
    expect(depth1Of(added).map((x) => x.id).sort()).toEqual(["a", "ext"])

    // A "detached" delta maps to a remove action — the attachment node drops out.
    const removed = graphReducer(added, { type: "remove", id: "ext" })
    expect(removed.map((x) => x.id)).toEqual(["a"])
  })
})

describe("selectors", () => {
  const nodes = [n("a"), n("b", { status: "idle" }), n("e1", { parentId: "a", depth: 2 })]
  it("graphIds returns every id at every depth", () => {
    expect([...graphIds(nodes)].sort()).toEqual(["a", "b", "e1"])
  })
  it("depth1Of / childrenOf slice the tree", () => {
    expect(depth1Of(nodes).map((x) => x.id)).toEqual(["a", "b"])
    expect(childrenOf(nodes, "a").map((x) => x.id)).toEqual(["e1"])
  })
})
