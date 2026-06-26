import { AlertTriangle, Check, Circle, Loader2 } from 'lucide-react'
import type { ChatBlock, JsonObject, JsonValue } from '@/lib/blocks'

function asRecord(value: JsonValue | undefined): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null
}

function asArray(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : []
}

function asText(value: JsonValue | undefined, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function isDoneStatus(status: string | undefined): boolean {
  return status === 'done' || status === 'completed'
}

export function statusMark(status: string | undefined) {
  if (isDoneStatus(status)) return <Check size={13} aria-hidden="true" className="text-[var(--text-tertiary)]" />
  if (status === 'running' || status === 'in_progress') {
    return <Loader2 size={13} aria-label="Running" className="animate-spin text-[var(--system-blue)]" />
  }
  if (status === 'error' || status === 'failed') return <AlertTriangle size={13} aria-label="Failed" className="text-[var(--system-red)]" />
  return <Circle size={7} aria-hidden="true" className="text-[var(--text-quaternary)]" />
}

const INLINE_MAX_WIDTH = 'max-w-[min(620px,calc(100vw_-_var(--space-10)))]'

export function ChatBlockInline({ block }: { block: ChatBlock }) {
  const all = asArray(block.payload.items)
  const items = all.slice(0, 6)
  const done = all.filter((raw) => isDoneStatus(asText(asRecord(raw)?.status))).length
  const hidden = all.length - items.length

  return (
    <div
      className={`grid min-w-0 ${INLINE_MAX_WIDTH} gap-1 py-0.5`}
      data-block-id={block.id}
      data-block-type={block.type}
    >
      <div className="flex items-center gap-1.5 px-0.5">
        <span className="text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-secondary)]">
          {block.title || 'Tasks'}
        </span>
        {all.length > 0 && (
          <span className="text-[length:var(--text-caption2)] text-[var(--text-quaternary)]">
            {done}/{all.length}
          </span>
        )}
      </div>
      {items.map((raw, index) => {
        const item = asRecord(raw) || {}
        const status = asText(item.status, 'queued')
        const doneItem = isDoneStatus(status)
        return (
          <div key={asText(item.id, String(index))} className="flex min-w-0 items-start gap-1.5 px-0.5">
            <span className="mt-[3px] grid size-3.5 shrink-0 place-items-center">{statusMark(status)}</span>
            <span
              className={[
                'min-w-0 break-words text-pretty text-[length:var(--text-footnote)]',
                doneItem ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-primary)]',
              ].join(' ')}
            >
              {asText(item.text, 'Untitled task')}
            </span>
          </div>
        )
      })}
      {hidden > 0 && (
        <div className="px-0.5 text-[length:var(--text-caption2)] text-[var(--text-quaternary)]">
          {hidden} more
        </div>
      )}
    </div>
  )
}
