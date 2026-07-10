import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

export function useEngineLimits() {
  return useQuery({
    queryKey: queryKeys.engineLimits.all,
    queryFn: () => api.getEngineLimits(),
    refetchInterval: 60_000,
  })
}
