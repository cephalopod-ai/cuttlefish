/**
 * useLiveSession — the live read pipeline for one gateway session.
 *
 * Extracted verbatim from ChatPane so it can be reused read-only by the Talk
 * child-session modal (which previously only refetched on terminal events and
 * thus never showed live streaming or live media). It owns:
 *   - the message list + the optimistic streaming-text bubble
 *   - the full WS event set (session:delta text/tool/context, :notification,
 *     :attachment, :interrupted, :stopped, :completed)
 *   - server load + reconcile (lib/conversations.reconcileMessages)
 *   - reconnect (connectionSeq) backfill + the dropped-completion watchdog
 *
 * ChatPane consumes the SAME hook for its read side and keeps its composer/send
 * on top, driving the optimistic write path through the small write API
 * (beginSend/failSend/appendLocal/reset). The modal passes `readOnly: true`,
 * which seeds `loading` from the session's running state and skips the
 * localStorage intermediate cache (that cache belongs to the editable pane).
 *
 * Behaviour for the editable (ChatPane) path is intended to be byte-for-byte
 * identical to the previous inline implementation.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { usePageVisibility } from '@/hooks/use-page-visibility'
import { api } from '@/lib/api'
import type { BackgroundActivity } from '@/lib/api'
import type { Message, MediaAttachment } from '@/lib/conversations'
import {
  clearIntermediateMessages,
  reconcileMessages,
} from '@/lib/conversations'
import { applyBlockEnvelopeToMessages, isBlockEnvelope, isChatBlock } from '@/lib/blocks'

type Listener = (event: string, payload: unknown) => void

/** After a reconnect, if a turn is still 'loading' but no delta has arrived for
 *  this long, assume the session:completed frame was dropped and reconcile from
 *  the server to clear a stuck spinner. */
export const COMPLETION_WATCHDOG_MS = 8000

/** Decide whether the post-reconnect watchdog should treat the turn as stuck
 *  (i.e. recover from a dropped completion). Pure for testing. */
export function shouldRecoverStuckTurn(args: {
  loading: boolean
  msSinceLastDelta: number
  serverStatus: string | undefined
  watchdogMs?: number
}): boolean {
  const watchdogMs = args.watchdogMs ?? COMPLETION_WATCHDOG_MS
  if (!args.loading) return false
  if (args.msSinceLastDelta < watchdogMs) return false
  return args.serverStatus !== 'running'
}

function appendStatusChunk(prev: string, next: string): string {
  if (!prev) return next
  if (!next) return prev
  if (next.startsWith('_') || prev.endsWith('_')) return `${prev}${next}`
  if (/^[,.:;!?)}\]"']/.test(next)) return `${prev}${next}`
  return `${prev} ${next}`
}

function capStatusText(text: string): string {
  return text.length > 500 ? `${text.slice(0, 499)}…` : text
}

export interface SessionMetaUpdate {
  engine?: string
  engineSessionId?: string
  model?: string
  title?: string
  employee?: string
}

export interface UseLiveSessionOptions {
  /** Gateway subscribe for WS events. */
  subscribe: (fn: Listener) => () => void
  /** Gateway connection seq — bumping it triggers reconnect backfill. */
  connectionSeq?: number
  /** Read-only consumers (the Talk modal) seed loading from running state and
   *  never write the localStorage intermediate cache. */
  readOnly?: boolean
  /** Initial optimistic message (just-created-from-new-chat user bubble). */
  pendingUserMessage?: Message
  /** Notified when session meta is loaded (sidebar/tab labels). */
  onMeta?: (meta: SessionMetaUpdate) => void
  /** Notified when a turn completes (sidebar refresh). */
  onRefresh?: () => void
}

