/**
 * Cuttlefish Talk — pure work-rail layout helpers (Mission Control).
 *
 * Serves the WorkTree, the single graph-driven work rail (always a floating
 * overlay on the right edge — it never takes a layout column). It reads the
 * delegation graph (graph-store) directly — there is no separate thread store.
 * Depth-1 nodes are the COO threads (one root row each); depth-2+ descendants
 * render as labeled, indented sub-rows (WorkTree walks them via thread-card's
 * subtreeRows — the old anonymous mini-dots are gone). Nodes never auto-hide on
 * completion — idle/done is a dimmed visual state. The only way a row leaves is
 * an explicit user dismiss, tracked as a tombstone in the side-state map.
 *
 * These functions are pure (no React / DOM) so the ordering can be unit-tested.
 * Ported + extended from the retired constellation-layout.ts.
 */
import type { GraphNode } from "./graph-store"
import { isWorking, depth1Of } from "./graph-store"
import { channelHue } from "./channel-identity"

export const MAX_DOCK_NODES = 8

/**
 * Per-node UI side-state, layered over the server-authoritative graph and
 * persisted to localStorage (talk-storage keys). `dismissed` tombstones a chip;
 * `labelOverride` is a user rename; `pinned` is reserved for forward compatibility
 * (the live route target is the separate `targetThreadId`). `hue` is a persisted
 * user-chosen tint read by WorkTree to override the channel-identity default.
 */
export interface DockSideState {
  hue?: number
  labelOverride?: string
  dismissed?: boolean
  pinned?: boolean
}

export type DockSideMap = Map<string, DockSideState>

/** Clean a raw label into a compact topic string (ported from thread-store). */
export function deriveLabel(raw: string): string {
  const s = (raw || "").replace(/\s+/g, " ").trim().replace(/^[>*\-\s]+/, "")
  if (!s) return "Thread"
  return s.length > 32 ? s.slice(0, 31).trimEnd() + "…" : s
}

/** Stable hue for a node (channel-identity keyed by label, falling back to id). */
export function nodeHue(node: GraphNode): number {
  return channelHue(node.label || node.id)
}

/** Parse an ISO/epoch lastActivity into ms for ordering (0 when absent). */
function activityMs(node: GraphNode): number {
  const v = node.lastActivity
  if (!v) return 0
  return Date.parse(v) || 0
}

/**
 * Ordering rank: owned-working (0) → attached-working (1) → idle/done (2).
 * Within a rank, newest lastActivity leads.
 */
function rank(node: GraphNode): number {
  if (isWorking(node)) return node.attached ? 1 : 0
  return 2
}

/**
 * Depth-1 graph nodes ordered for the dock rail: working first (owned before
 * attached), then idle/done newest-first. Dismissed (tombstoned) nodes are
 * excluded. Capped at MAX_DOCK_NODES with an explicit overflow count.
 */
export function orderDockNodes(
  nodes: GraphNode[],
  sideState: DockSideMap,
): { shown: GraphNode[]; overflow: number } {
  const visible = depth1Of(nodes).filter((n) => !sideState.get(n.id)?.dismissed)
  const sorted = visible.slice().sort((a, b) => {
    const ra = rank(a)
    const rb = rank(b)
    if (ra !== rb) return ra - rb
    return activityMs(b) - activityMs(a)
  })
  return {
    shown: sorted.slice(0, MAX_DOCK_NODES),
    overflow: Math.max(0, sorted.length - MAX_DOCK_NODES),
  }
}

/**
 * The focused channel: the most-recently-active still-running depth-1 node (the
 * one the main orb morphs toward). Null when nothing depth-1 is running → the
 * orb eases back to AURA's amber identity.
 */
export function focusNode(nodes: GraphNode[]): GraphNode | null {
  const running = depth1Of(nodes).filter(isWorking)
  if (!running.length) return null
  return running.slice().sort((a, b) => activityMs(b) - activityMs(a))[0]
}
