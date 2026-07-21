/**
 * Pure grouping + aggregation for chat "department project rooms".
 *
 * Side-effect-free and React-free: every function takes plain data (the loaded
 * session list + org roster) and returns view models from `./types`. This keeps
 * the sidebar's grouping logic decoupled from persistence/fetching and lets the
 * fiddly bits (department resolution, Unassigned fallback, `@target` derivation)
 * be unit-tested without a DOM. Nothing here mutates its inputs.
 *
 * Verified against the live shapes (packages/cuttlefish/src/shared/types.ts): a session
 * has only `employee` (+ `parentSessionId`) — there is no department/project
 * column — so a room is derived as `employee → org.employees[].department`.
 * Sessions whose department can't be resolved degrade into the Unassigned room.
 */

import type {
  DepartmentRoom,
  RoomEmployee,
  RoomParticipant,
  RoomSession,
  RoomStatus,
  RoomTarget,
  RoomTimelineEntry,
} from './types'

/** Sentinel room id for sessions with no resolvable department. */
export const UNASSIGNED_ROOM_ID = '__unassigned__'
export const UNASSIGNED_ROOM_NAME = 'Unassigned'

/** Prefix marking a sidebar selection as a room (vs. a bare session id). */
export const ROOM_SELECTION_PREFIX = 'room:'

/** Statuses that mean "this session is doing work right now" (excludes
 *  'waiting', which means blocked on the operator, not busy). */
const RUNNING_STATUSES = new Set(['running'])

/** True when a session is blocking on the operator. Mirrors
 *  `chat/sidebar-session-helpers`'s `isNeedsAttention` but is redefined locally
 *  (on the room-scoped `RoomSession` shape) to keep this module dependency-free
 *  of the chat component tree, matching the existing `isCronRoomSession` /
 *  `isCronSession` split. */
function isRoomSessionNeedsAttention(s: RoomSession): boolean {
  return s.jobState === 'needs_attention' || s.status === 'waiting'
}

/** Label used for a participant/speaker on a session with no employee. */
const DIRECT_PARTICIPANT_NAME = ''
const DIRECT_PARTICIPANT_LABEL = 'Direct'

// ---------------------------------------------------------------------------
// Selection id helpers — a room is addressed in the chat route as `room:<slug>`.
// ---------------------------------------------------------------------------

/** Build the sidebar selection id for a room. */
export function roomSelectionId(roomId: string): string {
  return `${ROOM_SELECTION_PREFIX}${roomId}`
}

