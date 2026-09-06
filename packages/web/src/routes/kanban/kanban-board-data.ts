/**
 * Translate department boards into UI tickets and scoped save requests.
 * Extracted from routes/kanban/page.tsx in a behavior-preserving modularization.
 * The page re-exports getBoardLoadDepartments, loadDepartmentBoards,
 * buildDepartmentBoardSaveRequests, buildAssigneeChangeUpdate,
 * LoadedDepartmentBoards and DepartmentBoardSaveTarget for compatibility.
 */
import { api } from '@/lib/api'
import type { DepartmentBoardResponse, DepartmentBoardTicket, Employee, OrgData } from '@/lib/api'
import type { KanbanTicket, TicketStatus, TicketPriority, TicketComplexity } from '@/lib/kanban/types'
import type { KanbanStore } from '@/lib/kanban/store'
import { DEFAULT_RECYCLE_BIN_RETENTION_DAYS, clampRecycleBinRetentionDays, type DeletedKanbanTicket } from './kanban-retention'

export function getBoardLoadDepartments(data: OrgData): string[] {
  return Array.isArray(data.boardDepartments) ? data.boardDepartments : data.departments
}

export interface LoadedDepartmentBoards {
  boardTickets: KanbanStore
  deletedTickets: DeletedKanbanTicket[]
  retentionDays: number
  departmentRetentionDays: Record<string, number>
  warnings: string[]
  blockedDepartments: string[]
}

function mapBoardTicket(item: DepartmentBoardTicket, department: string): KanbanTicket {
  if (!item || typeof item.id !== 'string' || !item.id || typeof item.title !== 'string') {
    throw new Error(`Invalid ticket in ${department}: expected an id and title`)
  }
  for (const field of ['description', 'resourcePath', 'resourceUrl', 'assignee', 'source', 'sessionId', 'createdAt', 'updatedAt'] as const) {
    if (item[field] != null && typeof item[field] !== 'string') {
      throw new Error(`Invalid ${field} in ${department}/${item.id}`)
    }
  }
  if (item.updatedAt && !Number.isFinite(Date.parse(item.updatedAt))) {
    throw new Error(`Invalid board version in ${department}/${item.id}`)
  }
  const statusMap: Record<string, TicketStatus> = {
    todo: 'todo',
    in_progress: 'in-progress',
    'in-progress': 'in-progress',
    done: 'done',
    blocked: 'blocked',
    backlog: 'backlog',
    review: 'review',
  }
  const priorityMap: Record<string, TicketPriority> = {
    low: 'low',
    medium: 'medium',
    high: 'high',
  }
  const complexityMap: Record<string, TicketComplexity> = {
    low: 'low',
    medium: 'medium',
    high: 'high',
  }
  return {
    id: item.id,
    title: item.title,
    description: item.description || '',
    resourcePath: item.resourcePath,
    resourceUrl: item.resourceUrl,
    manualOnly: item.manualOnly === true,
    status: Object.hasOwn(statusMap, item.status) ? statusMap[item.status] : (() => { throw new Error(`Unknown ticket status '${String(item.status)}' in ${department}/${item.id}`) })(),
    priority: item.priority && Object.hasOwn(priorityMap, item.priority) ? priorityMap[item.priority] : 'medium',
    complexity: item.complexity && Object.hasOwn(complexityMap, item.complexity) ? complexityMap[item.complexity] : 'medium',
    assigneeId: item.assignee || null,
    source: item.source,
    sessionId: item.sessionId,
    department,
    workState: 'idle',
    createdAt: item.createdAt && Number.isFinite(Date.parse(item.createdAt)) ? Date.parse(item.createdAt) : Date.now(),
    updatedAt: item.updatedAt ? new Date(item.updatedAt).getTime() : Date.now(),
    baseUpdatedAt: item.updatedAt ? new Date(item.updatedAt).getTime() : undefined,
    departmentId: department,
  }
}

function mapDeletedBoardTicket(item: DepartmentBoardTicket, department: string): DeletedKanbanTicket {
  const ticket = mapBoardTicket(item, department)
  if (typeof item.deletedAt !== 'string' || !Number.isFinite(Date.parse(item.deletedAt))) {
    throw new Error(`Invalid deletion version in ${department}/${item.id}`)
  }
  return {
    ...ticket,
    deletedAt: Date.parse(item.deletedAt),
  }
}

