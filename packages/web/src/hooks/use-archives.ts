import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type CreateArchivePayload } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { removeFromSessionsCache } from '@/hooks/use-sessions'

export function useArchives() {
  return useQuery({
    queryKey: queryKeys.archives.all,
    queryFn: () => api.listArchives(),
  })
}

export function useArchive(id: string | null | undefined) {
  return useQuery({
    queryKey: id ? queryKeys.archives.detail(id) : [...queryKeys.archives.all, 'detail', 'missing'],
    queryFn: () => api.getArchive(id!),
    enabled: !!id,
  })
}

export function useCreateArchive() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: CreateArchivePayload) => api.createArchive(payload),
    onSuccess: (_archive, payload) => {
      removeFromSessionsCache(qc, payload.sessionIds)
      qc.invalidateQueries({ queryKey: queryKeys.archives.all })
      qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
    },
  })
}

export function useDeleteArchive() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.deleteArchive(id),
    onSuccess: (_data, id) => {
      qc.removeQueries({ queryKey: queryKeys.archives.detail(id) })
      qc.invalidateQueries({ queryKey: queryKeys.archives.all })
    },
  })
}
