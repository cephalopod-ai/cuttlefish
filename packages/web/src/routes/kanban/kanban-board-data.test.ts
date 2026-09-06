import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DepartmentBoardResponse, DepartmentBoardTicket } from '@/lib/api'
import type { KanbanStore } from '@/lib/kanban/store'
import { loadDepartmentBoards, buildDepartmentBoardSaveRequests } from './kanban-board-data'

const now = Date.parse('2026-09-06T10:00:00Z')
const ticket = (overrides: Record<string, unknown> = {}): DepartmentBoardTicket => ({
  id: 'valid', title: 'Valid ticket', status: 'todo', priority: 'medium',
  createdAt: '2026-09-05T10:00:00Z', updatedAt: '2026-09-05T10:00:00Z', ...overrides,
} as DepartmentBoardTicket)
const board = (tickets = [ticket()], deletedTickets: DepartmentBoardTicket[] = []): DepartmentBoardResponse => ({ tickets, deletedTickets, retentionDays: 3 })

afterEach(() => vi.restoreAllMocks())

describe('malformed board isolation (H4)', () => {
  it.each(['unrecognized', 'constructor', '__proto__', 'toString'])('keeps valid siblings when status is %s and protects incomplete boards from saves', async (status) => {
    const loaded = await loadDepartmentBoards(['engineering', 'marketing'], async (department) => department === 'engineering'
      ? board([ticket({ id: 'before' }), ticket({ id: 'broken', status }), ticket({ id: 'after' })])
      : board([ticket({ id: 'other' })]))
    expect(Object.keys(loaded.boardTickets)).toEqual(['before', 'after', 'other'])
    expect(loaded.warnings.join(' ')).toContain('engineering/broken')
    expect(loaded.blockedDepartments).toEqual(['engineering'])
    expect(() => buildDepartmentBoardSaveRequests(loaded.boardTickets, [{ department: 'marketing' }, { department: 'engineering' }], {}, loaded.blockedDepartments)).toThrow(/engineering.*reload/i)
    expect(buildDepartmentBoardSaveRequests(loaded.boardTickets, [{ department: 'marketing' }], {}, loaded.blockedDepartments)).toHaveLength(1)
  })

  it('isolates a malformed deleted ticket while retaining valid active and deleted siblings', async () => {
    const loaded = await loadDepartmentBoards(['engineering'], async () => board([ticket()], [
      ticket({ id: 'bad-deleted', status: 'unknown', deletedAt: new Date(now).toISOString() }),
      ticket({ id: 'good-deleted', deletedAt: new Date(now - 1000).toISOString() }),
    ]))
    expect(Object.keys(loaded.boardTickets)).toEqual(['valid'])
    expect(loaded.deletedTickets.map(t => t.id)).toEqual(['good-deleted'])
    expect(loaded.warnings.join(' ')).toContain('bad-deleted')
  })

  it('isolates malformed records and board payloads without losing another department', async () => {
    const loaded = await loadDepartmentBoards(['broken', 'engineering'], async (department) => department === 'broken'
      ? { tickets: null, deletedTickets: [] } as unknown as DepartmentBoardResponse
      : board([null as unknown as DepartmentBoardTicket, ticket()]))
    expect(Object.keys(loaded.boardTickets)).toEqual(['valid'])
    expect(loaded.blockedDepartments).toEqual(['broken', 'engineering'])
    expect(loaded.warnings).toHaveLength(2)
  })

  it('protects failed loads but still permits a missing board to be created', async () => {
    const loaded = await loadDepartmentBoards(['missing', 'offline', 'good'], async (department) => {
      if (department === 'missing') throw new Error('HTTP 404')
      if (department === 'offline') throw new Error('HTTP 503')
      return board()
    })
    expect(loaded.blockedDepartments).toEqual(['offline'])
    expect(loaded.warnings).toEqual(['offline: HTTP 503'])
    expect(buildDepartmentBoardSaveRequests({}, [{ department: 'missing' }], {}, loaded.blockedDepartments)).toHaveLength(1)
  })

  it.each(['constructor', '__proto__', 'toString'])('defaults unknown priority and complexity %s to ordinary values', async (value) => {
    const loaded = await loadDepartmentBoards(['engineering'], async () => board([ticket({ priority: value, complexity: value })]))
    expect(loaded.boardTickets.valid).toMatchObject({ status: 'todo', priority: 'medium', complexity: 'medium' })
    expect(loaded.warnings).toEqual([])
  })
})

