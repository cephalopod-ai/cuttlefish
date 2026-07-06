import { describe, it, expect } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { mergeSessionsResponse, patchSessionBackgroundActivity } from '../use-sessions'
import { queryKeys } from '@/lib/query-keys'
import type { SessionsResponse } from '@/lib/api'
import type { PublicSession } from '@cuttlefish/contracts'

const session = (id: string, extra: Partial<PublicSession> = {}): PublicSession => ({ id, ...extra })

const resp = (
  sessions: PublicSession[],
  counts: Record<string, number> = {},
  perGroup = 8,
): SessionsResponse => ({ sessions, counts, perGroup })

describe('mergeSessionsResponse', () => {
  it('returns fresh as-is when there is no prior cache', () => {
    const fresh = resp([session('a'), session('b')])
    expect(mergeSessionsResponse(undefined, fresh)).toBe(fresh)
  })

  it('returns fresh as-is when prior cache is empty', () => {
    const fresh = resp([session('a')])
    expect(mergeSessionsResponse(resp([]), fresh)).toBe(fresh)
  })

  it('preserves previously-loaded extras not present in the fresh top-N', () => {
    // Simulates "load more" having paged in older sessions, then a refetch that
    // only returns the bounded top-N.
    const old = resp([session('a'), session('b'), session('c'), session('d')])
    const fresh = resp([session('a'), session('b')])
    const merged = mergeSessionsResponse(old, fresh)
    expect(merged.sessions.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('lets fresh rows win for ids present in both (newest status/activity)', () => {
    const old = resp([session('a', { status: 'idle' }), session('z', { status: 'idle' })])
    const fresh = resp([session('a', { status: 'running' })])
    const merged = mergeSessionsResponse(old, fresh)
    const a = merged.sessions.find((s) => s.id === 'a')
    expect(a?.status).toBe('running')
    // The extra-only session is preserved.
    expect(merged.sessions.find((s) => s.id === 'z')).toBeTruthy()
  })

  it('carries counts and perGroup from the fresh payload', () => {
    const old = resp([session('a')], { __direct__: 50 }, 8)
    const fresh = resp([session('a')], { __direct__: 51 }, 8)
    const merged = mergeSessionsResponse(old, fresh)
    expect(merged.counts.__direct__).toBe(51)
    expect(merged.perGroup).toBe(8)
  })

  it('does not duplicate ids that appear in both payloads', () => {
    const old = resp([session('a'), session('b')])
    const fresh = resp([session('a'), session('b')])
    const merged = mergeSessionsResponse(old, fresh)
    expect(merged.sessions.map((s) => s.id)).toEqual(['a', 'b'])
  })
})

describe('patchSessionBackgroundActivity', () => {
  const activity = { activeStreams: 2, lastActivityAt: '2026-06-10T00:00:00Z' }

  it('patches only the targeted row, in place, without a refetch', () => {
    const qc = new QueryClient()
    qc.setQueryData(queryKeys.sessions.all, resp([session('a'), session('b')]))

    patchSessionBackgroundActivity(qc, 'a', activity)

    const data = qc.getQueryData<SessionsResponse>(queryKeys.sessions.all)!
    expect(data.sessions.find((s) => s.id === 'a')?.backgroundActivity).toEqual(activity)
    expect(data.sessions.find((s) => s.id === 'b')?.backgroundActivity).toBeUndefined()
  })

  it('clears the row on the null (cleared) event', () => {
    const qc = new QueryClient()
    qc.setQueryData(
      queryKeys.sessions.all,
      resp([session('a', { backgroundActivity: activity })]),
    )

    patchSessionBackgroundActivity(qc, 'a', null)

    const data = qc.getQueryData<SessionsResponse>(queryKeys.sessions.all)!
    expect(data.sessions.find((s) => s.id === 'a')?.backgroundActivity).toBeNull()
  })

  it('is a no-op (same object) when the session is not in the cache', () => {
    const qc = new QueryClient()
    const initial = resp([session('a')])
    qc.setQueryData(queryKeys.sessions.all, initial)

    patchSessionBackgroundActivity(qc, 'missing', activity)

    expect(qc.getQueryData<SessionsResponse>(queryKeys.sessions.all)).toBe(initial)
  })

  it('does nothing when the cache is empty', () => {
    const qc = new QueryClient()
    patchSessionBackgroundActivity(qc, 'a', activity)
    expect(qc.getQueryData(queryKeys.sessions.all)).toBeUndefined()
  })
})
