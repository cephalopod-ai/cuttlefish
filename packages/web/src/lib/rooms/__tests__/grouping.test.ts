import { describe, it, expect } from 'vitest'
import {
  prettifyDeptName,
  isCronRoomSession,
  resolveSessionDepartment,
  groupSessionsByDepartment,
  buildEmployeeMap,
  buildRoomTimeline,
  indexSessionsById,
  deriveTarget,
  roomSelectionId,
  parseRoomSelection,
  totalRunning,
  UNASSIGNED_ROOM_ID,
} from '../grouping'
import type { RoomEmployee, RoomSession } from '../types'

const employees: RoomEmployee[] = [
  { name: 'gepetto', displayName: 'Gepetto', department: 'woodworking', emoji: '🪵' },
  { name: 'safety', displayName: 'Safety / Failure Review', department: 'woodworking' },
  { name: 'librarian', displayName: 'Research Librarian', department: 'research' },
  { name: 'printer', displayName: 'Printer Tech', department: '3d-printing' },
  // an employee with no department — should not anchor a room
  { name: 'drifter', displayName: 'Drifter' },
]

const empMap = buildEmployeeMap(employees)

function s(partial: Partial<RoomSession> & { id: string }): RoomSession {
  return { ...partial }
}

describe('prettifyDeptName', () => {
  it('title-cases simple slugs', () => {
    expect(prettifyDeptName('woodworking')).toBe('Woodworking')
  })
  it('upper-cases digit-leading tokens (3d → 3D)', () => {
    expect(prettifyDeptName('3d-printing')).toBe('3D Printing')
  })
  it('splits on -, _ and whitespace', () => {
    expect(prettifyDeptName('window_seat storage-dept')).toBe('Window Seat Storage Dept')
  })
  it('returns empty for blank input', () => {
    expect(prettifyDeptName('')).toBe('')
    expect(prettifyDeptName('   ')).toBe('')
  })
})

describe('isCronRoomSession', () => {
  it('detects cron by source', () => {
    expect(isCronRoomSession(s({ id: '1', source: 'cron' }))).toBe(true)
  })
  it('detects cron by sourceRef prefix', () => {
    expect(isCronRoomSession(s({ id: '1', source: 'web', sourceRef: 'cron:nightly' }))).toBe(true)
  })
  it('is false for normal web sessions', () => {
    expect(isCronRoomSession(s({ id: '1', source: 'web', sourceRef: 'web:abc' }))).toBe(false)
  })
})

describe('resolveSessionDepartment', () => {
  it('resolves via employee → department', () => {
    expect(resolveSessionDepartment(s({ id: '1', employee: 'gepetto' }), empMap)).toEqual({
      id: 'woodworking',
      name: 'Woodworking',
    })
  })
  it('returns null for an employee-less (direct) session', () => {
    expect(resolveSessionDepartment(s({ id: '1', employee: null }), empMap)).toBeNull()
  })
  it('returns null for an employee not in the roster', () => {
    expect(resolveSessionDepartment(s({ id: '1', employee: 'ghost' }), empMap)).toBeNull()
  })
  it('returns null for an employee with no department', () => {
    expect(resolveSessionDepartment(s({ id: '1', employee: 'drifter' }), empMap)).toBeNull()
  })
  it('returns null for cron sessions even with an employee', () => {
    expect(resolveSessionDepartment(s({ id: '1', employee: 'gepetto', source: 'cron' }), empMap)).toBeNull()
  })
})

