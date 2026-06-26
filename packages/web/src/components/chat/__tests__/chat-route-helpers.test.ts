import { describe, it, expect } from 'vitest'
import { resolveDeepLink, mergeSidebarEmployees, bucketByDay, summarizeOlder, isFocusedSession } from '../chat-route-helpers'

describe('resolveDeepLink', () => {
  const link = (qs: string) => resolveDeepLink(new URLSearchParams(qs))

  it('maps ?session=<id> to a session deep-link', () => {
    expect(link('session=abc')).toEqual({ kind: 'session', id: 'abc' })
  })

  it('maps ?employee=<name> to an employee deep-link', () => {
    expect(link('employee=cuttlefish-dev')).toEqual({ kind: 'employee', name: 'cuttlefish-dev' })
  })

  it('gives session precedence when both params are present', () => {
    expect(link('session=abc&employee=cuttlefish-dev')).toEqual({ kind: 'session', id: 'abc' })
  })

  it('returns null when neither param is present', () => {
    expect(link('foo=bar')).toBeNull()
    expect(link('')).toBeNull()
  })

  it('ignores empty values', () => {
    expect(link('session=')).toBeNull()
    expect(link('employee=')).toBeNull()
  })

  it('ignores whitespace-only values and trims real ones', () => {
    expect(link('session=%20%20')).toBeNull()
    expect(link('employee=%20content-lead%20')).toEqual({ kind: 'employee', name: 'content-lead' })
  })

  it('falls back to employee when session is empty but employee is set', () => {
    expect(link('session=&employee=support-lead')).toEqual({ kind: 'employee', name: 'support-lead' })
  })
})

describe('mergeSidebarEmployees', () => {
  it('unions sessionful (first) with roster-only (after), de-duped', () => {
    expect(mergeSidebarEmployees(['a', 'b'], ['b', 'c', 'a', 'd'])).toEqual(['a', 'b', 'c', 'd'])
  })

  it('preserves session order first, then roster order for the rest', () => {
    expect(mergeSidebarEmployees(['b', 'a'], ['a', 'c', 'b'])).toEqual(['b', 'a', 'c'])
  })

  it('returns roster (deduped) when there are no sessionful employees', () => {
    expect(mergeSidebarEmployees([], ['x', 'y', 'x', 'z'])).toEqual(['x', 'y', 'z'])
  })

  it('returns sessionful (deduped) when roster is empty', () => {
    expect(mergeSidebarEmployees(['x', 'x', 'y'], [])).toEqual(['x', 'y'])
  })

  it('returns [] when both are empty', () => {
    expect(mergeSidebarEmployees([], [])).toEqual([])
  })

  it('drops falsy entries', () => {
    expect(mergeSidebarEmployees(['', 'a'], ['', 'b'])).toEqual(['a', 'b'])
  })

  it('does not mutate its inputs', () => {
    const sessionful = ['a']
    const roster = ['b']
    mergeSidebarEmployees(sessionful, roster)
    expect(sessionful).toEqual(['a'])
    expect(roster).toEqual(['b'])
  })
})

