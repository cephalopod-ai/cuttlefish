import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

export function useCommandCenter() {
  return useQuery({
    queryKey: queryKeys.commandCenter.all,
    queryFn: () => api.getCommandCenter(),
    refetchInterval: 60_000,
  })
}
