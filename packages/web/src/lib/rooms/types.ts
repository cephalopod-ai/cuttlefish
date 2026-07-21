/**
 * View-model types for the chat "department project rooms" feature.
 *
 * These are DERIVED view models computed on the client from the existing
 * `/api/sessions` + `/api/org` payloads — they are NOT a second session schema
 * and nothing here is persisted. A `DepartmentRoom` groups the sessions that
 * belong to one department (derived via `employee.department`); a
 * `RoomTimelineEntry` is one agent's contribution within a room, labeled with a
 * speaker and an intended `@target` recipient.
 *
 * The pure grouping/aggregation logic lives in `./grouping.ts`; React components
 * only consume these shapes (keeps grouping separated from fetching/rendering).
 */

/** The minimal slice of a session row the rooms layer reads. Structural so the
 *  loose `Record<string, unknown>` payload satisfies it after a cast. */
export interface RoomSession {
  id: string
  employee?: string | null
  source?: string
  sourceRef?: string
  parentSessionId?: string | null
  title?: string | null
  promptExcerpt?: string | null
  status?: string
  /** Delegated-job lifecycle state, when present — see `chat/sidebar-session-helpers`'s `isNeedsAttention`. */
  jobState?: string
  createdAt?: string
  lastActivity?: string
}

/** The minimal slice of an org employee the rooms layer reads. */
export interface RoomEmployee {
  name: string
  displayName?: string
  department?: string
  emoji?: string
  rank?: string
}

/** A distinct agent (or the operator) that has at least one session in a room. */
export interface RoomParticipant {
  /** Employee name key ('' for direct/operator sessions with no employee). */
  name: string
  displayName: string
  emoji?: string
  /** Number of this room's sessions owned by this participant. */
  sessionCount: number
}

/** A department-scoped chat room. `id` is the department slug, or
 *  `UNASSIGNED_ROOM_ID` for sessions whose department can't be resolved. */
export interface DepartmentRoom {
  id: string
  /** Human-facing room name (prettified department slug, or "Unassigned"). */
  name: string
  /** Raw department slug (=== id for real departments). */
  departmentId: string
  isUnassigned: boolean
  /** Sessions in this room, newest-activity first. */
  sessions: RoomSession[]
  participants: RoomParticipant[]
  sessionCount: number
  participantCount: number
  /** Max `lastActivity` across the room's sessions (ISO), if any. */
  lastActivity?: string
  /** Number of sessions actively running (excludes sessions blocked on the operator). */
  runningCount: number
  /** Number of sessions blocked on the operator (needs_attention/waiting) — kept
   *  distinct from `runningCount` so a room header can tell "busy" apart from
   *  "needs you", instead of collapsing both into one generic count. */
  needsAttentionCount: number
  /** 'active' when any session is running, waiting, or needs attention, else 'idle'. */
  status: RoomStatus
}

export type RoomStatus = 'active' | 'idle'

export type RoomTargetKind = 'all' | 'agent' | 'department' | 'user'

/** The intended recipient of a contribution, rendered as `@label`. */
export interface RoomTarget {
  kind: RoomTargetKind
  /** Display label without the leading '@' (e.g. "all", "Gepetto"). */
  label: string
  /** Stable id for the target when one exists (employee name / dept slug). */
  id?: string
}

export type RoomSpeakerType = 'user' | 'agent' | 'system'

/** One contribution in a room's merged timeline (one per source session). */
export interface RoomTimelineEntry {
  /** Entry id (the source session id). */
  id: string
  sourceSessionId: string
  /** Raw employee name/slug for avatar + override lookup ('' for direct/user). */
  speakerKey: string
  speakerName: string
  speakerType: RoomSpeakerType
  speakerEmoji?: string
  departmentId: string
  target: RoomTarget
  /** Short headline for the contribution (session title / prompt excerpt). */
  headline: string
  /** The original ask, when distinct from the headline (muted subline). */
  ask?: string
  status?: string
  createdAt?: string
  lastActivity?: string
}
