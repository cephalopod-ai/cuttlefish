/**
 * Cuttlefish Talk — WorkTree (the work rail shows the real delegation hierarchy).
 *
 * A floating glass rail on the right edge where EVERY node of the delegation
 * tree is a labeled, statused, clickable row — depth-1 COO threads as root
 * rows, depth-2+ employees as indented ↳ sub-rows (any depth; replaces the
 * retired dock's anonymous mini-dots). Root rows carry a hue dot (solid = owned;
 * hollow dashed ring + ⇄ glyph = an attachment soft-link), the topic label, a
 * ⋯ menu (Pin-as-route-target / Rename inline / Dismiss tombstone), and —
 * while working — a live "now doing" line. Sub-rows carry their own hue dot,
 * label, status pill, and live line, indented by depth; no menu.
 *
 * Tapping any row opens that session's read-only chat. When the conversation
 * is idle and nothing in the shown trees is working the rail collapses to bare
 * dots (sub-rows tuck under their root dot); it expands on hover/focus or
 * whenever anything runs. Structural rows come from the graph (graph-store is
 * the single source) via orderDockNodes + subtreeRows; `sideState` layers user
 * renames/dismissals; live lines come from the thread-activity overlay.
 * Ledger-themed (light + dark via tokens).
 */
import { Fragment, useEffect, useRef, useState } from "react"
import type { CSSProperties } from "react"
import { MoreHorizontal, Pencil, X, Target, ArrowLeftRight } from "lucide-react"
import type { GraphNode } from "./graph-store"
import { isWorking } from "./graph-store"
import { subtreeRows, statusOf } from "./thread-card"
import type { ActivityMap } from "./thread-activity"
import { orderDockNodes, nodeHue, deriveLabel, type DockSideMap } from "./work-dock-layout"
import "./work-tree.css"

export interface WorkTreeProps {
  /** Full delegation graph (depth-1 = COO threads, depth-2+ = employees). */
  graph: GraphNode[]
  /** User side-state (rename overrides + dismiss tombstones). */
  sideState: DockSideMap
  /** Live "now doing" overlay keyed by sessionId (thread-activity). */
  activity: ActivityMap
  /** The node the next user message routes to continue (null → new thread). */
  targetThreadId: string | null
  /** Open the read-only child-session chat modal. */
  onOpenThread: (id: string) => void
  /** Set/clear the route target (null → next message starts a new thread). */
  onSelectTarget: (id: string | null) => void
  /** Persist a user rename (label override). */
  onRename: (id: string, label: string) => void
  /** Tombstone a root row (does not kill the gateway session). */
  onDismiss: (id: string) => void
  /** Conversation is idle → allow the rail to collapse when nothing runs. */
  idle?: boolean
}

/** A node's display label: a user override wins over the server label. */
function labelFor(node: GraphNode, side: DockSideMap): string {
  const override = side.get(node.id)?.labelOverride
  return override ? deriveLabel(override) : deriveLabel(node.label || node.id)
}

function SubRow({
  node,
  baseDepth,
  index,
  sideState,
  activity,
  onOpenThread,
}: {
  node: GraphNode
  baseDepth: number
  index: number
  sideState: DockSideMap
  activity: ActivityMap
  onOpenThread: (id: string) => void
}) {
  const kind = statusOf(node)
  const label = labelFor(node, sideState)
  const live = kind === "working" || kind === "waiting" ? activity.get(node.id)?.activity : undefined
  const indent = Math.min(Math.max(node.depth - baseDepth, 1), 3)
  // Wrapper div owns the listitem role so the inner button retains full button semantics for assistive tech.
  return (
    <div
      role="listitem"
      className="wt__item wt__item--sub"
      style={
        {
          ["--wt-hue" as string]: String(nodeHue(node)),
          ["--wt-indent" as string]: String(indent),
          ["--wt-i" as string]: String(index),
        } as CSSProperties
      }
      data-status={kind}
    >
      <button
        type="button"
        className="wt__sub-btn"
        aria-label={`Open thread: ${label} — ${kind}`}
        title={`Open thread: ${label} — ${kind}`}
        onClick={() => onOpenThread(node.id)}
      >
        <span className="wt__connector" aria-hidden="true">
          ↳
        </span>
        <span className="wt__dot wt__dot--sub" aria-hidden="true" />
        <span className="wt__sub-main">
          <span className="wt__sub-label">{label}</span>
          {live ? (
            <span className="wt__live" key={live}>
              {live}
            </span>
          ) : null}
        </span>
        <span className="wt__pill" data-kind={kind}>
          {kind}
        </span>
      </button>
    </div>
  )
}

