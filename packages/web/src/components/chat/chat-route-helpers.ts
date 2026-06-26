/**
 * Pure helpers for the chat route (packages/web/src/routes/chat/page.tsx).
 *
 * Extracted as side-effect-free functions so they can be unit-tested without a
 * DOM/render harness — the high-value, low-flakiness part of the deep-link +
 * contactable-roster features (#19b / #19c).
 */

export type DeepLink =
  | { kind: 'session'; id: string }
  | { kind: 'employee'; name: string }
  | null

/**
 * Map the chat route's URL search params to a deep-link action.
 *
 * Precedence: `?session=` wins over `?employee=` when both are present (a
 * concrete session id is the more specific intent). Empty / whitespace-only
 * values are ignored. Returns `null` when neither yields a usable value.
 */
export function resolveDeepLink(sp: URLSearchParams): DeepLink {
  const session = sp.get('session')?.trim()
  if (session) return { kind: 'session', id: session }
  const employee = sp.get('employee')?.trim()
  if (employee) return { kind: 'employee', name: employee }
  return null
}

/**
 * Merge the employees that already have sessions with the full org roster so
 * session-less employees are still listed (and contactable) in the sidebar.
 *
 * Result is a de-duped union: employees with sessions first (in their incoming
 * order), then roster-only employees (in roster order). Falsy entries are
 * dropped. The input arrays are never mutated.
 */
export function mergeSidebarEmployees(
  sessionEmployeeNames: string[],
  rosterNames: string[],
): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const name of sessionEmployeeNames) {
    if (name && !seen.has(name)) {
      seen.add(name)
      result.push(name)
    }
  }
  for (const name of rosterNames) {
    if (name && !seen.has(name)) {
      seen.add(name)
      result.push(name)
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Focused-sidebar recency bucketing
//
// The chat sidebar groups sessions by *when they were last active* relative to
// the local day: Today, Yesterday, or Older. Pulled out as pure functions so
// the date math (the only fiddly bit) is unit-tested without a DOM/render.
// ---------------------------------------------------------------------------

export type DayBucket = 'today' | 'yesterday' | 'older'

/** Local wall-clock midnight for the given date (drops the time component). */
export function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/**
 * Bucket a session's last-activity ISO timestamp into today / yesterday / older,
 * using LOCAL day boundaries. DST-safe: "yesterday" is the previous wall-clock
 * day (via date-component math), not "now − 24h", so a 23h/25h DST day still maps
 * correctly. Missing / unparseable timestamps fall into `older` (they sort last).
 */
export function bucketByDay(activityIso: string | undefined, now: Date): DayBucket {
  if (!activityIso) return 'older'
  const t = new Date(activityIso).getTime()
  if (Number.isNaN(t)) return 'older'
  const today = startOfLocalDay(now)
  const todayStart = today.getTime()
  if (t >= todayStart) return 'today'
  const yesterdayStart = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - 1,
  ).getTime()
  if (t >= yesterdayStart) return 'yesterday'
  return 'older'
}

/**
 * Summarize the "Older · N chats across M employees" line from the authoritative
 * per-group totals plus how many of each group's sessions are already surfaced in
 * the Today/Yesterday buckets.
 *
 * `groupTotals` is the server `counts` map (all-time total per group). `recentByGroup`
 * is the count of today+yesterday sessions currently shown for each group. Older =
 * total − recent (clamped at 0). `chats` sums older across every group; `employees`
 * counts groups that have any older sessions, excluding keys in `excludeFromEmployeeCount`
 * (the direct/COO bucket isn't an "employee").
 */
export function summarizeOlder(
  groupTotals: Record<string, number>,
  recentByGroup: Record<string, number>,
  excludeFromEmployeeCount?: Set<string>,
): { chats: number; employees: number } {
  let chats = 0
  let employees = 0
  for (const [group, total] of Object.entries(groupTotals)) {
    const older = Math.max(0, total - (recentByGroup[group] ?? 0))
    if (older <= 0) continue
    chats += older
    if (!excludeFromEmployeeCount?.has(group)) employees += 1
  }
  return { chats, employees }
}

// ---------------------------------------------------------------------------
// "Focused" filter — only the conversations the operator personally started.
//
// Verified against the live Session shape (packages/cuttlefish/src/shared/types.ts +
// the /api/sessions payload via rowToSession): the reliable discriminators are
// `source`, `sourceRef` (cron marker) and `parentSessionId`. `userId` is null on
// single-user installs, so it is NOT used. A session is "focused" iff:
//   • it is NOT cron-triggered (source 'cron' or sourceRef 'cron:…'), AND
//   • it is top-level — `parentSessionId` is empty (delegated/spawned CHILD
//     sessions carry their parent's id and are hidden), AND
//   • its source is a human-facing entry point (web / slack / talk).
// The source allowlist means any unknown/internal source is hidden by default.
// ---------------------------------------------------------------------------

/** Sources that represent a human starting a conversation directly. */
export const FOCUSED_SOURCES = new Set(['web', 'slack', 'talk'])

export interface FocusableSession {
  source?: string
  sourceRef?: string
  parentSessionId?: string | null
}

/** True for a top-level, user-initiated, non-cron conversation (see above). */
export function isFocusedSession(s: FocusableSession): boolean {
  const isCron = s.source === 'cron' || String(s.sourceRef ?? '').startsWith('cron:')
  if (isCron) return false
  const parent = s.parentSessionId
  if (parent != null && String(parent).trim() !== '') return false
  return FOCUSED_SOURCES.has(s.source ?? '')
}
