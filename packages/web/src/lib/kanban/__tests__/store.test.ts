import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendTicketNote, createTicket, loadTickets, saveTickets } from '../store'

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('appendTicketNote', () => {
  it('appends a timestamped update to an existing description', () => {
    const result = appendTicketNote(
      'Original context',
      'Need follow-up before dispatch.',
      new Date('2026-06-22T22:14:00.000Z'),
    )

    expect(result).toBe(
      'Original context\n\nUpdate (2026-06-22T22:14:00.000Z)\nNeed follow-up before dispatch.',
    )
  })

  it('creates a description from a note when the ticket was empty', () => {
    const result = appendTicketNote(
      '',
      'Fresh note',
      new Date('2026-06-22T22:14:00.000Z'),
    )

    expect(result).toBe('Update (2026-06-22T22:14:00.000Z)\nFresh note')
  })
})

describe('kanban board version metadata', () => {
  it('seeds new tickets with a base version timestamp', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_789_000_000_000)

    const store = createTicket({}, {
      title: 'New task',
      description: '',
      status: 'backlog',
      priority: 'medium',
      complexity: 'medium',
      assigneeId: null,
      department: 'software',
      departmentId: 'software',
    })
    const ticket = Object.values(store)[0]

    expect(ticket.updatedAt).toBe(1_789_000_000_000)
    expect(ticket.baseUpdatedAt).toBe(1_789_000_000_000)
  })

  it('keeps base version and session metadata through local storage', () => {
    saveTickets({
      'ticket-1': {
        id: 'ticket-1',
        title: 'Running task',
        description: '',
        status: 'in-progress',
        priority: 'medium',
        complexity: 'medium',
        assigneeId: 'worker',
        source: 'session',
        sessionId: 'session-1',
        department: 'software',
        workState: 'idle',
        createdAt: 1,
        updatedAt: 3,
        baseUpdatedAt: 2,
        departmentId: 'software',
      },
    })

    expect(loadTickets()['ticket-1']).toMatchObject({
      source: 'session',
      sessionId: 'session-1',
      baseUpdatedAt: 2,
    })
  })
})
