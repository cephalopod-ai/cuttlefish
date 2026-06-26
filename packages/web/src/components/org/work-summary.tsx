import { Link } from 'react-router-dom'
import { useWork } from '@/hooks/use-work'
import type { WorkState } from '@/lib/api'

/**
 * Feature 2: a compact live strip of normalized work-state counts. Surfaces
 * "needs-human / blocked / running" at a glance; the waiting-on-human pill links
 * into the Feature 1 approvals queue so a stalled session is one click away.
 */

const ORDER: WorkState[] = ['running', 'queued', 'waiting_on_human', 'blocked', 'failed', 'completed']

const META: Record<WorkState, { label: string; dot: string }> = {
  running: { label: 'Running', dot: 'var(--system-green, #34c759)' },
  queued: { label: 'Queued', dot: 'var(--system-blue, #0a84ff)' },
  waiting_on_human: { label: 'Needs human', dot: 'var(--system-orange, #ff9500)' },
  blocked: { label: 'Blocked', dot: 'var(--system-red, #ff3b30)' },
  failed: { label: 'Failed', dot: 'var(--system-red, #ff3b30)' },
  completed: { label: 'Idle', dot: 'var(--text-tertiary, #8e8e93)' },
}

export function WorkSummary() {
  const { data } = useWork()
  if (!data) return null
  const { counts } = data

  return (
    <div className="flex flex-wrap items-center gap-2 px-1 py-2">
      {ORDER.map((state) => {
        const n = counts[state] ?? 0
        const meta = META[state]
        const pill = (
          <span
            className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs"
            style={{ opacity: n === 0 ? 0.45 : 1 }}
          >
            <span className="size-2 rounded-full" style={{ background: meta.dot }} />
            <span className="text-muted-foreground">{meta.label}</span>
            <span className="font-semibold tabular-nums">{n}</span>
          </span>
        )
        // The needs-human pill links into the approvals queue when non-empty.
        if (state === 'waiting_on_human' && n > 0) {
          return (
            <Link key={state} to="/approvals" className="hover:opacity-80" title="Review approvals">
              {pill}
            </Link>
          )
        }
        return <span key={state}>{pill}</span>
      })}
    </div>
  )
}
