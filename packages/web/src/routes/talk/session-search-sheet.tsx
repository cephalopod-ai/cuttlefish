import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search, X, Send } from 'lucide-react'
import { api, type TalkSearchResponse } from '@/lib/api'
import { useTalkContext } from './talk-provider'
import { mapSearchResults, type SearchRowVM, type SnippetSegment } from './session-search'
import './session-search-sheet.css'

/**
 * Cuttlefish Talk — SessionSearchSheet (Task 12).
 *
 * A top sheet to find any session in the talk tree by title or message content
 * (FTS). Each row can be peeked, attached (observe), attached + briefed
 * (engage), or detached. Attach-state is derived from the LIVE talk graph
 * (mapSearchResults over graph nodes), so the sheet self-updates from talk:graph
 * WS deltas without re-fetching — we only disable a button while its request is
 * in flight and surface 4xx errors inline.
 */
interface SessionSearchSheetProps {
  open: boolean
  onClose: () => void
  /** Open the thread drawer for a session id. */
  onPeek: (sessionId: string) => void
}

export function SessionSearchSheet({ open, onClose, onPeek }: SessionSearchSheetProps) {
  const { orchestratorId, graph } = useTalkContext()
  const [query, setQuery] = useState('')
  const [resp, setResp] = useState<TalkSearchResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [searchErr, setSearchErr] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  // The element focused when the sheet opened (the top-bar search button), so
  // closing returns focus there instead of dropping it to <body> (a11y).
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  // Rows recompute whenever the raw response OR the live graph changes, so an
  // attach/detach delta flips a row's controls with no re-fetch.
  const rows = useMemo<SearchRowVM[]>(
    () => mapSearchResults(resp, graph),
    [resp, graph],
  )

  // Capture the trigger on open and restore focus to it on close (the component
  // stays mounted rendering null, so this fires on the open→false transition).
  useEffect(() => {
    if (open) {
      restoreFocusRef.current = document.activeElement as HTMLElement | null
      return
    }
    restoreFocusRef.current?.focus?.()
    restoreFocusRef.current = null
  }, [open])

  // Autofocus the input each time the sheet opens; reset transient state.
  useEffect(() => {
    if (!open) return
    setSearchErr(null)
    const id = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(id)
  }, [open])

  // Escape closes (capture so it wins over inner inputs).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  // Debounced search (300ms). Empty query clears results.
  useEffect(() => {
    if (!open) return
    const q = query.trim()
    if (!q) { setResp(null); setLoading(false); setSearchErr(null); return }
    setLoading(true)
    let cancelled = false
    const id = window.setTimeout(async () => {
      try {
        const r = await api.talkSearch(q)
        if (!cancelled) { setResp(r); setSearchErr(null) }
      } catch (e) {
        if (!cancelled) { setResp(null); setSearchErr(e instanceof Error ? e.message : 'Search failed') }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 300)
    return () => { cancelled = true; window.clearTimeout(id) }
  }, [open, query])

  if (!open) return null

  const q = query.trim()

  return (
    <div
      className="ssheet__backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search sessions"
        className="ssheet__panel"
      >
        {/* Search input row */}
        <div className="flex items-center gap-2 border-b border-[var(--separator)] px-4 py-3">
          <Search size={16} className="shrink-0 text-[var(--text-tertiary)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions…"
            aria-label="Search sessions"
            className="h-7 flex-1 bg-transparent text-[length:var(--text-subheadline)] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)]"
          />
          <button
            onClick={onClose}
            aria-label="Close search"
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] transition-colors active:bg-[var(--fill-secondary)]"
          >
            <X size={16} />
          </button>
        </div>

        <div className="ssheet__list">
          {loading ? (
            <Centered>Searching…</Centered>
          ) : searchErr ? (
            <Centered tone="error">{searchErr}</Centered>
          ) : !q ? (
            <Centered>Type to search your sessions</Centered>
          ) : rows.length === 0 ? (
            <Centered>No matches</Centered>
          ) : (
            <ul className="flex flex-col">
              {rows.map((row) => (
                <SearchRow
                  key={row.id}
                  row={row}
                  orchestratorId={orchestratorId}
                  onPeek={() => { onPeek(row.id); onClose() }}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

function Centered({ children, tone }: { children: React.ReactNode; tone?: 'error' }) {
  return (
    <div
      className={`px-4 py-10 text-center text-[length:var(--text-footnote)] ${
        tone === 'error' ? 'text-[var(--system-red)]' : 'text-[var(--text-tertiary)]'
      }`}
    >
      {children}
    </div>
  )
}

/** Render a parsed snippet with highlighted hit spans. */
function Snippet({ segments }: { segments: SnippetSegment[] }) {
  if (segments.length === 0) return null
  return (
    <p className="mt-0.5 line-clamp-2 text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
      {segments.map((seg, i) =>
        seg.hit ? (
          <mark key={i} className="rounded bg-[var(--accent-fill)] px-0.5 text-[var(--accent)]">
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </p>
  )
}

const rowBtn =
  'inline-flex h-7 items-center rounded-full border px-2.5 text-[length:var(--text-caption2)] transition-colors disabled:opacity-50'
const rowBtnIdle =
  'border-[var(--separator)] bg-[var(--material-regular)] text-[var(--text-secondary)] active:bg-[var(--fill-secondary)]'
const rowBtnAccent =
  'border-[var(--accent)] bg-[var(--accent-fill)] text-[var(--accent)] active:opacity-80'

function SearchRow({
  row,
  orchestratorId,
  onPeek,
}: {
  row: SearchRowVM
  orchestratorId: string | null
  onPeek: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [briefing, setBriefing] = useState(false)
  const [brief, setBrief] = useState('')

  const run = useCallback(
    async (action: () => Promise<unknown>): Promise<boolean> => {
      if (!orchestratorId || busy) return false
      setBusy(true)
      setErr(null)
      try {
        await action()
        // attachedState refreshes from the talk:graph WS delta (mapSearchResults).
        return true
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'Action failed')
        return false
      } finally {
        setBusy(false)
      }
    },
    [orchestratorId, busy],
  )

  const attachObserve = () =>
    run(() => api.talkDelegate({ sessionId: orchestratorId!, thread: row.id, attach: true, mode: 'observe' }))
  const detach = () =>
    run(() => api.talkDelegate({ sessionId: orchestratorId!, thread: row.id, detach: true }))
  const submitBrief = () => {
    const b = brief.trim()
    if (!b) return
    void run(() =>
      api.talkDelegate({
        sessionId: orchestratorId!,
        thread: row.id,
        attach: true,
        mode: 'engage',
        brief: b,
      }),
    ).then((ok) => { if (ok) { setBriefing(false); setBrief('') } })
  }

  const attached = row.attachedState !== null

  return (
    <li className="border-b border-[var(--separator)] px-4 py-3 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <button onClick={onPeek} className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[length:var(--text-subheadline)] text-[var(--text-primary)]">
              {row.title}
            </span>
            {row.isTalkChild && (
              <span className="shrink-0 rounded bg-[var(--fill-secondary)] px-1 text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
                talk
              </span>
            )}
          </div>
          {row.meta && (
            <p className="truncate text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
              {row.meta}
            </p>
          )}
          <Snippet segments={row.snippetSegments} />
        </button>
      </div>

      {/* Per-row actions */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button className={`${rowBtn} ${rowBtnIdle}`} onClick={onPeek}>
          Peek
        </button>
        {attached ? (
          <>
            <span className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
              ⇄ {row.attachedState === 'attached-engage' ? 'engaged' : 'observing'}
            </span>
            <button className={`${rowBtn} ${rowBtnIdle}`} disabled={busy} onClick={detach}>
              Detach
            </button>
          </>
        ) : (
          <>
            <button className={`${rowBtn} ${rowBtnIdle}`} disabled={busy} onClick={attachObserve}>
              Attach
            </button>
            <button
              className={`${rowBtn} ${rowBtnAccent}`}
              disabled={busy}
              onClick={() => setBriefing((v) => !v)}
              aria-expanded={briefing}
            >
              Attach + brief
            </button>
          </>
        )}
        {err && (
          <span className="text-[length:var(--text-caption2)] text-[var(--system-red)]">{err}</span>
        )}
      </div>

      {/* Engage brief input — revealed by "Attach + brief". */}
      {briefing && !attached && (
        <form
          onSubmit={(e) => { e.preventDefault(); submitBrief() }}
          className="mt-2 flex items-center gap-2"
        >
          <input
            autoFocus
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder="Brief for this session…"
            aria-label="Engage brief"
            disabled={busy}
            className="h-8 flex-1 rounded-full border border-[var(--separator)] bg-[var(--material-regular)] px-3 text-[length:var(--text-caption1)] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)] focus:border-[var(--accent)]"
          />
          <button
            type="submit"
            aria-label="Attach and send brief"
            disabled={busy || !brief.trim()}
            className="inline-flex size-8 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-contrast)] transition-opacity disabled:opacity-50"
          >
            <Send size={14} />
          </button>
        </form>
      )}
    </li>
  )
}
