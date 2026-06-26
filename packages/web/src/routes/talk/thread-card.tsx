/**
 * Cuttlefish Talk — ThreadCard (delegation as communication).
 *
 * A live delegation row in the conversation stream, replacing the one-line
 * "⟶ delegated" chip. Shows the route (AURA → lead), what was asked (brief
 * excerpt), what the worker is doing right now (live activity line), nested
 * sub-threads as indented rows (any depth — grandchildren included), and the
 * report excerpt once the thread completes. Clicking the head or any sub-row
 * opens that session in the thread drawer.
 *
 * Structural data comes from the live graph (single source); the live/report
 * lines come from the advisory thread-activity overlay. A node missing from
 * the graph (dismissed/aged out) renders a settled head from fallbackLabel.
 */
import type { CSSProperties } from "react"
import type { GraphNode } from "./graph-store"
import { isWorking, childrenOf } from "./graph-store"
import type { ActivityMap } from "./thread-activity"
import { channelHue } from "./channel-identity"
import { deriveLabel, type DockSideMap } from "./work-dock-layout"
import "./thread-card.css"

export interface ThreadCardProps {
  threadId: string
  graph: GraphNode[]
  activity: ActivityMap
  /** Label from the stream row — used when the node left the graph. */
  fallbackLabel: string
  hue?: number
  /**
   * User side-state (rename overrides) — a labelOverride wins over the server
   * label, exactly like WorkTree's labelFor, so a renamed thread reads the same
   * in the rail and on the card.
   */
  sideState?: DockSideMap
  onOpenThread?: (id: string) => void
}

export type StatusKind = "working" | "waiting" | "done" | "error"

/** Shared status mapping for thread rows (also used by the thread drawer). */
export function statusOf(node: GraphNode | undefined): StatusKind {
  if (!node) return "done"
  if (node.status === "error" || node.status === "failed") return "error"
  if (node.status === "waiting") return "waiting"
  if (isWorking(node)) return "working"
  return "done"
}

/** DFS the subtree under `rootId` (excluding the root), depth-first order. */
export function subtreeRows(rootId: string, graph: GraphNode[]): GraphNode[] {
  const out: GraphNode[] = []
  const seen = new Set<string>()
  const walk = (id: string) => {
    for (const child of childrenOf(graph, id)) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      out.push(child)
      walk(child.id)
    }
  }
  walk(rootId)
  return out
}

function StatusPill({ kind }: { kind: StatusKind }) {
  return (
    <span className="tcard__pill" data-kind={kind} key={kind}>
      {kind === "working" ? "working" : kind === "waiting" ? "waiting" : kind === "error" ? "error" : "done"}
    </span>
  )
}

function SubRow({
  node,
  baseDepth,
  activity,
  sideState,
  onOpenThread,
}: {
  node: GraphNode
  baseDepth: number
  activity: ActivityMap
  sideState?: DockSideMap
  onOpenThread?: (id: string) => void
}) {
  const kind = statusOf(node)
  const label = deriveLabel(sideState?.get(node.id)?.labelOverride ?? node.label)
  const live = kind === "working" || kind === "waiting" ? activity.get(node.id)?.activity : undefined
  const indent = Math.min(Math.max(node.depth - baseDepth, 1), 3)
  // Hue stays keyed on the server identity (label/id) so a rename never shifts a thread's color.
  const hue = channelHue(node.label || node.id)
  // Wrapper div owns the listitem role so the inner button retains full button semantics for assistive tech.
  return (
    <div
      role="listitem"
      className="tcard__sub"
      style={{ ["--tc-indent" as string]: String(indent), ["--tc-hue" as string]: String(hue) } as CSSProperties}
      data-status={kind}
    >
      <button
        type="button"
        className="tcard__sub-btn"
        aria-label={`Open thread: ${label} — ${kind}`}
        onClick={onOpenThread ? () => onOpenThread(node.id) : undefined}
      >
        <span className="tcard__connector" aria-hidden="true">
          ↳
        </span>
        <span className="tcard__dot" aria-hidden="true" />
        <span className="tcard__sub-main">
          <span className="tcard__sub-route">→ {label}</span>
          {live ? (
            <span className="tcard__live" key={live}>
              {live}
            </span>
          ) : null}
        </span>
        <StatusPill kind={kind} />
      </button>
    </div>
  )
}

export function ThreadCard({ threadId, graph, activity, fallbackLabel, hue, sideState, onOpenThread }: ThreadCardProps) {
  const node = graph.find((n) => n.id === threadId)
  const kind = statusOf(node)
  // Label resolution mirrors WorkTree's labelFor: user rename override → server
  // label, both through deriveLabel. Gone-from-graph cards settle on fallbackLabel.
  const label = node
    ? deriveLabel(sideState?.get(threadId)?.labelOverride ?? (node.label || fallbackLabel))
    : deriveLabel(fallbackLabel)
  // Hue stays keyed on the raw server identity so a rename never shifts the color.
  const cardHue = hue ?? channelHue(node?.label || fallbackLabel || threadId)
  const entry = activity.get(threadId)
  const live = kind === "working" || kind === "waiting" ? entry?.activity : undefined
  const report = entry?.reportExcerpt
  const subs = node ? subtreeRows(threadId, graph) : []

  return (
    <div
      className="tcard"
      data-status={kind}
      style={{ ["--tc-hue" as string]: String(cardHue) } as CSSProperties}
    >
      <button
        type="button"
        className="tcard__head"
        aria-label={`Open thread: ${label} — ${kind}`}
        onClick={onOpenThread ? () => onOpenThread(threadId) : undefined}
      >
        <span className={`tcard__dot${kind === "working" ? " tcard__dot--working" : ""}`} aria-hidden="true" />
        <span className="tcard__route">AURA → {label}</span>
        <StatusPill kind={kind} />
      </button>

      {node?.briefExcerpt ? <p className="tcard__brief">“{node.briefExcerpt}”</p> : null}
      {live ? (
        <p className="tcard__live tcard__live--head" key={live}>
          {live}
        </p>
      ) : null}

      {subs.length > 0 ? (
        <div className="tcard__subs" role="list" aria-label={`${subs.length} sub-threads`}>
          {subs.map((sub) => (
            <SubRow
              key={sub.id}
              node={sub}
              baseDepth={node?.depth ?? 1}
              activity={activity}
              sideState={sideState}
              onOpenThread={onOpenThread}
            />
          ))}
        </div>
      ) : null}

      {report ? <p className="tcard__report">⟵ “{report}”</p> : null}
    </div>
  )
}
