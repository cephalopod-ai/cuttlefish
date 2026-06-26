import { useCallback, useState } from 'react'
import { api } from '@/lib/api'
import type { GraphNode } from './graph-store'

/**
 * Cuttlefish Talk — engage-attachment banner (Mission Control).
 *
 * A slim strip rendered in the grid's banner row (.talk-banner-row owns the
 * placement + padding), one row per LIVE engage attachment: "⇄ attached to
 * {label} — engage · Detach". Mounted by page.tsx only when
 * hasEngageAttachment(graph). Detach posts talkDelegate {detach:true};
 * the row disappears when the talk:graph "detached" delta drops the node.
 *
 * Observe attachments are intentionally NOT banner-worthy — they're passive.
 */
interface AttachBannerProps {
  /** The live talk graph (already filtered to nothing-or-some engage nodes). */
  graph: GraphNode[]
  /** The talk session id — the `sessionId` for the detach call. */
  orchestratorId: string | null
}

export function AttachBanner({ graph, orchestratorId }: AttachBannerProps) {
  const engaged = graph.filter((n) => n.attached === true && n.mode === 'engage')
  if (engaged.length === 0 || !orchestratorId) return null

  return (
    <div className="flex w-full flex-col items-center gap-1">
      {engaged.map((node) => (
        <AttachBannerRow key={node.id} node={node} orchestratorId={orchestratorId} />
      ))}
    </div>
  )
}

function AttachBannerRow({
  node,
  orchestratorId,
}: {
  node: GraphNode
  orchestratorId: string
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const label = node.label?.trim() || `Session ${node.id.slice(0, 8)}`

  const detach = useCallback(async () => {
    if (busy) return
    setBusy(true)
    setErr(null)
    try {
      await api.talkDelegate({ sessionId: orchestratorId, thread: node.id, detach: true })
      // Row removal is driven by the talk:graph "detached" delta.
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Detach failed')
      setBusy(false)
    }
  }, [busy, orchestratorId, node.id])

  return (
    <div className="talk-banner-pill inline-flex max-w-full items-center gap-2 rounded-full border border-[var(--accent)] bg-[var(--accent-fill)] px-3 py-1 text-[length:var(--text-caption1)] text-[var(--accent)] backdrop-blur-md">
      <span className="truncate">
        ⇄ attached to <span className="font-[var(--weight-semibold)]">{label}</span> — engage
      </span>
      <span className="text-[var(--text-quaternary)]">·</span>
      <button
        onClick={detach}
        disabled={busy}
        aria-label={`Detach from ${label}`}
        className="shrink-0 underline underline-offset-2 transition-opacity disabled:opacity-50"
      >
        Detach
      </button>
      {err && <span className="text-[var(--system-red)]">{err}</span>}
    </div>
  )
}
