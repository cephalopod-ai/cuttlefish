/**
 * Cuttlefish Talk — delegation-graph store (Mission Control).
 *
 * Pure reducer + selectors over the server-authoritative session tree under the
 * voice orchestrator (talk:graph WS deltas + GET /api/talk/graph snapshots).
 * Depth-1 nodes are the COO threads (work-tree root rows / ThreadCards);
 * depth-2+ are employees under a COO (indented ↳ sub-rows in the rail and on
 * the cards). Nodes NEVER auto-hide on completion — done is a dimmed visual
 * state; removal only happens on server delete.
 *
 * Graph deltas can carry a pre-running "idle" status on added/status changes
 * (the gateway emits them before its running-write), so live working state for
 * known nodes is driven by session:delta/session:completed via setStatus.
 */
export interface GraphNode {
  id: string
  parentId: string | null
  depth: number
  label: string
  employee: string | null
  status: string
  lastActivity: string
  /** First ~140 chars of the session's prompt — "what was asked" of this node. */
  briefExcerpt?: string
  /** Present (true) when this node is an attachment (soft link), not an owned descendant. */
  attached?: true
  /** Attachment mode — only on attached nodes. */
  mode?: "observe" | "engage"
}

export type GraphAction =
  | { type: "snapshot"; nodes: GraphNode[] }
  | { type: "upsert"; node: GraphNode }
  | { type: "setStatus"; id: string; status: string }
  | { type: "remove"; id: string }

const ACTIVE = new Set(["running", "waiting"])

export function isWorking(node: GraphNode): boolean {
  return ACTIVE.has(node.status)
}

export function graphReducer(nodes: GraphNode[], action: GraphAction): GraphNode[] {
  switch (action.type) {
    case "snapshot": {
      // Additive merge: snapshot fills gaps; nodes we already track keep their
      // live status (a WS delta is fresher than a fetch that raced it).
      const known = new Set(nodes.map((x) => x.id))
      const adds = action.nodes.filter((x) => !known.has(x.id))
      return adds.length ? [...nodes, ...adds] : nodes
    }
    case "upsert": {
      const i = nodes.findIndex((x) => x.id === action.node.id)
      if (i === -1) return [...nodes, action.node]
      const next = nodes.slice()
      next[i] = action.node
      return next
    }
    case "setStatus": {
      const i = nodes.findIndex((x) => x.id === action.id)
      if (i === -1 || nodes[i].status === action.status) return nodes
      const next = nodes.slice()
      next[i] = { ...next[i], status: action.status }
      return next
    }
    case "remove": {
      // Drop the node AND its subtree (parent links would dangle otherwise).
      const dead = new Set<string>([action.id])
      let grew = true
      while (grew) {
        grew = false
        for (const x of nodes) {
          if (x.parentId && dead.has(x.parentId) && !dead.has(x.id)) {
            dead.add(x.id)
            grew = true
          }
        }
      }
      return nodes.filter((x) => !dead.has(x.id))
    }
  }
}

export function graphIds(nodes: GraphNode[]): Set<string> {
  return new Set(nodes.map((x) => x.id))
}

export function depth1Of(nodes: GraphNode[]): GraphNode[] {
  return nodes.filter((x) => x.depth === 1)
}

export function childrenOf(nodes: GraphNode[], parentId: string): GraphNode[] {
  return nodes.filter((x) => x.parentId === parentId)
}
