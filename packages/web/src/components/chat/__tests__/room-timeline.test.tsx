import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { RoomTimeline } from '../room-timeline'
import {
  groupSessionsByDepartment,
  indexSessionsById,
  UNASSIGNED_ROOM_ID,
} from '@/lib/rooms/grouping'
import type { RoomEmployee, RoomSession } from '@/lib/rooms/types'

// EmployeeAvatar pulls in the settings context; stub it to its name for assertions.
vi.mock('@/components/ui/employee-avatar', () => ({
  EmployeeAvatar: ({ name }: { name: string }) => <span data-testid="avatar">{name}</span>,
}))

const employees: RoomEmployee[] = [
  { name: 'gepetto', displayName: 'Gepetto', department: 'woodworking', emoji: '🪵' },
  { name: 'safety', displayName: 'Safety Review', department: 'woodworking' },
]

const sessions: RoomSession[] = [
  { id: 'a', employee: 'gepetto', title: 'First-pass concept', status: 'idle', createdAt: '2026-06-21T12:40:00Z', lastActivity: '2026-06-21T12:40:00Z' },
  { id: 'b', employee: 'safety', title: 'Load-bearing review', parentSessionId: 'a', status: 'running', createdAt: '2026-06-21T12:46:00Z', lastActivity: '2026-06-21T12:46:00Z' },
]

function woodRoom() {
  return groupSessionsByDepartment(sessions, employees).find((r) => r.id === 'woodworking')!
}

describe('RoomTimeline', () => {
  it('renders the room name and an entry per agent with @target labels', () => {
    render(
      <RoomTimeline
        room={woodRoom()}
        employees={employees}
        sessionsById={indexSessionsById(sessions)}
        onOpenSession={() => {}}
      />,
    )
    expect(screen.getByText('Woodworking')).toBeTruthy()
    expect(screen.getByText('Gepetto')).toBeTruthy()
    expect(screen.getByText('Safety Review')).toBeTruthy()
    expect(screen.getByText('First-pass concept')).toBeTruthy()
    // root contribution addressed @all, child reports up @Gepetto
    expect(screen.getByText('@all')).toBeTruthy()
    expect(screen.getByText('@Gepetto')).toBeTruthy()
  })

  it('shows the agent + chat counts in the header', () => {
    render(<RoomTimeline room={woodRoom()} employees={employees} onOpenSession={() => {}} />)
    expect(screen.getByText('2 agents')).toBeTruthy()
    expect(screen.getByText('2 chats')).toBeTruthy()
  })

  it('opens the source session when a contribution is clicked', () => {
    const onOpen = vi.fn()
    render(<RoomTimeline room={woodRoom()} employees={employees} onOpenSession={onOpen} />)
    fireEvent.click(screen.getByLabelText("Open Gepetto's session"))
    expect(onOpen).toHaveBeenCalledWith('a')
  })

  it('renders an empty state for a room with no sessions', () => {
    const empty = { ...woodRoom(), sessions: [], participants: [], sessionCount: 0, participantCount: 0 }
    render(<RoomTimeline room={empty} employees={employees} onOpenSession={() => {}} />)
    expect(screen.getByText('No activity in this room yet')).toBeTruthy()
  })

  it('labels the Unassigned room and its direct speaker', () => {
    const room = groupSessionsByDepartment(
      [{ id: 'z', employee: null, title: 'loose chat', status: 'idle', createdAt: '2026-06-21T09:00:00Z' }],
      employees,
    ).find((r) => r.id === UNASSIGNED_ROOM_ID)!
    render(<RoomTimeline room={room} employees={employees} onOpenSession={() => {}} />)
    expect(screen.getByText('Unassigned')).toBeTruthy()
    expect(screen.getAllByText('Direct').length).toBeGreaterThanOrEqual(1)
  })
})
