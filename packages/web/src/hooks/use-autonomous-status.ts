import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

export interface AutonomousModeStatus {
  active: boolean
  projectLabel: string | null
  authorizationsToday: number
}

function parseAutonomousMode(raw: unknown): AutonomousModeStatus {
  const value = raw && typeof raw === 'object'
    ? ((raw as Record<string, unknown>).autonomousMode as Record<string, unknown> | undefined)
    : undefined
  return {
    active: value?.active === true,
    projectLabel: typeof value?.projectLabel === 'string' ? value.projectLabel : null,
    authorizationsToday: typeof value?.authorizationsToday === 'number' ? value.authorizationsToday : 0,
  }
}

/**
 * Polls GET /api/status for the autonomous-authorization-mode banner — see
 * the gateway's autonomous-mode.ts module docblock for what the feature is.
 * `active: true` here is expected and correct whenever the operator has
 * opted a project into it; it is not an error state to suppress.
 */
export function useAutonomousStatus() {
  const query = useQuery({
    queryKey: queryKeys.status,
    queryFn: () => api.getStatus(),
    refetchInterval: 30_000,
  })
  return { ...query, autonomousMode: parseAutonomousMode(query.data) }
}