export function WorkTree({
  graph,
  sideState,
  activity,
  targetThreadId,
  onOpenThread,
  onSelectTarget,
  onRename,
  onDismiss,
  idle = false,
}: WorkTreeProps) {
  const { shown, overflow } = orderDockNodes(graph, sideState)

  const [menuId, setMenuId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState("")

  // Close the ⋯ menu on an outside click.
  const rootRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!menuId) return
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setMenuId(null)
    }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [menuId])

  // Prune stale menuId / editingId when a node is evicted by cap or user dismiss.
  useEffect(() => {
    const ids = new Set(shown.map((n) => n.id))
    if (menuId !== null && !ids.has(menuId)) setMenuId(null)
    if (editingId !== null && !ids.has(editingId)) setEditingId(null)
  }, [shown, menuId, editingId])

  if (shown.length === 0) return null

  // Each shown root + its full subtree (any depth, DFS order from thread-card).
  const trees = shown.map((root) => ({ root, subs: subtreeRows(root.id, graph) }))

  // Collapse to bare dots only when the conversation is idle AND nothing in the
  // shown trees (roots OR descendants) is working; hover/focus expands via CSS.
  const anyWorking = trees.some(({ root, subs }) => isWorking(root) || subs.some(isWorking))
  const collapsed = idle && !anyWorking

  const startEdit = (node: GraphNode) => {
    setMenuId(null)
    setEditingId(node.id)
    // Seed from the raw override/label (bypass deriveLabel truncation so editing a long label doesn't bake in the "…").
    setDraft(sideState.get(node.id)?.labelOverride ?? node.label ?? node.id)
  }
  const commitEdit = () => {
    if (editingId && draft.trim()) onRename(editingId, draft.trim())
    setEditingId(null)
  }

  // Running visible-row index for the entrance stagger (roots + sub-rows).
  let rowIndex = 0

  return (
    <div className="wt-wrap">
      <div
        ref={rootRef}
        className="wt"
        data-collapsed={collapsed}
        role="list"
        aria-label={`Work tree (${shown.length})`}
      >
        {trees.map(({ root, subs }) => {
          const hue = sideState.get(root.id)?.hue ?? nodeHue(root)
          const kind = statusOf(root)
          const label = labelFor(root, sideState)
          const attached = root.attached === true
          const pinned = root.id === targetThreadId
          const editing = editingId === root.id
          const live = kind === "working" || kind === "waiting" ? activity.get(root.id)?.activity : undefined
          const openLabel = `Open thread: ${label} — ${kind}`
          const index = rowIndex++
          return (
            <Fragment key={root.id}>
              <div
                role="listitem"
                className="wt__item wt__item--root"
                style={
                  {
                    ["--wt-hue" as string]: String(hue),
                    ["--wt-i" as string]: String(index),
                  } as CSSProperties
                }
                data-status={kind}
                data-attached={attached}
                data-pinned={pinned}
              >
                <div className="wt__row">
                  <span
                    className={`wt__dot${attached ? " wt__dot--attached" : ""}`}
                    aria-hidden="true"
                  >
                    {attached && <ArrowLeftRight size={8} className="wt__attach-glyph" />}
                  </span>

                  {editing ? (
                    <input
                      className="wt__edit"
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={commitEdit}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitEdit()
                        else if (e.key === "Escape") setEditingId(null)
                      }}
                      aria-label="Rename thread"
                    />
                  ) : (
                    <button
                      className="wt__label"
                      onClick={() => onOpenThread(root.id)}
                      aria-label={openLabel}
                      title={openLabel}
                    >
                      {label}
                    </button>
                  )}

                  {pinned && !editing && (
                    <Target size={11} className="wt__pin" aria-label="Route target" />
                  )}

                  {!editing && (
                    <button
                      className="wt__more"
                      aria-label={`Actions for ${label}`}
                      aria-haspopup="menu"
                      aria-expanded={menuId === root.id}
                      onClick={() => setMenuId((cur) => (cur === root.id ? null : root.id))}
                    >
                      <MoreHorizontal size={14} />
                    </button>
                  )}
                </div>

                {live ? (
                  <span className="wt__live wt__live--root" key={live}>
                    {live}
                  </span>
                ) : null}

                {menuId === root.id && (
                  <div className="wt__menu" role="menu">
                    <button
                      role="menuitem"
                      className="wt__menu-item"
                      data-active={pinned}
                      onClick={() => {
                        onSelectTarget(pinned ? null : root.id)
                        setMenuId(null)
                      }}
                    >
                      <Target size={13} />
                      {pinned ? "Unpin route target" : "Pin as route target"}
                    </button>
                    <button
                      role="menuitem"
                      className="wt__menu-item"
                      onClick={() => startEdit(root)}
                    >
                      <Pencil size={13} /> Rename
                    </button>
                    <button
                      role="menuitem"
                      className="wt__menu-item"
                      onClick={() => {
                        onDismiss(root.id)
                        setMenuId(null)
                      }}
                    >
                      <X size={13} /> Dismiss
                    </button>
                  </div>
                )}
              </div>

              {subs.map((node) => (
                <SubRow
                  key={node.id}
                  node={node}
                  baseDepth={root.depth}
                  index={rowIndex++}
                  sideState={sideState}
                  activity={activity}
                  onOpenThread={onOpenThread}
                />
              ))}
            </Fragment>
          )
        })}

        {overflow > 0 && (
          <div
            className="wt__overflow"
            role="listitem"
            aria-label={`${overflow} more`}
            style={{ ["--wt-i" as string]: String(rowIndex) } as CSSProperties}
          >
            +{overflow}
          </div>
        )}
      </div>
    </div>
  )
}
