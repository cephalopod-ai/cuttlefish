/**
 * Cuttlefish Talk — tiny localStorage helpers for the small UI bits that should
 * survive a reload (the routed-thread selection and manual thread-label
 * overrides). Keyed by the stable reused orchestrator id ("talk:main").
 *
 * Cards and transcript are NOT persisted here — the transcript is rehydrated
 * from the server session, and cards are transient (the orchestrator re-pushes
 * any it still wants on screen). Mirrors the SSR/try-catch guards in
 * lib/conversations.ts.
 */

/** Stable reused talk orchestrator id (see cuttlefish/src/talk/routes.ts). */
export const TALK_KEY = "talk:main"

const TARGET_KEY = `cuttlefish-talk-target-${TALK_KEY}`
const LABELS_KEY = `cuttlefish-talk-labels-${TALK_KEY}`
const DISMISSED_KEY = `cuttlefish-talk-dismissed-${TALK_KEY}`

export function loadTargetThread(): string | null {
  if (typeof window === "undefined") return null
  try {
    return localStorage.getItem(TARGET_KEY) || null
  } catch {
    return null
  }
}

export function saveTargetThread(id: string | null): void {
  if (typeof window === "undefined") return
  try {
    if (id) localStorage.setItem(TARGET_KEY, id)
    else localStorage.removeItem(TARGET_KEY)
  } catch {
    /* storage full / unavailable — selection just won't persist */
  }
}

export function loadThreadLabels(): Record<string, string> {
  if (typeof window === "undefined") return {}
  try {
    const raw = localStorage.getItem(LABELS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

export function saveThreadLabel(id: string, label: string): void {
  if (typeof window === "undefined") return
  try {
    const map = loadThreadLabels()
    map[id] = label
    localStorage.setItem(LABELS_KEY, JSON.stringify(map))
  } catch {
    /* ignore */
  }
}

/** Drop a thread's label override (e.g. on dismiss) so the map doesn't accrete. */
export function removeThreadLabel(id: string): void {
  if (typeof window === "undefined") return
  try {
    const map = loadThreadLabels()
    if (id in map) {
      delete map[id]
      localStorage.setItem(LABELS_KEY, JSON.stringify(map))
    }
  } catch {
    /* ignore */
  }
}

/**
 * Dismissed-thread tombstones. `dismissThread` only hides the chip (it never
 * kills the gateway child session), so without a tombstone the thread would
 * resurrect on the next reload/reconnect when rehydrate rebuilds from ALL
 * server children. Keyed by talk:main.
 */
export function loadDismissedThreads(): string[] {
  if (typeof window === "undefined") return []
  try {
    const raw = localStorage.getItem(DISMISSED_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []
  } catch {
    return []
  }
}

export function addDismissedThread(id: string): void {
  if (typeof window === "undefined") return
  try {
    const ids = loadDismissedThreads()
    if (!ids.includes(id)) {
      ids.push(id)
      localStorage.setItem(DISMISSED_KEY, JSON.stringify(ids))
    }
  } catch {
    /* ignore */
  }
}