/** Parse a room selection id back to its room id, or null if it isn't one. */
export function parseRoomSelection(selection: string | null | undefined): string | null {
  if (!selection || !selection.startsWith(ROOM_SELECTION_PREFIX)) return null
  const id = selection.slice(ROOM_SELECTION_PREFIX.length)
  return id.length > 0 ? id : null
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/**
 * Turn a department slug into a display name. Splits on `-`/`_`/whitespace,
 * title-cases each word, and upper-cases tokens that start with a digit so
 * "3d-printing" → "3D Printing" and "woodworking" → "Woodworking". Deterministic
 * and lossy-but-readable; departments have no served displayName today.
 */
export function prettifyDeptName(slug: string): string {
  const trimmed = (slug ?? '').trim()
  if (!trimmed) return ''
  return trimmed
    .split(/[-_\s]+/)
    .filter((w) => w.length > 0)
    .map((w) => (/^\d/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
}

/** True for a cron-triggered session (kept out of department rooms). */
export function isCronRoomSession(s: RoomSession): boolean {
  return s.source === 'cron' || String(s.sourceRef ?? '').startsWith('cron:')
}

/** Build a name→employee lookup once for the helpers below. */
export function buildEmployeeMap(employees: RoomEmployee[]): Map<string, RoomEmployee> {
  const map = new Map<string, RoomEmployee>()
  for (const e of employees) {
    if (e && e.name) map.set(e.name, e)
  }
  return map
}

/**
 * Resolve the department a session belongs to, or null when it can't be mapped
 * (no employee, or an employee that isn't in the org roster / has no department).
 * Cron sessions resolve to null too — they live in the sidebar's Scheduled
 * section, not a department room.
 */
export function resolveSessionDepartment(
  s: RoomSession,
  employeeMap: Map<string, RoomEmployee>,
): { id: string; name: string } | null {
  if (isCronRoomSession(s)) return null
  const empName = (s.employee ?? '').trim()
  if (!empName) return null
  const emp = employeeMap.get(empName)
  const dept = (emp?.department ?? '').trim()
  if (!dept) return null
  return { id: dept, name: prettifyDeptName(dept) }
}

/** Newer ISO timestamp wins; undefined/empty loses. */
function maxIso(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b
  if (!b) return a
  return a >= b ? a : b
}

interface RoomAccumulator {
  room: DepartmentRoom
  participants: Map<string, RoomParticipant>
}

/**
 * Group sessions into department rooms.
 *
 * - Cron sessions are skipped (handled by the sidebar's Scheduled section).
 * - A session with no resolvable department goes into the Unassigned room.
 * - Each room's sessions are sorted newest-activity first; participants are the
 *   distinct employees (or a single "Direct" entry for employee-less sessions).
 * - Rooms are returned most-recently-active first, with Unassigned always last.
 *
 * Inputs are never mutated.
 */
export function groupSessionsByDepartment(
  sessions: RoomSession[],
  employees: RoomEmployee[],
): DepartmentRoom[] {
  const employeeMap = buildEmployeeMap(employees)
  const acc = new Map<string, RoomAccumulator>()

  const ensure = (id: string, name: string, isUnassigned: boolean): RoomAccumulator => {
    let a = acc.get(id)
    if (!a) {
      a = {
        room: {
          id,
          name,
          departmentId: isUnassigned ? UNASSIGNED_ROOM_ID : id,
          isUnassigned,
          sessions: [],
          participants: [],
          sessionCount: 0,
          participantCount: 0,
          lastActivity: undefined,
          runningCount: 0,
          needsAttentionCount: 0,
          status: 'idle',
        },
        participants: new Map(),
      }
      acc.set(id, a)
    }
    return a
  }

  for (const s of sessions) {
    if (!s || isCronRoomSession(s)) continue
    const dept = resolveSessionDepartment(s, employeeMap)
    const target = dept
      ? ensure(dept.id, dept.name, false)
      : ensure(UNASSIGNED_ROOM_ID, UNASSIGNED_ROOM_NAME, true)

    target.room.sessions.push(s)
    target.room.sessionCount += 1
    target.room.lastActivity = maxIso(target.room.lastActivity, s.lastActivity)
    if (RUNNING_STATUSES.has(s.status ?? '')) target.room.runningCount += 1
    if (isRoomSessionNeedsAttention(s)) target.room.needsAttentionCount += 1

    // Participant tally (distinct employee, or a single Direct bucket).
    const empName = (s.employee ?? '').trim()
    const emp = empName ? employeeMap.get(empName) : undefined
    const pKey = empName && emp ? empName : empName || DIRECT_PARTICIPANT_NAME
    const existing = target.participants.get(pKey)
    if (existing) {
      existing.sessionCount += 1
    } else {
      target.participants.set(pKey, {
        name: pKey,
        displayName: emp?.displayName || empName || DIRECT_PARTICIPANT_LABEL,
        emoji: emp?.emoji,
        sessionCount: 1,
      })
    }
  }

  const rooms: DepartmentRoom[] = []
  for (const { room, participants } of acc.values()) {
    room.sessions.sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''))
    room.participants = [...participants.values()].sort(
      (a, b) => b.sessionCount - a.sessionCount || a.displayName.localeCompare(b.displayName),
    )
    room.participantCount = room.participants.length
    room.status = room.runningCount > 0 || room.needsAttentionCount > 0 ? 'active' : 'idle'
    rooms.push(room)
  }

  rooms.sort((a, b) => {
    // Unassigned always sinks to the bottom.
    if (a.isUnassigned !== b.isUnassigned) return a.isUnassigned ? 1 : -1
    // Then most-recently-active first; ties broken by name for stability.
    const byActivity = (b.lastActivity ?? '').localeCompare(a.lastActivity ?? '')
    return byActivity !== 0 ? byActivity : a.name.localeCompare(b.name)
  })
  return rooms
}

// ---------------------------------------------------------------------------
// Timeline (merged read view)
// ---------------------------------------------------------------------------

const NO_HEADLINE = '(untitled session)'

/**
 * Derive the intended `@target` of a session's contribution.
 *
 * With only `parentSessionId` + `employee` available:
 * - A delegated CHILD session (has a parent) reports up → `@<parent agent>` when
 *   the parent session is loaded (resolved via `sessionsById`), else `@parent`.
 * - A top-level session's contribution is shared room-wide → `@all`.
 */
export function deriveTarget(
  s: RoomSession,
  employeeMap: Map<string, RoomEmployee>,
  sessionsById?: Map<string, RoomSession>,
): RoomTarget {
  const parentId = (s.parentSessionId ?? '').toString().trim()
  if (parentId) {
    const parent = sessionsById?.get(parentId)
    const parentEmp = parent?.employee ? employeeMap.get(parent.employee) : undefined
    const label = parentEmp?.displayName || parent?.employee || 'parent'
    return { kind: 'agent', label, id: parent?.employee ?? undefined }
  }
  return { kind: 'all', label: 'all' }
}

/** Index a session list by id (for parent lookups in `buildRoomTimeline`). */
export function indexSessionsById(sessions: RoomSession[]): Map<string, RoomSession> {
  const map = new Map<string, RoomSession>()
  for (const s of sessions) {
    if (s && s.id) map.set(s.id, s)
  }
  return map
}

/**
 * Build a room's merged read-only timeline: one entry per session, ordered
 * oldest-first (chat-history order), each labeled with speaker + `@target`.
 *
 * `sessionsById` (optional) lets child sessions resolve their parent agent for a
 * precise `@target`; pass the FULL loaded session set, not just the room's, so a
 * parent in another room still resolves. Inputs are never mutated.
 */
export function buildRoomTimeline(
  room: DepartmentRoom,
  employees: RoomEmployee[],
  sessionsById?: Map<string, RoomSession>,
): RoomTimelineEntry[] {
  const employeeMap = buildEmployeeMap(employees)
  const entries = room.sessions.map((s): RoomTimelineEntry => {
    const empName = (s.employee ?? '').trim()
    const emp = empName ? employeeMap.get(empName) : undefined
    const title = (s.title ?? '').trim()
    const excerpt = (s.promptExcerpt ?? '').trim()
    const headline = title || excerpt || NO_HEADLINE
    const ask = excerpt && excerpt !== headline ? excerpt : undefined
    return {
      id: s.id,
      sourceSessionId: s.id,
      speakerKey: empName,
      speakerName: emp?.displayName || empName || DIRECT_PARTICIPANT_LABEL,
      speakerType: empName ? 'agent' : 'user',
      speakerEmoji: emp?.emoji,
      departmentId: room.departmentId,
      target: deriveTarget(s, employeeMap, sessionsById),
      headline,
      ask,
      status: s.status,
      createdAt: s.createdAt,
      lastActivity: s.lastActivity,
    }
  })
  // Oldest first: a chronological "who did what" story; newest at the bottom.
  entries.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
  return entries
}

/** Convenience: total running sessions across rooms (for an overall badge). */
export function totalRunning(rooms: DepartmentRoom[]): number {
  return rooms.reduce((n, r) => n + r.runningCount, 0)
}

export type { RoomStatus }
