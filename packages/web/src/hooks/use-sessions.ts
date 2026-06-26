import { useQuery, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import { api, type BackgroundActivity, type SessionsResponse } from '@/lib/api'

// The query cache holds the full SessionsResponse; both hooks below select from
// the same cached object so there is only ever one network request. Sidebar
// "load more" appends pages into `sessions` via queryClient.setQueryData.
//
// The default payload is only the top-N most-recent sessions per group (server
// SESSION_LIST_PER_GROUP=50). The sidebar augments it client-side via "load more"
// + live WS patches. A plain refetch would REPLACE that augmented cache with the
// bare top-N again, silently trimming everything the user paged in (and, in a busy
// org where session events fire every second, snapping the list back to the 50
// newest on a ~1s debounce). So every refetch MERGES the fresh top-N with the
// sessions already in cache, keyed by id — fresh rows win (newest status /
// activity), previously-loaded extras are preserved. Render-time sorting in the
// sidebar keeps the final order correct regardless of merge order.

const sessionId = (s: Record<string, unknown>) => s.id as string

/** Union the fresh top-N payload with already-cached sessions, fresh rows winning. */
export function mergeSessionsResponse(
  old: SessionsResponse | undefined,
  fresh: SessionsResponse,
): SessionsResponse {
  if (!old || old.sessions.length === 0) return fresh
  const freshIds = new Set(fresh.sessions.map(sessionId))
  const extras = old.sessions.filter((s) => !freshIds.has(sessionId(s)))
  if (extras.length === 0) return fresh
  return { ...fresh, sessions: [...fresh.sessions, ...extras] }
}

/** Shared, merge-on-refetch query fn so loaded pages survive every invalidation. */
function fetchAndMergeSessions(qc: QueryClient) {
  return async (): Promise<SessionsResponse> => {
    const fresh = await api.getSessions()
    const old = qc.getQueryData<SessionsResponse>(queryKeys.sessions.all)
    return mergeSessionsResponse(old, fresh)
  }
}

/** Surgically patch one cached row's backgroundActivity on a session:background
 *  WS event — no refetch, no invalidation (these can fire frequently while
 *  background agents work). Rows not in the cache are ignored; the next merge
 *  refetch will carry the field. */
export function patchSessionBackgroundActivity(
  qc: QueryClient,
  id: string,
  backgroundActivity: BackgroundActivity | null,
) {
  qc.setQueryData<SessionsResponse>(queryKeys.sessions.all, (old) => {
    if (!old) return old
    let changed = false
    const sessions = old.sessions.map((s) => {
      if (sessionId(s) !== id) return s
      changed = true
      return { ...s, backgroundActivity }
    })
    return changed ? { ...old, sessions } : old
  })
}

/** Drop sessions from the cached list immediately (deletes must beat the merge). */
export function removeFromSessionsCache(qc: QueryClient, ids: Iterable<string>) {
  const idSet = new Set(ids)
  qc.setQueryData<SessionsResponse>(queryKeys.sessions.all, (old) =>
    old ? { ...old, sessions: old.sessions.filter((s) => !idSet.has(sessionId(s))) } : old,
  )
}

export function useSessions() {
  const qc = useQueryClient()
  return useQuery({
    queryKey: queryKeys.sessions.all,
    queryFn: fetchAndMergeSessions(qc),
    select: (d: SessionsResponse) => d.sessions,
  })
}

export function useSessionCounts() {
  const qc = useQueryClient()
  return useQuery({
    queryKey: queryKeys.sessions.all,
    queryFn: fetchAndMergeSessions(qc),
    select: (d: SessionsResponse) => ({ counts: d.counts, perGroup: d.perGroup }),
  })
}

// Server-side search across ALL sessions (not just the loaded page). Enabled
// only when there's a query; results are short-lived since they reflect a search.
export function useSessionSearch(query: string) {
  const q = query.trim()
  return useQuery({
    queryKey: queryKeys.sessions.search(q),
    queryFn: () => api.searchSessions(q),
    enabled: q.length > 0,
    staleTime: 10_000,
  })
}

export function useUpdateSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: { title?: string } }) =>
      api.updateSession(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.sessions.all }),
    onError: () => qc.invalidateQueries({ queryKey: queryKeys.sessions.all }),
  })
}

export function useDeleteSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.deleteSession(id),
    // Drop the row before invalidating — otherwise the merge-on-refetch would
    // re-add it as a "previously loaded" extra and the delete wouldn't stick.
    onSuccess: (_data, id) => {
      removeFromSessionsCache(qc, [id])
      qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
    },
  })
}

export function useBulkDeleteSessions() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (ids: string[]) => api.bulkDeleteSessions(ids),
    onSuccess: (_data, ids) => {
      removeFromSessionsCache(qc, ids)
      qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
    },
  })
}

export function useDuplicateSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.duplicateSession(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.sessions.all }),
  })
}
