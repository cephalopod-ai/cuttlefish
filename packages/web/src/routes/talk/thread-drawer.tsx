import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react"
import { Send, X } from "lucide-react"
import { useSessionChat } from "@/routes/talk/use-session-chat"
import { ChatMessages } from "@/components/chat/chat-messages"
import { api } from "@/lib/api"
import { useTalkContext } from "./talk-provider"
import type { AttachedState } from "./session-search"
import type { GraphNode } from "./graph-store"
import { childrenOf } from "./graph-store"
import { statusOf } from "./thread-card"
import { channelHue } from "./channel-identity"
import { deriveLabel, type DockSideMap } from "./work-dock-layout"
import { DURATION } from "./motion"
import "./thread-drawer.css"

/**
 * Thread drawer — right-edge slide-in for any session (a COO child, an
 * employee, or a soft-linked attachment). Replaces the old centered peek
 * modal: the conversation stays visible behind a light scrim, a breadcrumb
 * path (AURA ▸ Lead ▸ Analyst) shows where this thread sits in the delegation
 * tree, and a Sub-threads strip lets you DESCEND into nested sessions.
 *
 * Reuses the main chat's <ChatMessages> renderer so bubbles, tool groups,
 * markdown, file links and media look identical to the primary chat.
 *
 * Beyond read-only viewing it carries the attach controls: Attach (observe) /
 * Attach (engage) / Detach in the header, derived from this session's state in
 * the live talk graph, plus an engage composer (visible only while attached in
 * engage mode) for sending follow-ups.
 *
 * Self-contained: pass a sessionId (null → closed). Wiring (which session to
 * show, breadcrumb/descend navigation) is the caller's job via onNavigate.
 * Orchestrator id + graph come from context.
 */

export interface ThreadDrawerProps {
  sessionId: string | null // null → closed
  onClose: () => void
  /** Navigate the drawer to another session (breadcrumb up / child descend). */
  onNavigate: (id: string) => void
  /** User rename overrides (WorkTree's source) so drawer labels match the tree. */
  sideState?: DockSideMap
}

/** What counts as tabbable for the minimal focus trap. */
const FOCUSABLE =
  'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])'

/** Human label for the drawer header: session title → employee → short id. */
function headerLabel(
  session: Record<string, unknown> | undefined,
  sessionId: string | null,
): string {
  const title = typeof session?.title === "string" ? session.title.trim() : ""
  if (title) return title
  const employee = typeof session?.employee === "string" ? session.employee.trim() : ""
  if (employee) return employee
  if (sessionId) return `Session ${sessionId.slice(0, 8)}`
  return "Conversation"
}

/**
 * Walk parentId links from `id` upward (cycle-guarded), root-first. The talk
 * root itself is NOT a graph node — the chain stops when a parentId points
 * outside the graph, and that boundary is the "AURA" crumb.
 */
function ancestorChain(graph: GraphNode[], id: string): GraphNode[] {
  const byId = new Map(graph.map((n) => [n.id, n]))
  const chain: GraphNode[] = []
  const seen = new Set<string>()
  let cur = byId.get(id)
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    chain.unshift(cur)
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return chain
}