describe('groupSessionsByDepartment', () => {
  const sessions: RoomSession[] = [
    s({ id: 'a', employee: 'gepetto', status: 'running', lastActivity: '2026-06-21T12:54:00Z', createdAt: '2026-06-21T12:40:00Z' }),
    s({ id: 'b', employee: 'safety', status: 'idle', lastActivity: '2026-06-21T12:46:00Z', createdAt: '2026-06-21T12:46:00Z' }),
    s({ id: 'c', employee: 'librarian', status: 'idle', lastActivity: '2026-06-21T10:18:00Z', createdAt: '2026-06-21T10:00:00Z' }),
    s({ id: 'd', employee: null, status: 'idle', lastActivity: '2026-06-21T09:00:00Z' }), // direct → Unassigned
    s({ id: 'e', employee: 'ghost', status: 'idle', lastActivity: '2026-06-21T08:00:00Z' }), // unknown → Unassigned
    s({ id: 'f', employee: 'gepetto', source: 'cron', sourceRef: 'cron:x', lastActivity: '2026-06-21T13:00:00Z' }), // cron → skipped
  ]
  const rooms = groupSessionsByDepartment(sessions, employees)

  it('creates one room per resolvable department plus Unassigned', () => {
    expect(rooms.map((r) => r.id)).toEqual(
      expect.arrayContaining(['woodworking', 'research', UNASSIGNED_ROOM_ID]),
    )
  })

  it('skips cron sessions entirely', () => {
    const wood = rooms.find((r) => r.id === 'woodworking')!
    expect(wood.sessions.map((x) => x.id).sort()).toEqual(['a', 'b'])
    expect(wood.sessions.some((x) => x.id === 'f')).toBe(false)
  })

  it('buckets direct + unknown-employee sessions into Unassigned', () => {
    const un = rooms.find((r) => r.id === UNASSIGNED_ROOM_ID)!
    expect(un.isUnassigned).toBe(true)
    expect(un.sessions.map((x) => x.id).sort()).toEqual(['d', 'e'])
  })

  it('orders rooms most-recently-active first with Unassigned last', () => {
    expect(rooms[0].id).toBe('woodworking') // 12:54
    expect(rooms[rooms.length - 1].id).toBe(UNASSIGNED_ROOM_ID)
  })

  it('marks a room active when any session is running/waiting', () => {
    expect(rooms.find((r) => r.id === 'woodworking')!.status).toBe('active')
    expect(rooms.find((r) => r.id === 'research')!.status).toBe('idle')
  })

  it('counts needs-attention sessions separately from running ones', () => {
    const withAttention = groupSessionsByDepartment(
      [
        s({ id: 'a', employee: 'gepetto', status: 'running' }),
        s({ id: 'b', employee: 'safety', status: 'waiting' }),
        s({ id: 'c', employee: 'gepetto', jobState: 'needs_attention', status: 'idle' }),
      ],
      employees,
    )
    const wood = withAttention.find((r) => r.id === 'woodworking')!
    expect(wood.runningCount).toBe(1)
    expect(wood.needsAttentionCount).toBe(2)
    expect(wood.status).toBe('active')
  })

  it('marks a room active from needs-attention alone, even with nothing running', () => {
    const rooms2 = groupSessionsByDepartment(
      [s({ id: 'a', employee: 'gepetto', status: 'waiting' })],
      employees,
    )
    expect(rooms2.find((r) => r.id === 'woodworking')!.status).toBe('active')
  })

  it('computes participants (distinct employees) and counts', () => {
    const wood = rooms.find((r) => r.id === 'woodworking')!
    expect(wood.participantCount).toBe(2)
    expect(wood.sessionCount).toBe(2)
    expect(wood.participants.map((p) => p.displayName).sort()).toEqual([
      'Gepetto',
      'Safety / Failure Review',
    ])
  })

  it('sorts a room\'s sessions newest-activity first', () => {
    const wood = rooms.find((r) => r.id === 'woodworking')!
    expect(wood.sessions.map((x) => x.id)).toEqual(['a', 'b'])
  })

  it('does not mutate the input array', () => {
    expect(sessions.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  })

  it('returns an empty list for no sessions', () => {
    expect(groupSessionsByDepartment([], employees)).toEqual([])
  })
})

describe('room selection ids', () => {
  it('round-trips a room id', () => {
    expect(parseRoomSelection(roomSelectionId('woodworking'))).toBe('woodworking')
  })
  it('returns null for a bare session id', () => {
    expect(parseRoomSelection('sess-123')).toBeNull()
  })
  it('returns null for an empty room id', () => {
    expect(parseRoomSelection('room:')).toBeNull()
    expect(parseRoomSelection(null)).toBeNull()
  })
})

describe('deriveTarget', () => {
  it('top-level session → @all', () => {
    expect(deriveTarget(s({ id: '1', employee: 'gepetto' }), empMap)).toEqual({ kind: 'all', label: 'all' })
  })
  it('child session resolves @parent agent when the parent is loaded', () => {
    const parent = s({ id: 'p', employee: 'gepetto' })
    const child = s({ id: 'c', employee: 'safety', parentSessionId: 'p' })
    const byId = indexSessionsById([parent, child])
    expect(deriveTarget(child, empMap, byId)).toEqual({ kind: 'agent', label: 'Gepetto', id: 'gepetto' })
  })
  it('child session falls back to @parent when the parent is not loaded', () => {
    const child = s({ id: 'c', employee: 'safety', parentSessionId: 'missing' })
    expect(deriveTarget(child, empMap)).toEqual({ kind: 'agent', label: 'parent', id: undefined })
  })
})

describe('buildRoomTimeline', () => {
  const sessions: RoomSession[] = [
    s({ id: 'a', employee: 'gepetto', title: 'First-pass concept', createdAt: '2026-06-21T12:40:00Z', lastActivity: '2026-06-21T12:40:00Z', status: 'idle' }),
    s({ id: 'b', employee: 'safety', title: 'Load-bearing review', parentSessionId: 'a', createdAt: '2026-06-21T12:46:00Z', lastActivity: '2026-06-21T12:46:00Z', status: 'running' }),
  ]
  const rooms = groupSessionsByDepartment(sessions, employees)
  const wood = rooms.find((r) => r.id === 'woodworking')!
  const byId = indexSessionsById(sessions)
  const timeline = buildRoomTimeline(wood, employees, byId)

  it('produces one entry per session, oldest-first', () => {
    expect(timeline.map((e) => e.id)).toEqual(['a', 'b'])
  })
  it('labels speaker from the employee displayName + raw slug key', () => {
    expect(timeline[0].speakerName).toBe('Gepetto')
    expect(timeline[0].speakerKey).toBe('gepetto')
    expect(timeline[0].speakerType).toBe('agent')
  })
  it('derives @all for the root and @parent-agent for the child', () => {
    expect(timeline[0].target).toEqual({ kind: 'all', label: 'all' })
    expect(timeline[1].target).toEqual({ kind: 'agent', label: 'Gepetto', id: 'gepetto' })
  })
  it('uses title as the headline', () => {
    expect(timeline[0].headline).toBe('First-pass concept')
  })
  it('falls back to prompt excerpt then a placeholder for the headline', () => {
    const room = groupSessionsByDepartment(
      [s({ id: 'x', employee: 'gepetto', promptExcerpt: 'do the thing' }), s({ id: 'y', employee: 'gepetto' })],
      employees,
    ).find((r) => r.id === 'woodworking')!
    const tl = buildRoomTimeline(room, employees)
    const byIdLocal = new Map(tl.map((e) => [e.id, e]))
    expect(byIdLocal.get('x')!.headline).toBe('do the thing')
    expect(byIdLocal.get('y')!.headline).toBe('(untitled session)')
  })
  it('labels an employee-less entry as a Direct user speaker', () => {
    const room = groupSessionsByDepartment([s({ id: 'z', employee: null })], employees).find(
      (r) => r.id === UNASSIGNED_ROOM_ID,
    )!
    const tl = buildRoomTimeline(room, employees)
    expect(tl[0].speakerType).toBe('user')
    expect(tl[0].speakerName).toBe('Direct')
  })
})

describe('totalRunning', () => {
  it('sums runningCount across rooms, excluding sessions only waiting on the operator', () => {
    const rooms = groupSessionsByDepartment(
      [
        s({ id: 'a', employee: 'gepetto', status: 'running' }),
        s({ id: 'b', employee: 'librarian', status: 'waiting' }),
        s({ id: 'c', employee: 'safety', status: 'idle' }),
      ],
      employees,
    )
    expect(totalRunning(rooms)).toBe(1)
  })
})
