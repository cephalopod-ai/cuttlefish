import { Navigate, useLocation } from 'react-router-dom'
import { lazyRoute } from '@/lib/lazy-route'
import { useSettings } from '@/routes/settings-provider'
import { useTriageSummary } from '@/hooks/use-triage-summary'

const ChatPage = lazyRoute(() => import('./chat/page'), 'chat')

/**
 * Root-route "/" gate: when attention-aware landing is on and something in
 * the triage strip needs action, land on Command Center instead of Chat.
 * Deep links carrying a query string (e.g. "/?employee=boss" from the
 * Command Center chat shortcuts) always render Chat — they're an explicit
 * destination, not a bare landing.
 */
export default function LandingRoute() {
  const { settings } = useSettings()
  const location = useLocation()
  const triage = useTriageSummary()

  const hasQuery = location.search.length > 0
  const shouldRedirect =
    settings.attentionAwareLanding && !hasQuery && !triage.isLoading && triage.total > 0

  if (shouldRedirect) {
    return <Navigate to="/command" replace />
  }

  return <ChatPage />
}
