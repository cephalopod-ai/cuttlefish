import type { BackgroundActivity, Employee } from "@/lib/api"

/**
 * Shared types for the chat sidebar and its helper modules.
 * Extracted from chat-sidebar.tsx (audit AS-001 modularization) — no behavior change.
 */

export interface Session {
  id: string
  connector?: string | null
  employee?: string
  title?: string
  status?: string
  source?: string
  sourceRef?: string
  sessionKey?: string
  /** Set on delegated/spawned child sessions; null/empty for top-level chats. */
  parentSessionId?: string | null
  transportState?: string
  queueDepth?: number
  lastActivity?: string
  createdAt?: string
  /** Background work (subagents/background tasks) still running while the
   *  session is officially idle. null/absent = none. Kept live via the
   *  session:background WS event (cache patch in useQueryInvalidation). */
  backgroundActivity?: BackgroundActivity | null
  [key: string]: unknown
}

export interface SidebarOrder {
  sessionIds: string[]
  employeeNames: string[]
  employeeSessionMap: Record<string, string[]>
}

export interface FlatItem {
  type: "employee" | "direct"
  employeeName?: string
  employeeData?: Employee
  sessions?: Session[]
  session?: Session
  sortKey: string
  pinKey: string
  /** Server group key for "load more" (employee slug, or a sentinel). */
  groupKey?: string
  /** True total in this group (may exceed loaded `sessions.length`). */
  total?: number
}

// One flat session row (Today / Yesterday / search results), carrying the
// resolved employee identity so the row can render without re-deriving it.
export interface FlatRow {
  session: Session
  avatarName: string
  avatar?: string
  emoji?: string
  displayName: string
}

// Primary sidebar grouping. "rooms" (default) groups chats into department
// project-rooms; "focused"/"all" keep the flat recency list (operator's own
// chats vs. everything). Persisted in FOCUS_MODE_STORAGE_KEY.
export type ViewMode = "rooms" | "focused" | "all"

export interface StatusDotState {
  color: string
  label: string
  pulse: boolean
}