describe('save date safety', () => {
  const storeWith = (dates: Record<string, number | undefined>): KanbanStore => ({ valid: {
    id: 'valid', title: 'Valid ticket', description: '', status: 'todo', priority: 'medium', complexity: 'medium',
    assigneeId: null, department: 'engineering', departmentId: 'engineering', workState: 'idle',
    createdAt: now - 2000, updatedAt: now - 1000, baseUpdatedAt: now - 2000, ...dates,
  } })

  it.each([NaN, Infinity, -Infinity, 1e20])('falls back for invalid display timestamps %s while preserving a valid base', (value) => {
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const request = buildDepartmentBoardSaveRequests(storeWith({ createdAt: value, updatedAt: value }), [{ department: 'engineering' }], {})[0]
    expect(request.payload.tickets[0]).toMatchObject({ createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), baseUpdatedAt: new Date(now - 2000).toISOString() })
  })

  it.each([NaN, Infinity, -Infinity, 1e20])('rejects invalid base version %s without fabricating freshness', (value) => {
    expect(() => buildDepartmentBoardSaveRequests(storeWith({ baseUpdatedAt: value }), [{ department: 'engineering' }], {})).toThrow(/valid.*version.*reload/i)
  })

  it('preserves valid epoch timestamps instead of replacing them with the current time', () => {
    const saved = buildDepartmentBoardSaveRequests(storeWith({ createdAt: 0, updatedAt: 0, baseUpdatedAt: undefined }), [{ department: 'engineering' }], {})[0].payload.tickets[0]
    expect(saved).toMatchObject({ createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), baseUpdatedAt: new Date(0).toISOString() })
  })
})


describe('adversarial incomplete-data checks', () => {
  it.each([{ description: { text: 'bad' } }, { updatedAt: 'invalid' }])('isolates malformed rendered/version data %j', async (overrides) => {
    const loaded = await loadDepartmentBoards(['engineering'], async () => board([ticket(), ticket({ id: 'broken', ...overrides })]))
    expect(Object.keys(loaded.boardTickets)).toEqual(['valid'])
    expect(loaded.blockedDepartments).toEqual(['engineering'])
    expect(loaded.warnings.join(' ')).toContain('engineering/broken')
  })

  it.each([undefined, 'invalid'])('does not invent a deletion version for %s', async (deletedAt) => {
    const loaded = await loadDepartmentBoards(['engineering'], async () => board([ticket()], [ticket({ id: 'deleted', deletedAt })]))
    expect(loaded.deletedTickets).toEqual([])
    expect(loaded.blockedDepartments).toEqual(['engineering'])
  })

  it('does not lose prototype-named ticket IDs or fabricate restore intent', async () => {
    const loaded = await loadDepartmentBoards(['engineering'], async () => board([ticket({ id: '__proto__' }), ticket({ id: 'constructor' })]))
    expect(Object.keys(loaded.boardTickets)).toEqual(['__proto__', 'constructor'])
    const requests = buildDepartmentBoardSaveRequests(loaded.boardTickets, [{ department: 'engineering' }], {})
    expect(requests[0].payload.tickets).toHaveLength(2)
    for (const saved of requests[0].payload.tickets) expect(saved.deletedAt).toBeUndefined()
  })

  it('reports colliding IDs and protects both boards from whole-board data loss', async () => {
    const loaded = await loadDepartmentBoards(['engineering', 'marketing'], async () => board())
    expect(loaded.boardTickets.valid.departmentId).toBe('engineering')
    expect(new Set(loaded.blockedDepartments)).toEqual(new Set(['engineering', 'marketing']))
    expect(loaded.warnings.join(' ')).toContain('Duplicate ticket id')
  })

  it('preserves every valid status, exact version and deletion ordering', async () => {
    const statuses = ['backlog', 'todo', 'in_progress', 'in-progress', 'review', 'blocked', 'done']
    const loaded = await loadDepartmentBoards(['engineering'], async () => board(statuses.map(status => ticket({ id: status, status })), [
      ticket({ id: 'old', deletedAt: new Date(now - 2000).toISOString() }),
      ticket({ id: 'new', deletedAt: new Date(now - 1000).toISOString() }),
    ]))
    expect(Object.values(loaded.boardTickets).map(t => t.status)).toEqual(['backlog', 'todo', 'in-progress', 'in-progress', 'review', 'blocked', 'done'])
    expect(loaded.deletedTickets.map(t => t.id)).toEqual(['new', 'old'])
    expect(loaded.warnings).toEqual([])
    expect(loaded.blockedDepartments).toEqual([])
    const saved = buildDepartmentBoardSaveRequests(loaded.boardTickets, [{ department: 'engineering' }], loaded.departmentRetentionDays)[0]
    expect(saved.payload.tickets.every(t => t.baseUpdatedAt === undefined)).toBe(true)
  })
})


it('keeps loading when retention metadata cannot be converted to a number', async () => {
  const loaded = await loadDepartmentBoards(['engineering'], async () => ({ ...board(), retentionDays: { valueOf: null, toString: null } }) as unknown as DepartmentBoardResponse)
  expect(loaded.boardTickets.valid.title).toBe('Valid ticket')
  expect(loaded.retentionDays).toBe(3)
})

it('does not refetch or falsely flag duplicate department names', async () => {
  const fetchBoard = vi.fn(async () => board())
  const loaded = await loadDepartmentBoards(['engineering', 'engineering'], fetchBoard)
  expect(fetchBoard).toHaveBeenCalledTimes(1)
  expect(loaded.blockedDepartments).toEqual([])
})
