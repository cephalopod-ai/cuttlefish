import { useQuery } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import { api } from '@/lib/api'

/** Feature 2: normalized work-state overview across all sessions. */
export function useWork() {
  return useQuery({
    queryKey: queryKeys.work.all,
    queryFn: () => api.getWork(),
    refetchOnWindowFocus: true,
  })
}