describe('bucketByDay', () => {
  // Mid-afternoon "now" so today has room on both sides of the boundary.
  const now = new Date(2026, 5, 14, 15, 30, 0) // 2026-06-14 15:30 local

  const at = (y: number, mo: number, d: number, h = 12, mi = 0) =>
    new Date(y, mo, d, h, mi).toISOString()

  it('buckets a timestamp earlier today as "today"', () => {
    expect(bucketByDay(at(2026, 5, 14, 0, 1), now)).toBe('today')
    expect(bucketByDay(at(2026, 5, 14, 15, 29), now)).toBe('today')
  })

  it('treats exactly local midnight today as "today" (inclusive boundary)', () => {
    expect(bucketByDay(at(2026, 5, 14, 0, 0), now)).toBe('today')
  })

  it('buckets yesterday as "yesterday"', () => {
    expect(bucketByDay(at(2026, 5, 13, 0, 0), now)).toBe('yesterday')
    expect(bucketByDay(at(2026, 5, 13, 23, 59), now)).toBe('yesterday')
  })

  it('buckets two-plus days ago as "older"', () => {
    expect(bucketByDay(at(2026, 5, 12, 23, 59), now)).toBe('older')
    expect(bucketByDay(at(2026, 5, 1), now)).toBe('older')
    expect(bucketByDay(at(2025, 11, 31), now)).toBe('older')
  })

  it('treats a future timestamp (clock skew) as "today"', () => {
    expect(bucketByDay(at(2026, 5, 14, 23, 59), now)).toBe('today')
    expect(bucketByDay(at(2026, 5, 20), now)).toBe('today')
  })

  it('falls back to "older" for empty / unparseable input', () => {
    expect(bucketByDay(undefined, now)).toBe('older')
    expect(bucketByDay('', now)).toBe('older')
    expect(bucketByDay('not-a-date', now)).toBe('older')
  })

  it('handles the month boundary (1st of month → prior month is older)', () => {
    const firstOfMonth = new Date(2026, 5, 1, 9, 0, 0) // 2026-06-01 09:00
    expect(bucketByDay(at(2026, 5, 1, 0, 0), firstOfMonth)).toBe('today')
    expect(bucketByDay(at(2026, 4, 31, 12, 0), firstOfMonth)).toBe('yesterday') // May 31
    expect(bucketByDay(at(2026, 4, 30, 12, 0), firstOfMonth)).toBe('older')
  })
})

describe('summarizeOlder', () => {
  it('older = total − recent, summed across groups; employees = groups with any older', () => {
    const totals = { 'a-dev': 10, 'b-lead': 4, 'c-ops': 2 }
    const recent = { 'a-dev': 3, 'b-lead': 4, 'c-ops': 0 }
    // older: a=7, b=0, c=2 → 9 chats across 2 employees (a, c)
    expect(summarizeOlder(totals, recent)).toEqual({ chats: 9, employees: 2 })
  })

  it('clamps negatives (recent can momentarily exceed a stale total)', () => {
    expect(summarizeOlder({ x: 2 }, { x: 5 })).toEqual({ chats: 0, employees: 0 })
  })

  it('treats a missing recent entry as zero recent', () => {
    expect(summarizeOlder({ x: 3 }, {})).toEqual({ chats: 3, employees: 1 })
  })

  it('excludes the direct/COO bucket from the employee count but keeps its chats', () => {
    const totals = { 'a-dev': 5, __direct__: 6 }
    const recent = { 'a-dev': 1, __direct__: 2 }
    // older: a-dev=4, direct=4 → 8 chats; only a-dev counts as an employee
    expect(summarizeOlder(totals, recent, new Set(['__direct__']))).toEqual({
      chats: 8,
      employees: 1,
    })
  })

  it('is empty when nothing is older', () => {
    expect(summarizeOlder({ a: 2, b: 1 }, { a: 2, b: 1 })).toEqual({ chats: 0, employees: 0 })
  })
})

describe('isFocusedSession', () => {
  it('includes top-level web / slack / talk conversations', () => {
    expect(isFocusedSession({ source: 'web' })).toBe(true)
    expect(isFocusedSession({ source: 'slack' })).toBe(true)
    expect(isFocusedSession({ source: 'talk' })).toBe(true)
    // a direct web chat the operator started with an employee (parentless)
    expect(isFocusedSession({ source: 'web', sourceRef: 'web:123', parentSessionId: null })).toBe(true)
  })

  it('hides delegated / spawned CHILD sessions (parentSessionId set)', () => {
    expect(isFocusedSession({ source: 'web', parentSessionId: 'abc123' })).toBe(false)
    // whitespace-only parent id is treated as empty (still focused)
    expect(isFocusedSession({ source: 'web', parentSessionId: '   ' })).toBe(true)
  })

  it('hides cron-triggered run sessions (by source or sourceRef marker)', () => {
    expect(isFocusedSession({ source: 'cron' })).toBe(false)
    expect(isFocusedSession({ source: 'web', sourceRef: 'cron:daily-report' })).toBe(false)
  })

  it('hides unknown / internal sources (allowlist)', () => {
    expect(isFocusedSession({ source: 'discord' })).toBe(false)
    expect(isFocusedSession({ source: 'whatsapp' })).toBe(false)
    expect(isFocusedSession({ source: 'agent' })).toBe(false)
    expect(isFocusedSession({})).toBe(false)
  })
})