export async function loadDepartmentBoards(
  boardDepartments: string[],
  getDepartmentBoard: (department: string) => Promise<DepartmentBoardResponse> = (department) => api.getDepartmentBoard(department),
): Promise<LoadedDepartmentBoards> {
  const results = await Promise.all(
    [...new Set(boardDepartments)].map(async (department) => {
      try {
        const board = await getDepartmentBoard(department)
        return { department, board } as const
      } catch (err) {
        return { department, error: err } as const
      }
    }),
  )

  const boardTickets: KanbanStore = Object.create(null)
  const deletedTickets: DeletedKanbanTicket[] = []
  let retentionDays: number | null = null
  const departmentRetentionDays: Record<string, number> = Object.create(null)
  const warnings: string[] = []
  const blockedDepartments = new Set<string>()
  const ticketDepartments = new Map<string, string>()
  const claimTicket = (ticket: KanbanTicket, department: string) => {
    const previous = ticketDepartments.get(ticket.id)
    if (previous !== undefined) {
      blockedDepartments.add(previous)
      throw new Error(`Duplicate ticket id '${ticket.id}' in ${previous} and ${department}`)
    }
    ticketDepartments.set(ticket.id, department)
  }

  for (const result of results) {
    if ('error' in result) {
      const message = result.error instanceof Error ? result.error.message : 'Failed to load board.'
      if (/404|not found/i.test(message)) continue
      warnings.push(`${result.department}: ${message}`)
      blockedDepartments.add(result.department)
      continue
    }
    if (!Array.isArray(result.board?.tickets) || !Array.isArray(result.board?.deletedTickets)) {
      warnings.push(`${result.department}: Invalid board payload. Saves are blocked until the board is repaired and reloaded.`)
      blockedDepartments.add(result.department)
      continue
    }
    const nextRetentionDays = clampRecycleBinRetentionDays(result.board.retentionDays)
    departmentRetentionDays[result.department] = nextRetentionDays
    retentionDays = retentionDays == null ? nextRetentionDays : Math.max(retentionDays, nextRetentionDays)
    for (const item of result.board.tickets) {
      try {
        const ticket = mapBoardTicket(item, result.department)
        claimTicket(ticket, result.department)
        boardTickets[ticket.id] = ticket
      } catch (err) {
        warnings.push(`${err instanceof Error ? err.message : 'Invalid ticket'}. Saves are blocked for ${result.department} until the board is repaired and reloaded.`)
        blockedDepartments.add(result.department)
      }
    }
    for (const item of result.board.deletedTickets) {
      try {
        const ticket = mapDeletedBoardTicket(item, result.department)
        claimTicket(ticket, result.department)
        deletedTickets.push(ticket)
      } catch (err) {
        warnings.push(`${err instanceof Error ? err.message : 'Invalid deleted ticket'}. Saves are blocked for ${result.department} until the board is repaired and reloaded.`)
        blockedDepartments.add(result.department)
      }
    }
  }

  return {
    boardTickets,
    deletedTickets: deletedTickets.sort((a, b) => b.deletedAt - a.deletedAt),
    retentionDays: retentionDays ?? DEFAULT_RECYCLE_BIN_RETENTION_DAYS,
    departmentRetentionDays,
    warnings,
    blockedDepartments: [...blockedDepartments],
  }
}

const BOARD_STATUS_BY_KANBAN_STATUS: Record<KanbanTicket['status'], DepartmentBoardTicket['status']> = {
  backlog: 'backlog',
  todo: 'todo',
  'in-progress': 'in_progress',
  review: 'review',
  done: 'done',
  blocked: 'blocked',
}

export interface DepartmentBoardSaveTarget {
  department: string
  deletedIds?: string[]
  deletedVersions?: Record<string, string>
  restoredVersions?: Record<string, string>
  retentionDays?: number | null
}