export interface UseLiveSessionResult {
  messages: Message[]
  streamingText: string
  loading: boolean
  /** True only for the initial cold fetch of an uncached selected session. */
  hydrating: boolean
  session: Record<string, unknown> | null
  /** Set when the last load failed (so read-only consumers don't hang on a
   *  "Loading…" state forever). Cleared at the start of each load attempt. */
  error: Error | null
  liveContextTokens: number | null
  /** Background work (subagents/background tasks) still running while the
   *  session is officially idle. null = none. Seeded from the session fetch,
   *  kept live via the session:background WS event. */
  backgroundActivity: BackgroundActivity | null
  /** Re-load (reconcile) a session from the server. */
  reload: (id: string) => Promise<void>
  // --- write API (editable pane only) ---
  /** Optimistically append the user message + arm loading for a send. */
  beginSend: (userMsg: Message) => void
  /** A send failed: clear loading + append an error bubble. */
  failSend: (text: string) => void
  /** Append a local-only message (status replies, etc.). */
  appendLocal: (msg: Message) => void
  /** Clear the pane (new chat). */
  reset: () => void
}

const SESSION_SNAPSHOT_CACHE_MAX = 16
const SESSION_SNAPSHOT_CACHE_TTL_MS = 10 * 60 * 1000

interface LiveSessionSnapshot {
  messages: Message[]
  streamingText: string
  loading: boolean
  session: Record<string, unknown> | null
  liveContextTokens: number | null
  backgroundActivity: BackgroundActivity | null
  updatedAt: number
}

type SnapshotInput = Omit<LiveSessionSnapshot, 'updatedAt'>

const liveSessionSnapshotCache = new Map<string, LiveSessionSnapshot>()

function cloneMessages(messages: Message[]): Message[] {
  return messages.map((message) => ({ ...message }))
}

function pruneLiveSessionSnapshotCache(now = Date.now()) {
  for (const [id, snapshot] of liveSessionSnapshotCache) {
    if (now - snapshot.updatedAt > SESSION_SNAPSHOT_CACHE_TTL_MS) {
      liveSessionSnapshotCache.delete(id)
    }
  }

  while (liveSessionSnapshotCache.size > SESSION_SNAPSHOT_CACHE_MAX) {
    let oldestId: string | null = null
    let oldestAt = Infinity
    for (const [id, snapshot] of liveSessionSnapshotCache) {
      if (snapshot.updatedAt < oldestAt) {
        oldestAt = snapshot.updatedAt
        oldestId = id
      }
    }
    if (!oldestId) break
    liveSessionSnapshotCache.delete(oldestId)
  }
}

function readLiveSessionSnapshot(id: string): LiveSessionSnapshot | null {
  pruneLiveSessionSnapshotCache()
  const snapshot = liveSessionSnapshotCache.get(id)
  if (!snapshot) return null
  return {
    ...snapshot,
    messages: cloneMessages(snapshot.messages),
    session: snapshot.session ? { ...snapshot.session } : null,
    backgroundActivity: snapshot.backgroundActivity ? { ...snapshot.backgroundActivity } : null,
  }
}

function writeLiveSessionSnapshot(id: string, input: SnapshotInput) {
  if (!input.session && input.messages.length === 0 && !input.streamingText) return
  liveSessionSnapshotCache.set(id, {
    ...input,
    messages: cloneMessages(input.messages),
    session: input.session ? { ...input.session } : null,
    backgroundActivity: input.backgroundActivity ? { ...input.backgroundActivity } : null,
    updatedAt: Date.now(),
  })
  pruneLiveSessionSnapshotCache()
}

export function __clearLiveSessionSnapshotCacheForTests() {
  liveSessionSnapshotCache.clear()
}

export function __cacheLiveSessionSnapshotForTests(id: string, input: SnapshotInput) {
  writeLiveSessionSnapshot(id, input)
}

export function __getLiveSessionSnapshotCacheSizeForTests() {
  pruneLiveSessionSnapshotCache()
  return liveSessionSnapshotCache.size
}