export function ThreadDrawer({ sessionId, onClose, onNavigate, sideState }: ThreadDrawerProps) {
  // The session whose content is mounted — kept through the exit animation so
  // the panel has something to show while sliding out. Starts null even when
  // sessionId is set: mounting via the effect below guarantees the trigger
  // element is captured for focus restore BEFORE the panel steals focus.
  const [mountedId, setMountedId] = useState<string | null>(null)
  // Drives the slide transition: mount with data-open=false, flip next frame.
  const [open, setOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement | null>(null)
  // The element focused when the drawer opened (mirrors session-search-sheet's
  // restoreFocusRef) — closing returns focus there instead of dropping to <body>.
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  // Restore focus once the exit finishes (mountedId → null), and on unmount.
  // Defined BEFORE the capture effect below: on the very first mount both run
  // with mountedId null, and this one must see the ref still empty (no-op)
  // rather than wipe a just-captured trigger.
  useEffect(() => {
    if (mountedId) return
    const el = restoreFocusRef.current
    restoreFocusRef.current = null
    el?.focus?.()
  }, [mountedId])
  useEffect(
    () => () => {
      restoreFocusRef.current?.focus?.()
      restoreFocusRef.current = null
    },
    [],
  )

  useEffect(() => {
    if (sessionId) {
      // Capture the trigger only on closed→open (navigating while open would
      // otherwise re-capture an element inside the drawer itself).
      if (!restoreFocusRef.current) {
        restoreFocusRef.current = document.activeElement as HTMLElement | null
      }
      setMountedId(sessionId)
      // Flip after mount so the closed→open transition actually plays.
      const raf = requestAnimationFrame(() => setOpen(true))
      return () => cancelAnimationFrame(raf)
    }
    setOpen(false)
  }, [sessionId])

  // Exit: unmount on the panel's transform transitionend; fallback timeout for
  // environments where it never fires (reduced motion, jsdom).
  useEffect(() => {
    if (sessionId || !mountedId) return
    const panel = panelRef.current
    const done = () => setMountedId(null)
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false
    // Backstop only — must stay ≥ --motion-hero (500ms) or the panel pops mid-slide.
    const timer = window.setTimeout(done, reduced ? 50 : DURATION.slow)
    const onEnd = (e: TransitionEvent) => {
      if (e.target === panel && e.propertyName === "transform") done()
    }
    panel?.addEventListener("transitionend", onEnd)
    return () => {
      window.clearTimeout(timer)
      panel?.removeEventListener("transitionend", onEnd)
    }
  }, [sessionId, mountedId])

  // Escape closes (capture so it wins over inner inputs).
  // NOTE: capture + stopPropagation swallows ALL Escapes while the drawer is
  // open — any future inline editing inside the drawer must hook BEFORE this.
  useEffect(() => {
    if (!sessionId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (e.isComposing) return // IME cancel must not close the drawer
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener("keydown", onKey, true)
    return () => document.removeEventListener("keydown", onKey, true)
  }, [sessionId, onClose])

  if (!mountedId) return null

  return (
    <>
      <div className="tdrawer-scrim" data-open={open} onClick={onClose} aria-hidden="true" />
      {/* key={mountedId} → navigating remounts the per-session content, playing
          the tdrawer-content-in animation and resetting per-session UI state. */}
      <DrawerPanel
        key={mountedId}
        sessionId={mountedId}
        open={open}
        panelRef={panelRef}
        onClose={onClose}
        onNavigate={onNavigate}
        sideState={sideState}
      />
    </>
  )
}

/** Panel is split out so useSessionChat only runs while the drawer is mounted. */
function DrawerPanel({
  sessionId,
  open,
  panelRef,
  onClose,
  onNavigate,
  sideState,
}: {
  sessionId: string
  open: boolean
  panelRef: RefObject<HTMLDivElement | null>
  onClose: () => void
  onNavigate: (id: string) => void
  sideState?: DockSideMap
}) {
  const { messages, streamingText, loading, session, isInitialLoading, error } =
    useSessionChat(sessionId)
  const label = headerLabel(session, sessionId)
  const hasContent = messages.length > 0 || !!streamingText || loading

  // Attach-state comes from the live talk graph (self-updates on talk:graph WS
  // deltas). null → not attached → show plain Attach buttons.
  const { orchestratorId, graph } = useTalkContext()
  const attachedState: AttachedState = useMemo(() => {
    const node = graph.find((n) => n.id === sessionId)
    if (node?.attached && (node.mode === 'observe' || node.mode === 'engage')) {
      return `attached-${node.mode}` as AttachedState
    }
    return null
  }, [graph, sessionId])

  // Same label derivation as WorkTree (rename override → cleaned/truncated) so
  // crumbs and child rows never disagree with the tree the user clicked in.
  const labelOf = useCallback(
    (n: GraphNode) => deriveLabel(sideState?.get(n.id)?.labelOverride ?? n.label),
    [sideState],
  )

  // Breadcrumbs: AURA ▸ ancestors (clickable) ▸ current. A node missing from
  // the graph (dismissed/aged out) falls back to AURA ▸ header label.
  const chain = useMemo(() => ancestorChain(graph, sessionId), [graph, sessionId])
  const ancestors = chain.slice(0, -1)
  const currentLabel = chain.length > 0 ? labelOf(chain[chain.length - 1]) : label

  const children = useMemo(() => childrenOf(graph, sessionId), [graph, sessionId])

  // Focus the panel on mount (and on navigate — the panel remounts per session).
  useEffect(() => {
    panelRef.current?.focus()
  }, [panelRef])

  // Minimal focus trap, honouring aria-modal: on Tab, if focus would leave the
  // panel, wrap to the first/last focusable element instead.
  const onTrapKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key !== "Tab") return
      const panel = panelRef.current
      if (!panel) return
      const focusables = panel.querySelectorAll<HTMLElement>(FOCUSABLE)
      if (focusables.length === 0) {
        e.preventDefault()
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      if (e.shiftKey) {
        if (active === first || active === panel) {
          e.preventDefault()
          last.focus()
        }
      } else if (active === last) {
        e.preventDefault()
        first.focus()
      }
    },
    [panelRef],
  )

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      className="tdrawer"
      data-open={open}
      onKeyDown={onTrapKeyDown}
    >
      <div className="tdrawer__header">
        <nav className="tdrawer__crumbs" aria-label="Thread path">
          <span className="tdrawer__crumb tdrawer__crumb--root">AURA</span>
          {ancestors.map((a) => (
            <Fragment key={a.id}>
              <span className="tdrawer__crumb-sep" aria-hidden="true">
                ▸
              </span>
              <button
                type="button"
                className="tdrawer__crumb tdrawer__crumb--link"
                onClick={() => onNavigate(a.id)}
              >
                {labelOf(a)}
              </button>
            </Fragment>
          ))}
          <span className="tdrawer__crumb-sep" aria-hidden="true">
            ▸
          </span>
          <span className="tdrawer__crumb tdrawer__crumb--current" aria-current="true">
            {currentLabel}
          </span>
        </nav>
        <button
          type="button"
          className="tdrawer__close"
          aria-label="Close"
          onClick={onClose}
        >
          <X size={16} />
        </button>
        <AttachControls
          orchestratorId={orchestratorId}
          targetId={sessionId}
          attachedState={attachedState}
        />
      </div>

      <div className="tdrawer__content">
        {children.length > 0 && (
          <div className="tdrawer__subs">
            {/* Label sits OUTSIDE the list element so role="list" contains only
                listitems; the list keeps its accessible name via aria-label. */}
            <span className="tdrawer__subs-label">Sub-threads</span>
            <div className="tdrawer__subs-list" role="list" aria-label="Sub-threads">
              {children.map((child) => (
                <ChildRow
                  key={child.id}
                  node={child}
                  label={labelOf(child)}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col bg-[var(--bg)]">
          {isInitialLoading ? (
            <div className="flex flex-1 items-center justify-center px-[var(--space-4)] py-[var(--space-8)] text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
              Loading conversation…
            </div>
          ) : error ? (
            <div className="flex flex-1 items-center justify-center px-[var(--space-4)] py-[var(--space-8)] text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
              Couldn’t load this conversation.
            </div>
          ) : !hasContent ? (
            <div className="flex flex-1 items-center justify-center px-[var(--space-4)] py-[var(--space-8)] text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
              No messages yet
            </div>
          ) : (
            // Reuse the main chat renderer verbatim — groupMessages + per-message
            // bubbles + markdown/file-links live inside ChatMessages. Now driven by
            // the shared live pipeline so it streams tokens + media in real time.
            <ChatMessages messages={messages} loading={loading} streamingText={streamingText} />
          )}
        </div>

        {/* Engage composer — only when attached in engage mode. A follow-up to an
            already-attached engage session can't go through talkDelegate (the
            attach path 400s "already attached", and the continue path 400s "not
            one of your COO threads" — attachments aren't owned children), so we
            post straight to the session message API, exactly as the backend's own
            continueThread relay does. */}
        {attachedState === 'attached-engage' && <EngageComposer targetId={sessionId} />}
      </div>
    </div>
  )
}

/** One row in the Sub-threads strip — hue dot, label, status pill; click descends. */
function ChildRow({
  node,
  label,
  onNavigate,
}: {
  node: GraphNode
  /** Display label — derived by the caller so it matches WorkTree (rename overrides). */
  label: string
  onNavigate: (id: string) => void
}) {
  const kind = statusOf(node)
  const hue = channelHue(node.label || node.id)
  return (
    <div role="listitem" className="tdrawer__sub" data-status={kind}>
      <button
        type="button"
        className="tdrawer__sub-btn"
        aria-label={`Open sub-thread: ${label} — ${kind}`}
        style={{ ["--td-hue" as string]: String(hue) } as CSSProperties}
        onClick={() => onNavigate(node.id)}
      >
        <span className="tdrawer__dot" aria-hidden="true" />
        <span className="tdrawer__sub-label">{label}</span>
        <span className="tdrawer__pill" data-kind={kind}>
          {kind}
        </span>
      </button>
    </div>
  )
}

const btnBase =
  'inline-flex h-7 items-center rounded-full border px-3 text-[length:var(--text-caption1)] transition-colors disabled:opacity-50'
const btnIdle =
  'border-[var(--separator)] bg-[var(--material-regular)] text-[var(--text-secondary)] active:bg-[var(--fill-secondary)]'
const btnAccent =
  'border-[var(--accent)] bg-[var(--accent-fill)] text-[var(--accent)] active:opacity-80'

/** Attach / detach controls reflecting the target's live talk-graph state. */
function AttachControls({
  orchestratorId,
  targetId,
  attachedState,
}: {
  orchestratorId: string | null
  targetId: string
  attachedState: AttachedState
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      if (!orchestratorId) return
      setBusy(true)
      setErr(null)
      try {
        await action()
        // No optimistic write — the talk:graph WS delta updates attachedState.
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'Action failed')
      } finally {
        setBusy(false)
      }
    },
    [orchestratorId],
  )

  if (!orchestratorId) return null

  const attach = (mode: 'observe' | 'engage') =>
    run(() => api.talkDelegate({ sessionId: orchestratorId, thread: targetId, attach: true, mode }))
  const detach = () =>
    run(() => api.talkDelegate({ sessionId: orchestratorId, thread: targetId, detach: true }))

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {attachedState === null ? (
        <>
          <button className={`${btnBase} ${btnIdle}`} disabled={busy} onClick={() => attach('observe')}>
            Attach
          </button>
          <button className={`${btnBase} ${btnAccent}`} disabled={busy} onClick={() => attach('engage')}>
            Attach + engage
          </button>
        </>
      ) : (
        <>
          <span className="inline-flex h-7 items-center gap-1 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
            ⇄ {attachedState === 'attached-engage' ? 'engaged' : 'observing'}
          </span>
          <button className={`${btnBase} ${btnIdle}`} disabled={busy} onClick={detach}>
            Detach
          </button>
        </>
      )}
      {err && (
        <span className="text-[length:var(--text-caption1)] text-[var(--system-red)]">{err}</span>
      )}
    </div>
  )
}

/** One-line composer that relays a follow-up to an attached engage session. */
function EngageComposer({ targetId }: { targetId: string }) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const send = useCallback(async () => {
    const message = draft.trim()
    if (!message || busy) return
    setBusy(true)
    setErr(null)
    try {
      // Plain session message API — NOT talkDelegate (see the comment at the
      // call site above for why both delegate paths 400 here).
      await api.sendMessage(targetId, { message })
      setDraft('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Send failed')
    } finally {
      setBusy(false)
    }
  }, [draft, busy, targetId])

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); void send() }}
      className="flex items-center gap-2 border-t border-[var(--separator)] bg-[var(--bg)] px-[var(--space-4)] py-[var(--space-3)]"
    >
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Message this session…"
        aria-label="Message this session"
        disabled={busy}
        className="h-9 flex-1 rounded-full border border-[var(--separator)] bg-[var(--material-regular)] px-4 text-[length:var(--text-footnote)] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)] focus:border-[var(--accent)]"
      />
      <button
        type="submit"
        aria-label="Send"
        disabled={busy || !draft.trim()}
        className="inline-flex size-9 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-contrast)] transition-opacity disabled:opacity-50"
      >
        <Send size={16} />
      </button>
      {err && (
        <span className="text-[length:var(--text-caption1)] text-[var(--system-red)]">{err}</span>
      )}
    </form>
  )
}