export function buildDepartmentBoardSaveRequests(
  store: KanbanStore,
  targets: DepartmentBoardSaveTarget[],
  departmentRetentionDays: Record<string, number>,
  blockedDepartments: readonly string[] = [],
): Array<{ department: string; payload: import('@/lib/api').UpdateDepartmentBoardPayload }> {
  // A whole-board save must never replace a board we could only partially load.
  // Validate the entire batch before the caller can start any HTTP request.
  const blocked = targets.find(target => blockedDepartments.includes(target.department))
  if (blocked) throw new Error(`${blocked.department}: board was not fully loaded; repair the board and reload before saving.`)
  const mergedTargets = new Map<string, Required<Omit<DepartmentBoardSaveTarget, 'retentionDays'>> & { retentionDays: number | null }>()
  for (const target of targets) {
    if (!target.department) continue
    const existing = mergedTargets.get(target.department) ?? {
      department: target.department,
      deletedIds: [],
      deletedVersions: {},
      restoredVersions: {},
      retentionDays: null,
    }
    existing.deletedIds = [...new Set([...existing.deletedIds, ...(target.deletedIds ?? [])])]
    existing.deletedVersions = { ...existing.deletedVersions, ...(target.deletedVersions ?? {}) }
    existing.restoredVersions = { ...existing.restoredVersions, ...(target.restoredVersions ?? {}) }
    if (target.retentionDays != null) existing.retentionDays = target.retentionDays
    mergedTargets.set(target.department, existing)
  }

  return [...mergedTargets.values()].map((target) => {
    const boardData: DepartmentBoardTicket[] = Object.values(store)
      .filter((ticket) => ticket.departmentId === target.department)
      .map((t) => {
        // Only assert optimistic-concurrency freshness for tickets the user
        // actually edited. `updateTicket` advances `updatedAt` but leaves
        // `baseUpdatedAt` at the loaded snapshot, so a ticket is "dirty" when
        // those differ (or when it has no snapshot, i.e. newly created).
        // Untouched tickets — bundled only because a save sends the whole
        // department board — omit `baseUpdatedAt` so a concurrent agent write
        // to one of them can't block an unrelated delete/move/edit.
        const changed = t.baseUpdatedAt == null || t.baseUpdatedAt !== t.updatedAt
        if (t.baseUpdatedAt != null && !Number.isFinite(new Date(t.baseUpdatedAt).getTime())) {
          throw new Error(`${t.id}: invalid board version; reload before saving.`)
        }
        const serializeDate = (timestamp: number | undefined): string => {
          const date = new Date(timestamp ?? NaN)
          return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(Date.now()).toISOString()
        }
        return {
          id: t.id,
          title: t.title,
          description: t.description,
          resourcePath: t.resourcePath,
          resourceUrl: t.resourceUrl,
          manualOnly: t.manualOnly === true,
          status: BOARD_STATUS_BY_KANBAN_STATUS[t.status],
          priority: t.priority,
          complexity: t.complexity,
          assignee: t.assigneeId ?? undefined,
          source: t.source,
          sessionId: t.sessionId,
          createdAt: serializeDate(t.createdAt),
          updatedAt: serializeDate(t.updatedAt),
          ...(Object.hasOwn(target.restoredVersions, t.id) && target.restoredVersions[t.id] ? { deletedAt: target.restoredVersions[t.id] } : {}),
          ...(changed
            ? { baseUpdatedAt: serializeDate(t.baseUpdatedAt ?? t.updatedAt) }
            : {}),
        }
      })
    return {
      department: target.department,
      payload: {
        tickets: boardData,
        deletedIds: target.deletedIds,
        deletedVersions: target.deletedVersions,
        retentionDays: target.retentionDays ?? departmentRetentionDays[target.department],
      },
    }
  })
}

export function buildAssigneeChangeUpdate(
  assigneeId: string | null,
  employees: Employee[],
): Partial<Omit<KanbanTicket, 'id' | 'createdAt'>> {
  const emp = assigneeId ? employees.find(e => e.name === assigneeId) : null
  const updates: Partial<Omit<KanbanTicket, 'id' | 'createdAt'>> = { assigneeId }
  if (emp?.department) {
    updates.department = emp.department
    updates.departmentId = emp.department
  }
  return updates
}
