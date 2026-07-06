import type { Employee } from "@/lib/api"
import type { PublicSession } from "@cuttlefish/contracts"

/**
 * Shared types for the chat sidebar and its helper modules.
 * Extracted from chat-sidebar.tsx (audit AS-001 modularization) — no behavior change.
 */

export type Session = PublicSession

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