export function useLiveSession(
  sessionId: string | null,
  opts: UseLiveSessionOptions,
): UseLiveSessionResult {
  const { subscribe, connectionSeq, readOnly = false } = opts
  const pageVisible = usePageVisibility()
  const initialSnapshotRef = useRef<LiveSessionSnapshot | null | undefined>(undefined)
  if (initialSnapshotRef.current === undefined) {
    initialSnapshotRef.current = sessionId ? readLiveSessionSnapshot(sessionId) : null
  }
  const initialSnapshot = initialSnapshotRef.current

  const [messages, setMessages] = useState<Message[]>(() =>
    opts.pendingUserMessage ? [opts.pendingUserMessage] : initialSnapshot?.messages ?? [],
  )
  // Seed loading=true when mounting with a pendingUserMessage (just-created new chat
  // where the OLD pane's setLoading(true) was lost in the remount). Otherwise the
  // thinking indicator wouldn't show until the first WS delta arrives.
  const [loading, setLoading] = useState<boolean>(() => !!opts.pendingUserMessage || initialSnapshot?.loading === true)
  const [hydrating, setHydrating] = useState<boolean>(() => Boolean(sessionId && !opts.pendingUserMessage && !initialSnapshot))
  const loadingRef = useRef(loading)
  useEffect(() => { loadingRef.current = loading }, [loading])
  const lastDeltaAtRef = useRef<number>(0)
  const streamingTextRef = useRef(initialSnapshot?.streamingText ?? '')
  const [streamingText, setStreamingText] = useState(initialSnapshot?.streamingText ?? '')
  const [liveContextTokens, setLiveContextTokens] = useState<number | null>(initialSnapshot?.liveContextTokens ?? null)
  const [backgroundActivity, setBackgroundActivity] = useState<BackgroundActivity | null>(initialSnapshot?.backgroundActivity ?? null)
  const intermediateStartRef = useRef<number>(-1)
  const statusMessageIdRef = useRef<string | null>(null)
  const [currentSession, setCurrentSession] = useState<Record<string, unknown> | null>(initialSnapshot?.session ?? null)
  const [loadError, setLoadError] = useState<Error | null>(null)
  const sessionIdRef = useRef(sessionId)
  const justCompletedAtRef = useRef<number>(0)
  const loadTokenRef = useRef(0)

  const readOnlyRef = useRef(readOnly)
  useEffect(() => { readOnlyRef.current = readOnly }, [readOnly])
  const onMetaRef = useRef(opts.onMeta)
  useEffect(() => { onMetaRef.current = opts.onMeta }, [opts.onMeta])
  const onRefreshRef = useRef(opts.onRefresh)
  useEffect(() => { onRefreshRef.current = opts.onRefresh }, [opts.onRefresh])

  useEffect(() => { sessionIdRef.current = sessionId }, [sessionId])

  const clearStatusMessage = useCallback(() => {
    const id = statusMessageIdRef.current
    if (!id) return
    statusMessageIdRef.current = null
    setMessages((prev) => prev.filter((m) => m.id !== id))
  }, [])

  const upsertStatusMessage = useCallback((raw: string) => {
    const text = raw.replace(/\s+/g, ' ').trim()
    if (!text) return
    const replace = /^(thinking:|plan:|grok retrying)/i.test(text)
    const now = Date.now()
    setMessages((prev) => {
      if (intermediateStartRef.current < 0) intermediateStartRef.current = prev.length
      const existingId = statusMessageIdRef.current
      const existing = existingId ? prev.find((m) => m.id === existingId) : undefined
      const previousThinking = existing?.content.match(/^Thinking:\s*(.*)$/i)?.[1] ?? ''
      const content = replace
        ? text
        : `Thinking: ${capStatusText(appendStatusChunk(previousThinking, text))}`
      if (existingId && prev.some((m) => m.id === existingId)) {
        return prev.map((m) => m.id === existingId ? { ...m, content, timestamp: now } : m)
      }
      const id = crypto.randomUUID()
      statusMessageIdRef.current = id
      return [
        ...prev,
        {
          id,
          role: 'notification' as const,
          content,
          timestamp: now,
        },
      ]
    })
  }, [])


  // Listen for session events via subscribe
  useEffect(() => {
    return subscribe((event, payload) => {
      const p = payload as Record<string, unknown>
      const sid = sessionIdRef.current
      if (!sid || p.sessionId !== sid) return

      if (event === 'session:started') {
        setLoading(true)
        setCurrentSession((prev) => prev ? { ...prev, status: 'running' } : prev)
      }

      if (event === 'session:delta') {
        lastDeltaAtRef.current = Date.now()
        // Read-only consumers have no send path to arm loading; a delta means
        // the session is actively running, so reflect that as the spinner.
        if (readOnlyRef.current) setLoading(true)
        const deltaType = String(p.type || 'text')

        if (deltaType === 'text') {
          clearStatusMessage()
          const chunk = String(p.content || '')
          streamingTextRef.current += chunk
          setStreamingText(streamingTextRef.current)
        } else if (deltaType === 'text_snapshot') {
          clearStatusMessage()
          const snapshot = String(p.content || '')
          if (snapshot.length >= streamingTextRef.current.length) {
            streamingTextRef.current = snapshot
            setStreamingText(snapshot)
          }
        } else if (deltaType === 'tool_use') {
          clearStatusMessage()
          if (streamingTextRef.current) {
            const flushed = streamingTextRef.current
            streamingTextRef.current = ''
            setStreamingText('')
            setMessages((prev) => {
              if (intermediateStartRef.current < 0) intermediateStartRef.current = prev.length
              const updated = [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: 'assistant' as const,
                  content: flushed,
                  timestamp: Date.now(),
                },
              ]
              return updated
            })
          }
          const toolName = String(p.toolName || 'tool')
          const toolId = typeof p.toolId === 'string' && p.toolId ? p.toolId : undefined
          setMessages((prev) => {
            if (intermediateStartRef.current < 0) intermediateStartRef.current = prev.length
            const updated = [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: 'assistant' as const,
                content: `Using ${toolName}`,
                timestamp: Date.now(),
                toolCall: toolName,
                ...(toolId ? { toolId } : {}),
              },
            ]
            return updated
          })
        } else if (deltaType === 'tool_result') {
          setMessages((prev) => {
            const updated = [...prev]
            const toolId = typeof p.toolId === 'string' && p.toolId ? p.toolId : undefined
            let targetIndex = -1
            if (toolId) {
              targetIndex = updated.findIndex((m) =>
                m.role === 'assistant' &&
                m.toolCall &&
                m.toolId === toolId &&
                !m.content.startsWith('Used '),
              )
            }
            if (targetIndex < 0) {
              for (let i = updated.length - 1; i >= 0; i--) {
                const m = updated[i]
                if (m.role === 'assistant' && m.toolCall && !m.content.startsWith('Used ')) {
                  targetIndex = i
                  break
                }
              }
            }
            if (targetIndex >= 0) {
              const target = updated[targetIndex]
              updated[targetIndex] = { ...target, content: `Used ${target.toolCall}` }
            }
            return updated
          })
        } else if (deltaType === 'block') {
          clearStatusMessage()
          const envelope = isBlockEnvelope(p.block) ? p.block : null
          if (!envelope) return
          if (streamingTextRef.current) {
            const flushed = streamingTextRef.current
            streamingTextRef.current = ''
            setStreamingText('')
            setMessages((prev) => {
              if (intermediateStartRef.current < 0) intermediateStartRef.current = prev.length
              return [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: 'assistant' as const,
                  content: flushed,
                  timestamp: Date.now(),
                },
              ]
            })
          }
          setMessages((prev) => {
            if (intermediateStartRef.current < 0) intermediateStartRef.current = prev.length
            return applyBlockEnvelopeToMessages(prev, envelope, String(p.content || ''), Date.now())
          })
        } else if (deltaType === 'context') {
          const n = Number(p.content)
          if (Number.isFinite(n) && n > 0) setLiveContextTokens(n)
        } else if (deltaType === 'status') {
          upsertStatusMessage(String(p.content || ''))
        }
      }

      if (event === 'session:notification') {
        const notifMessage = String(p.message || '')
        if (notifMessage) {
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'notification' as const,
              content: notifMessage,
              timestamp: Date.now(),
            },
          ])
        }
      }

      if (event === 'session:attachment') {
        const media = Array.isArray(p.media) ? (p.media as MediaAttachment[]) : []
        // Use the server's canonical message id so the next history fetch merges
        // (not duplicates) this message. Guard against re-append if the event fires twice.
        const attachmentId = typeof p.id === 'string' ? p.id : crypto.randomUUID()
        if (media.length > 0) {
          setMessages((prev) => {
            if (prev.some((m) => m.id === attachmentId)) return prev
            return [
              ...prev,
              {
                id: attachmentId,
                role: 'assistant' as const,
                content: String(p.content || ''),
                timestamp: p.timestamp ? Number(p.timestamp) : Date.now(),
                media,
              },
            ]
          })
        }
      }

      if (event === 'session:interrupted') {
        streamingTextRef.current = ''
        setStreamingText('')
        clearStatusMessage()
      }

      if (event === 'session:stopped') {
        setLoading(false)
        setStreamingText('')
        setLiveContextTokens(null)
        clearStatusMessage()
      }

      if (event === 'session:completed') {
        clearStatusMessage()
        const intermediateStart = intermediateStartRef.current
        streamingTextRef.current = ''
        setStreamingText('')
        setLoading(false)
        setLiveContextTokens(null)
        intermediateStartRef.current = -1
        justCompletedAtRef.current = Date.now()

        const completedSessionId = sid || (p.sessionId ? String(p.sessionId) : null)
        if (completedSessionId && !readOnlyRef.current) {
          clearIntermediateMessages(completedSessionId)
        }

        if (p.result) {
          const resultStr = String(p.result)
          setMessages((prev) => {
            const cleaned = [...prev]
            const turnStart = intermediateStart >= 0 ? Math.min(intermediateStart, cleaned.length) : cleaned.length
            const kept = cleaned.slice(0, turnStart)
            const preservedMedia = cleaned.slice(turnStart).filter((m) => m.media && m.media.length > 0)
            return [
              ...kept,
              ...preservedMedia,
              {
                id: crypto.randomUUID(),
                role: 'assistant' as const,
                content: resultStr,
                timestamp: Date.now(),
              },
            ]
          })
        }
        if (p.error && !p.result) {
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'assistant' as const,
              content: `Error: ${p.error}`,
              timestamp: Date.now(),
            },
          ])
        }
        // Refresh the current session record so post-turn fields (notably
        // lastContextTokens for the context meter, and status) update without a
        // manual reload. Light getSession only — does NOT touch messages (we just
        // set them above; loadSession would re-reconcile and could flicker).
        if (completedSessionId && completedSessionId === sid) {
          api.getSession(completedSessionId)
            .then((s) => setCurrentSession(s as Record<string, unknown>))
            .catch(() => { /* best-effort; next load will pick it up */ })
        }
        onRefreshRef.current?.()
      }

      if (event === 'session:background') {
        // Fired on every change, including the cleared case (null).
        setBackgroundActivity((p.backgroundActivity as BackgroundActivity | null) ?? null)
      }

      if (event === 'session:external-turn') {
        // The gateway persisted messages that did NOT come from a normal web
        // turn (e.g. the user typed in the CLI view). Reconcile from the
        // server via the same load path the completion watchdog uses.
        loadSession(sid)
      }
    })
  }, [subscribe])

  // Load session data
  const loadSession = useCallback(async (id: string, options?: { suppressHydrating?: boolean }) => {
    const myToken = ++loadTokenRef.current
    setLoadError(null) // fresh attempt
    if (!options?.suppressHydrating && !readLiveSessionSnapshot(id)) setHydrating(true)
    try {
      const session = (await api.getSession(id)) as Record<string, unknown>
      if (myToken !== loadTokenRef.current) {
        return
      }
      setHydrating(false)
      setCurrentSession(session)
      // Seed background-activity from the authoritative fetch (absent → null);
      // session:background WS events keep it live from here.
      setBackgroundActivity((session.backgroundActivity as BackgroundActivity | null) ?? null)
      const meta = {
        engine: session.engine ? String(session.engine) : undefined,
        engineSessionId: session.engineSessionId ? String(session.engineSessionId) : undefined,
        model: session.model ? String(session.model) : undefined,
        title: session.title ? String(session.title) : undefined,
        employee: session.employee ? String(session.employee) : undefined,
      }
      onMetaRef.current?.(meta)

      const history = session.messages || session.history || []
      const firstPartialIndex = Array.isArray(history)
        ? history.findIndex((m: Record<string, unknown>) => m.partial === true)
        : -1
      const backendMessages: Message[] = Array.isArray(history)
        ? history.map((m: Record<string, unknown>) => {
          const blocks = Array.isArray(m.blocks) ? m.blocks.filter(isChatBlock) : []
          return {
            // Preserve the server's stable message id so live-pushed messages
            // (e.g. attachments) merge/dedupe by id instead of duplicating.
            id: typeof m.id === 'string' ? m.id : crypto.randomUUID(),
            role: (m.role as 'user' | 'assistant' | 'notification') || 'assistant',
            content: String(m.content || m.text || ''),
            timestamp: m.timestamp ? Number(m.timestamp) : Date.now(),
            // A persisted mid-turn tool block carries its tool name so it renders as
            // a tool card on reload, matching the live stream.
            ...(typeof m.toolCall === 'string' && m.toolCall ? { toolCall: m.toolCall } : {}),
            ...(typeof m.toolId === 'string' && m.toolId ? { toolId: m.toolId } : {}),
            ...(Array.isArray(m.media) && m.media.length > 0
              ? { media: m.media as MediaAttachment[] }
              : {}),
            ...(blocks.length > 0
              ? { blocks }
              : {}),
          }
        })
        : []
      if (session.status === 'error' && session.lastError) {
        const lastMessage = backendMessages[backendMessages.length - 1]
        const errorText = `Error: ${String(session.lastError)}`
        if (!lastMessage || lastMessage.role !== 'assistant' || lastMessage.content !== errorText) {
          backendMessages.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: errorText,
            timestamp: Date.now(),
          })
        }
      }

      const isRunning = session.status === 'running'

      // Seed from authoritative running state for read-only views and for editable
      // views that did not initiate the turn locally (reload/tab switch/reconnect).
      if (readOnlyRef.current || (isRunning && Date.now() - justCompletedAtRef.current > 1000)) {
        setLoading(isRunning)
      }

      // A gateway restart marks the in-flight session "interrupted" — there is no
      // turn running anymore, but the WS session:completed/stopped event that would
      // normally clear the spinner died with the old gateway. Clear the stuck
      // loading state here so the conversation is immediately usable again; the
      // next message resumes the session via the engine's --resume.
      if (session.status === 'interrupted') {
        setLoading(false)
        streamingTextRef.current = ''
        setStreamingText('')
      }

      if (isRunning) {
        // The server now persists mid-turn partial blocks, so the backend snapshot
        // already carries in-progress output — no localStorage replay needed. This is
        // what makes a mid-turn refresh restore the streamed blocks on any device.
        intermediateStartRef.current = firstPartialIndex >= 0 ? firstPartialIndex : backendMessages.length
        setMessages((current) => {
          // If backend has FEWER messages than local, the backend snapshot is stale —
          // local already contains newer live blocks the server hasn't flushed yet (or
          // a stale-snapshot race during slow GET). Keep current.
          if (backendMessages.length < current.length) {
            return current
          }
          const next = backendMessages.length > 0 ? backendMessages : current
          return reconcileMessages(current, next)
        })
        // Loading state is owned by handleSend (sets true) + WS session:completed/stopped (sets false).
        // loadSession must NEVER set loading=true — a stale GET arriving after completion would
        // re-arm the spinner and stick (the WS completion event has already passed).
      } else {
        const hadLocalInFlightState =
          loadingRef.current ||
          Boolean(streamingTextRef.current) ||
          intermediateStartRef.current >= 0

        setLoading(false)
        streamingTextRef.current = ''
        setStreamingText('')
        setLiveContextTokens(null)
        if (!readOnlyRef.current) clearIntermediateMessages(id)
        intermediateStartRef.current = -1
        setMessages((current) => {
          // If backend has FEWER messages than local, the backend snapshot is stale —
          // local already contains streaming-completed messages not yet persisted.
          // Exception: if local was still in-flight (cached loading/streaming/partial
          // rows) and the server is now idle, the shorter backend is the canonical
          // collapsed history and must replace the stale mid-turn cache.
          if (backendMessages.length < current.length && !hadLocalInFlightState) {
            return current
          }
          const next = backendMessages.length > 0 ? backendMessages : current
          return reconcileMessages(current, next)
        })
      }
    } catch (err) {
      if (myToken !== loadTokenRef.current) return
      setHydrating(false)
      setMessages([])
      setCurrentSession(null)
      intermediateStartRef.current = -1
      setLoadError(err instanceof Error ? err : new Error("Failed to load session"))
    }
  }, [])

  // Load on session change
  useEffect(() => {
    if (!sessionId) {
      setMessages([])
      setLoading(false)
      setHydrating(false)
      setCurrentSession(null)
      setLoadError(null)
      setBackgroundActivity(null)
      statusMessageIdRef.current = null
      streamingTextRef.current = ''
      setStreamingText('')
      intermediateStartRef.current = -1
      return
    }
    const cached = readLiveSessionSnapshot(sessionId)
    const pending = opts.pendingUserMessage
    if (cached) {
      setMessages(cached.messages)
      setLoading(cached.loading)
      setCurrentSession(cached.session)
      setLoadError(null)
      setLiveContextTokens(cached.liveContextTokens)
      setBackgroundActivity(cached.backgroundActivity)
      streamingTextRef.current = cached.streamingText
      setStreamingText(cached.streamingText)
      setHydrating(false)
    } else if (pending) {
      setMessages([pending])
      setLoading(true)
      setCurrentSession(null)
      setLoadError(null)
      setLiveContextTokens(null)
      setBackgroundActivity(null)
      streamingTextRef.current = ''
      setStreamingText('')
      setHydrating(false)
    } else {
      setMessages([])
      setLoading(false)
      setCurrentSession(null)
      setLoadError(null)
      setLiveContextTokens(null)
      setHydrating(true)
    }
    // Don't carry the previous session's background indicator across a switch;
    // loadSession re-seeds it from the fresh fetch.
    if (!cached) setBackgroundActivity(null)
    // Clear streaming state immediately to avoid stale content flash on cold loads.
    if (!cached) {
      streamingTextRef.current = ''
      setStreamingText('')
    }
    // NOTE: do NOT setLoading(false) here. Loading is owned by handleSend (true) and
    // WS session:completed/stopped (false). Clearing here would clobber the lazy-init
    // loading=true set by useState() when this pane mounted with pendingUserMessage.
    loadSession(sessionId, { suppressHydrating: Boolean(pending && !cached) })
  }, [sessionId]) // loadSession is stable (useCallback with [] deps)

  // Reload on reconnect — only fires when WS genuinely reconnects (connectionSeq changes).
  // Reloads running AND interrupted sessions: a gateway restart marks the open session
  // "interrupted", and without a refetch the UI keeps a stuck spinner (the clearing
  // session:completed/stopped WS event died with the old gateway). Completed/idle
  // sessions don't need a refetch on every WS hiccup.
  // Debounced 300ms so a burst of connectionSeq bumps collapses into a single loadSession.
  useEffect(() => {
    if (!connectionSeq || !sessionIdRef.current) return
    const st = currentSession?.status
    // Also backfill when a turn is in flight LOCALLY (loadingRef): handleSend sets
    // loading=true without setting status='running' (status is only refreshed from
    // the server later), so a reconnect mid-turn would otherwise skip the backfill
    // and never recover the deltas missed while the socket was dead. Read via ref so
    // the effect still only re-runs on a real reconnect or status change.
    if (st !== 'running' && st !== 'interrupted' && !loadingRef.current) return
    const handle = setTimeout(() => {
      loadSession(sessionIdRef.current!)
    }, 300)
    return () => clearTimeout(handle)
  }, [connectionSeq, currentSession?.status]) // loadSession is stable; sessionIdRef.current is read at call time

  // Completion watchdog — recover from a DROPPED session:completed frame.
  // session:completed is a single point of failure: if that one WS frame dies with
  // a half-open socket right at completion, loading stays true forever (loadSession
  // deliberately won't clear it, and no other event will). After a reconnect, if
  // we're still loading and have been silent past the watchdog window, verify
  // against the server and clear the stuck spinner if the turn actually finished.
  useEffect(() => {
    if (!connectionSeq) return
    if (!loadingRef.current) return
    const id = sessionIdRef.current
    if (!id) return
    const timer = setTimeout(async () => {
      if (!loadingRef.current) return
      if (Date.now() - lastDeltaAtRef.current < COMPLETION_WATCHDOG_MS) return // still actively streaming
      try {
        const session = (await api.getSession(id)) as Record<string, unknown>
        if (shouldRecoverStuckTurn({
          loading: loadingRef.current,
          msSinceLastDelta: Date.now() - lastDeltaAtRef.current,
          serverStatus: session.status as string | undefined,
        })) {
          // Missed the terminal event — clear the stuck spinner and reconcile
          // messages from the authoritative server snapshot.
          setLoading(false)
          streamingTextRef.current = ''
          setStreamingText('')
          setLiveContextTokens(null)
          intermediateStartRef.current = -1
          await loadSession(id)
        }
      } catch {
        // best-effort; a later interaction will reconcile
      }
    }, COMPLETION_WATCHDOG_MS)
    return () => clearTimeout(timer)
  }, [connectionSeq]) // loadSession is stable; refs read at fire time

  // Poll while the UI thinks a turn is running. This covers the case where the
  // single terminal WS frame is dropped but the socket itself never reconnects,
  // so the reconnect-only watchdog above never gets a chance to reconcile.
  // Safety net only (deltas arrive over the WS), so it runs slow and pauses on
  // hidden tabs; returning to the tab re-arms it via the visibility dep.
  useEffect(() => {
    if (!loading) return
    if (!pageVisible) return
    const id = sessionIdRef.current
    if (!id) return
    const interval = setInterval(async () => {
      if (!loadingRef.current) return
      const currentId = sessionIdRef.current
      if (!currentId) return
      try {
        const session = (await api.getSession(currentId)) as Record<string, unknown>
        if (session.status !== 'running') {
          setLoading(false)
          streamingTextRef.current = ''
          setStreamingText('')
          setLiveContextTokens(null)
          intermediateStartRef.current = -1
          await loadSession(currentId)
        }
      } catch {
        // best-effort; normal WS/reconnect paths can still recover later
      }
    }, 30_000)
    return () => clearInterval(interval)
  }, [loading, loadSession, pageVisible])

  // --- write API (editable pane) ---
  const beginSend = useCallback((userMsg: Message) => {
    loadTokenRef.current += 1
    setMessages((prev) => {
      intermediateStartRef.current = prev.length + 1
      return [...prev, userMsg]
    })
    setLoading(true)
    // Mark fresh activity so the completion watchdog doesn't treat a just-sent
    // turn as "silent" if a reconnect lands before the first delta arrives.
    lastDeltaAtRef.current = Date.now()
  }, [])

  const failSend = useCallback((text: string) => {
    setLoading(false)
    setMessages((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        role: 'assistant' as const,
        content: text,
        timestamp: Date.now(),
      },
    ])
  }, [])

  const appendLocal = useCallback((msg: Message) => {
    setMessages((prev) => [...prev, msg])
  }, [])

  const reset = useCallback(() => {
    setMessages([])
    setLoading(false)
    setHydrating(false)
    setCurrentSession(null)
    setBackgroundActivity(null)
    streamingTextRef.current = ''
    setStreamingText('')
    intermediateStartRef.current = -1
  }, [])

  useEffect(() => {
    if (!sessionId) return
    writeLiveSessionSnapshot(sessionId, {
      messages,
      streamingText,
      loading,
      session: currentSession,
      liveContextTokens,
      backgroundActivity,
    })
  }, [sessionId, messages, streamingText, loading, currentSession, liveContextTokens, backgroundActivity])

  return {
    messages,
    streamingText,
    loading,
    hydrating,
    session: currentSession,
    error: loadError,
    liveContextTokens,
    backgroundActivity,
    reload: loadSession,
    beginSend,
    failSend,
    appendLocal,
    reset,
  }
}
