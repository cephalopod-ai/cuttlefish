import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60_000,
      gcTime: 15 * 60_000,
      // Resume safety nets: refetch REST-backed queries (sessions list, org, etc.)
      // when the tab regains focus or the network reconnects, so they recover from
      // a stale snapshot after a sleep/background just like the WS stream does. The
      // sessions query merges (rather than trims) loaded pages on refetch, so this
      // is safe. Mount refetch stays off to avoid churn on every component remount.
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      refetchOnMount: false,
      retry: 1,
    },
  },
})
