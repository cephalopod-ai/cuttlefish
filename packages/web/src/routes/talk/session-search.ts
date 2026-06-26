/**
 * Cuttlefish Talk — session-search pure logic (Mission Control).
 *
 * Render/derivation helpers for the SessionSearchSheet, kept free of React so
 * they're unit-testable in isolation:
 *   • parseSnippet      — split a backend «»-highlighted snippet into spans.
 *   • hasEngageAttachment — is any graph node a live engage attachment?
 *   • mapSearchResults  — GET /api/talk/search rows → sheet view-models, with
 *                         attach-state derived from the live talk graph.
 */
import type { GraphNode } from "./graph-store"

/** One rendered span of a search snippet. `hit` → wrap in <mark>-equivalent. */
export interface SnippetSegment {
  text: string
  hit: boolean
}

/** A single content-hit from the search API. */
export interface TalkSearchHit {
  snippet: string
  role: string
  ts: number
}

/** One result row from GET /api/talk/search (mirrors SearchResult on the server). */
export interface TalkSearchResult {
  sessionId: string
  title: string | null
  employee: string | null
  source: string
  lastActivity: string
  status: string
  isTalkChild: boolean
  hits: TalkSearchHit[]
}

/** GET /api/talk/search success body. */
export interface TalkSearchApiResponse {
  ok: true
  results: TalkSearchResult[]
}

export type AttachedState = "attached-observe" | "attached-engage" | null

/** Sheet row view-model — everything a row needs to render, pre-derived. */
export interface SearchRowVM {
  id: string
  title: string
  meta: string
  snippetSegments: SnippetSegment[]
  isTalkChild: boolean
  attachedState: AttachedState
}

/** Append plain text, merging into a trailing plain segment to keep spans tidy. */
function pushPlain(segments: SnippetSegment[], text: string): void {
  if (!text) return
  const last = segments[segments.length - 1]
  if (last && !last.hit) last.text += text
  else segments.push({ text, hit: false })
}

/**
 * Split a search snippet on its «»-highlight markers into renderable spans.
 *
 * - No markers → a single plain segment.
 * - One or more balanced pairs → alternating plain/hit spans (leading/trailing
 *   plain spans are omitted when empty).
 * - Unbalanced markers (a stray « or ») → the whole snippet is rendered as
 *   plain text with the marker characters stripped, so a degraded snippet never
 *   shows raw markers or a phantom highlight.
 */
export function parseSnippet(s: string): SnippetSegment[] {
  if (!s) return []

  const opens = (s.match(/«/g) ?? []).length
  const closes = (s.match(/»/g) ?? []).length
  if (opens !== closes) {
    const text = s.replace(/[«»]/g, "")
    return text ? [{ text, hit: false }] : []
  }

  const segments: SnippetSegment[] = []
  let i = 0
  while (i < s.length) {
    const start = s.indexOf("«", i)
    if (start === -1) {
      pushPlain(segments, s.slice(i))
      break
    }
    pushPlain(segments, s.slice(i, start))
    const end = s.indexOf("»", start + 1)
    if (end === -1) {
      // Should be unreachable (counts balanced), but degrade to plain text.
      pushPlain(segments, s.slice(start).replace(/[«»]/g, ""))
      break
    }
    const inner = s.slice(start + 1, end)
    if (inner) segments.push({ text: inner, hit: true })
    i = end + 1
  }
  return segments
}

/** True when any graph node is a live engage attachment (drives the banner). */
export function hasEngageAttachment(nodes: GraphNode[]): boolean {
  return nodes.some((n) => n.attached === true && n.mode === "engage")
}

/**
 * Relative-time label from an ISO timestamp. Mirrors the format used by the
 * kanban ticket-card helper (just-now / Nm / Nh / Nd / Nmo ago); kept local
 * because that one is un-exported and number-typed.
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const ts = Date.parse(iso)
  if (Number.isNaN(ts)) return ""
  const diff = now - ts
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}

/** Build the per-session attach-state lookup from live graph nodes. */
function attachStateById(nodes: GraphNode[]): Map<string, AttachedState> {
  const map = new Map<string, AttachedState>()
  for (const n of nodes) {
    if (n.attached === true && (n.mode === "observe" || n.mode === "engage")) {
      map.set(n.id, `attached-${n.mode}` as AttachedState)
    }
  }
  return map
}

/**
 * Map a GET /api/talk/search response to sheet row view-models. `nodes` is the
 * live talk graph — a row's attachedState is derived from it (so the sheet
 * self-updates from talk:graph WS deltas without re-fetching). `now` is
 * injectable for deterministic relative-time tests.
 */
export function mapSearchResults(
  apiResponse: TalkSearchApiResponse | undefined | null,
  nodes: GraphNode[],
  now: number = Date.now(),
): SearchRowVM[] {
  const results = apiResponse?.results ?? []
  const attached = attachStateById(nodes)

  return results.map((r) => {
    const meta: string[] = []
    if (r.employee) meta.push(r.employee)
    if (r.source) meta.push(r.source)
    const rel = relativeTime(r.lastActivity, now)
    if (rel) meta.push(rel)

    const title = r.title?.trim() ? r.title.trim() : "untitled"

    return {
      id: r.sessionId,
      title,
      meta: meta.join(" · "),
      snippetSegments: parseSnippet(r.hits?.[0]?.snippet ?? ""),
      isTalkChild: !!r.isTalkChild,
      attachedState: attached.get(r.sessionId) ?? null,
    }
  })
}
