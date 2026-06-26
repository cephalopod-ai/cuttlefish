import { useGateway } from '@/hooks/use-gateway'
import { useLiveSession } from '@/hooks/use-live-session'
import type { Message } from '@/lib/conversations'

/**
 * Read-only conversation loader for a single (child) session, used by the Talk
 * child-session modal. A thin wrapper over the shared `useLiveSession` (the same
 * live read pipeline the main chat uses) in `readOnly` mode — so the modal now
 * streams live tokens (session:delta), shows live media (session:attachment) and
 * the thinking spinner, instead of only refetching on terminal events. It pulls
 * `subscribe`/`connectionSeq` from the gateway itself, so callers just pass a
 * sessionId.
 */

export interface SessionMeta {
  id?: string
  title?: string
  employee?: string
  engine?: string
  model?: string
  status?: string
}

export interface SessionChatResult {
  messages: Message[]
  /** Streaming reply text (live, mid-turn). */
  streamingText: string
  /** A reply is in flight — drives the thinking indicator. */
  loading: boolean
  session: Record<string, unknown> | undefined
  /** The first fetch hasn't resolved yet (nothing loaded, no error). */
  isInitialLoading: boolean
  /** The load failed — surface an error state instead of hanging on "Loading…". */
  error: Error | null
}

export function useSessionChat(sessionId: string | null): SessionChatResult {
  const { subscribe, connectionSeq } = useGateway()
  const live = useLiveSession(sessionId, { subscribe, connectionSeq, readOnly: true })
  return {
    messages: live.messages,
    streamingText: live.streamingText,
    loading: live.loading,
    session: live.session ?? undefined,
    // Only "loading" before anything resolves AND no error — otherwise a failed
    // fetch (session=null, messages=[]) would hang on the spinner forever.
    isInitialLoading: live.session == null && live.messages.length === 0 && live.error == null,
    error: live.error,
  }
}
