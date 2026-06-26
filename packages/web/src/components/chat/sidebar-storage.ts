import type { Session } from "./sidebar-types"

/**
 * localStorage-backed UI state for the chat sidebar: read/pin markers and the
 * collapse/expand state of employee groups and department rooms.
 * Extracted from chat-sidebar.tsx (audit AS-001 modularization) — no behavior change.
 */

const COLLAPSE_STORAGE_KEY = "cuttlefish-sidebar-collapsed"
const EXPANDED_STORAGE_KEY = "cuttlefish-sidebar-expanded"
const PINNED_STORAGE_KEY = "cuttlefish-pinned-sessions"
// Which department rooms are EXPANDED (default: none — rooms collapse to a single
// header so agents/sessions stop dominating the list; the room IS the nav unit,
// its sessions are revealed on demand).
const ROOMS_EXPANDED_STORAGE_KEY = "cuttlefish-sidebar-rooms-expanded"

export function loadExpandedRooms(): Set<string> {
  try {
    const raw = localStorage.getItem(ROOMS_EXPANDED_STORAGE_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? new Set(arr.filter((x): x is string => typeof x === "string")) : new Set()
  } catch {
    return new Set()
  }
}

export function saveExpandedRooms(set: Set<string>): void {
  try {
    localStorage.setItem(ROOMS_EXPANDED_STORAGE_KEY, JSON.stringify(Array.from(set)))
  } catch {}
}

export function getReadSessions(): Set<string> {
  try {
    const raw = localStorage.getItem("cuttlefish-read-sessions")
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch {
    return new Set()
  }
}

export function markSessionRead(id: string) {
  const read = getReadSessions()
  read.add(id)
  const arr = Array.from(read)
  if (arr.length > 500) arr.splice(0, arr.length - 500)
  localStorage.setItem("cuttlefish-read-sessions", JSON.stringify(arr))
}

export function markAllReadForEmployee(sessions: Session[]) {
  const read = getReadSessions()
  for (const s of sessions) read.add(s.id)
  const arr = Array.from(read)
  if (arr.length > 500) arr.splice(0, arr.length - 500)
  localStorage.setItem("cuttlefish-read-sessions", JSON.stringify(arr))
}

export function getPinnedSessions(): Set<string> {
  try {
    const raw = localStorage.getItem(PINNED_STORAGE_KEY)
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch {
    return new Set()
  }
}

export function savePinnedSessions(pinned: Set<string>) {
  try {
    localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(Array.from(pinned)))
  } catch {}
}

export function loadCollapsedState(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSE_STORAGE_KEY)
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch {
    return new Set()
  }
}

export function saveCollapsedState(collapsed: Set<string>) {
  try {
    localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(Array.from(collapsed)))
  } catch {}
}

export function loadExpandedState(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(EXPANDED_STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

export function saveExpandedState(expanded: Record<string, boolean>) {
  try {
    localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(expanded))
  } catch {}
}
