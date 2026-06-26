import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { ThreadCard, subtreeRows } from "../thread-card"
import type { GraphNode } from "../graph-store"

const node = (over: Partial<GraphNode>): GraphNode => ({
  id: "t1",
  parentId: "root",
  depth: 1,
  label: "Platform Lead",
  employee: null,
  status: "running",
  lastActivity: "2026-06-11T00:00:00Z",
  ...over,
})

describe("ThreadCard", () => {
  it("renders route, brief, live activity and status", () => {
    const graph = [node({ briefExcerpt: "Audit the funnel" })]
    const activity = new Map([["t1", { activity: "reading…" }]])
    render(<ThreadCard threadId="t1" graph={graph} activity={activity} fallbackLabel="Platform Lead" />)
    expect(screen.getByText(/AURA → Platform Lead/)).toBeTruthy()
    expect(screen.getByText(/Audit the funnel/)).toBeTruthy()
    expect(screen.getByText("reading…")).toBeTruthy()
    expect(screen.getByText("working")).toBeTruthy()
  })

  it("renders nested sub-thread rows from the graph, indented by depth", () => {
    const graph = [
      node({}),
      node({ id: "g1", parentId: "t1", depth: 2, label: "Funnel Analyst", status: "running" }),
      node({ id: "gg1", parentId: "g1", depth: 3, label: "Query Runner", status: "idle" }),
    ]
    render(<ThreadCard threadId="t1" graph={graph} activity={new Map()} fallbackLabel="Platform Lead" />)
    expect(screen.getByText(/Funnel Analyst/)).toBeTruthy()
    expect(screen.getByText(/Query Runner/)).toBeTruthy()
    // After the listitem-wrapper fix: head + sub-row buttons are all role="button";
    // listitem wrappers are counted separately (no accessible name on the wrapper div).
    const allBtns = screen.getAllByRole("button", { name: /open thread/i })
    expect(allBtns.length).toBeGreaterThanOrEqual(3) // head + 2 sub-row buttons
    const listItems = screen.getAllByRole("listitem")
    expect(listItems.length).toBeGreaterThanOrEqual(2) // 2 sub-row wrapper divs
  })

  it("shows the report excerpt and settles when completed", () => {
    const graph = [node({ status: "idle" })]
    const activity = new Map([["t1", { reportExcerpt: "Funnel audit done: 3 fixes." }]])
    const { container } = render(
      <ThreadCard threadId="t1" graph={graph} activity={activity} fallbackLabel="Platform Lead" />,
    )
    expect(screen.getByText(/Funnel audit done/)).toBeTruthy()
    expect(container.querySelector(".tcard")?.getAttribute("data-status")).toBe("done")
  })

  it("opens the thread on click", () => {
    const onOpenThread = vi.fn()
    render(
      <ThreadCard
        threadId="t1"
        graph={[node({})]}
        activity={new Map()}
        fallbackLabel="L"
        onOpenThread={onOpenThread}
      />,
    )
    fireEvent.click(screen.getAllByRole("button", { name: /open thread/i })[0])
    expect(onOpenThread).toHaveBeenCalledWith("t1")
  })

  it("renders a settled fallback when the node is gone from the graph", () => {
    render(<ThreadCard threadId="zz" graph={[]} activity={new Map()} fallbackLabel="Old Thread" />)
    expect(screen.getByText(/AURA → Old Thread/)).toBeTruthy()
  })

  it("a user rename override (sideState) wins over the server label on the head", () => {
    render(
      <ThreadCard
        threadId="t1"
        graph={[node({})]}
        activity={new Map()}
        fallbackLabel="Platform Lead"
        sideState={new Map([["t1", { labelOverride: "My audit" }]])}
      />,
    )
    expect(screen.getByText(/AURA → My audit/)).toBeTruthy()
    expect(screen.queryByText(/AURA → Platform Lead/)).toBeNull()
  })

  it("a user rename override (sideState) wins on a sub-row label", () => {
    const graph = [
      node({}),
      node({ id: "g1", parentId: "t1", depth: 2, label: "Funnel Analyst", status: "running" }),
    ]
    render(
      <ThreadCard
        threadId="t1"
        graph={graph}
        activity={new Map()}
        fallbackLabel="Platform Lead"
        sideState={new Map([["g1", { labelOverride: "Renamed Analyst" }]])}
      />,
    )
    expect(screen.getByText(/→ Renamed Analyst/)).toBeTruthy()
    expect(screen.queryByText(/→ Funnel Analyst/)).toBeNull()
  })

  it("labels pass through deriveLabel (long labels truncate like the work tree)", () => {
    const longLabel = "This is a very long session label that exceeds the limit"
    render(
      <ThreadCard threadId="t1" graph={[node({ label: longLabel })]} activity={new Map()} fallbackLabel="L" />,
    )
    // deriveLabel caps at 32 chars with an ellipsis — same vocabulary as WorkTree.
    expect(screen.queryByText(new RegExp(longLabel))).toBeNull()
    expect(screen.getByText(/AURA → This is a very long session lab…/)).toBeTruthy()
  })

  it("sub-row click calls onOpenThread with the sub-thread id", () => {
    const onOpenThread = vi.fn()
    const graph = [
      node({}),
      node({ id: "g1", parentId: "t1", depth: 2, label: "Funnel Analyst", status: "running" }),
    ]
    render(
      <ThreadCard
        threadId="t1"
        graph={graph}
        activity={new Map()}
        fallbackLabel="Platform Lead"
        onOpenThread={onOpenThread}
      />,
    )
    // After the listitem-wrapper fix, the button inside the wrapper carries the accessible name.
    fireEvent.click(screen.getByRole("button", { name: /funnel analyst/i }))
    expect(onOpenThread).toHaveBeenCalledWith("g1")
  })
})

describe("subtreeRows", () => {
  it("returns DFS order for a depth-3 fixture", () => {
    const graph: GraphNode[] = [
      node({ id: "t1", parentId: "root", depth: 1, label: "Root" }),
      node({ id: "g1", parentId: "t1", depth: 2, label: "G1" }),
      node({ id: "g2", parentId: "t1", depth: 2, label: "G2" }),
      node({ id: "gg1", parentId: "g1", depth: 3, label: "GG1" }),
    ]
    const rows = subtreeRows("t1", graph)
    expect(rows.map((r) => r.id)).toEqual(["g1", "gg1", "g2"])
  })

  it("does not include nodes attached to the talk root (parentId: 'root')", () => {
    const graph: GraphNode[] = [
      node({ id: "t1", parentId: "root", depth: 1, label: "T1" }),
      node({ id: "t2", parentId: "root", depth: 1, label: "T2" }), // sibling — parentId points to talk ROOT, not t1
    ]
    const rows = subtreeRows("t1", graph)
    expect(rows.map((r) => r.id)).not.toContain("t2")
  })

  it("cycle guard: mutual-parent cycle does not hang and returns each node at most once", () => {
    // Malformed WS delta: a and b point at each other as parents.
    // Walk starts at "a": childrenOf("a") = [b], childrenOf("b") = [a] → would loop without guard.
    const a = node({ id: "a", parentId: "b", depth: 2, label: "A" })
    const b = node({ id: "b", parentId: "a", depth: 2, label: "B" })
    const rows = subtreeRows("a", [a, b])
    const ids = rows.map((r) => r.id)
    // No id appears more than once
    expect(new Set(ids).size).toBe(ids.length)
    // Both nodes encountered at most once each
    expect(ids.filter((x) => x === "a").length).toBeLessThanOrEqual(1)
    expect(ids.filter((x) => x === "b").length).toBeLessThanOrEqual(1)
  })
})
