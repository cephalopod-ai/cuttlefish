/**
 * Cuttlefish Talk — thread-activity overlay store (delegation redesign).
 *
 * Advisory, client-side overlay keyed by sessionId: the live "now doing" line
 * and the final report excerpt for every node of the delegation tree. Fed in
 * use-talk from the `session:delta` / `session:completed` WS events that arrive
 * for every tree node (graph-store stays the structural source — a missing
 * entry here just renders nothing).
 */

export interface ThreadActivity {
  /** Short live "now doing" line (present while the node works). */
  activity?: string
  /** Sanitized excerpt of the node's final result (set on completion). */
  reportExcerpt?: string
}

export type ActivityMap = Map<string, ThreadActivity>

export type ActivityAction =
  | { type: "activity"; id: string; text: string }
  | { type: "report"; id: string; text: string }

/** Strip markdown/URLs/UUIDs, flatten whitespace, cap at `max` chars. */
export function excerpt(text: string, max: number): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, " ")
    .replace(/[*_#`>|~]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
  if (!flat) return ""
  // Surrogate-pair-safe truncation: after slicing, strip a trailing lone high
  // surrogate that would result from splitting an astral codepoint in two.
  return flat.length > max
    ? flat.slice(0, max - 1).trimEnd().replace(/[\uD800-\uDBFF]$/, "") + "…"
    : flat
}

export interface ActivityDeltaLike {
  toolName?: string
  content?: string | number
  input?: string
}

/** Map a child session's tool_use delta to a short human "now doing" line. */
export function activityFor(delta: ActivityDeltaLike): string {
  const name = typeof delta.toolName === "string" ? delta.toolName : ""
  const input = typeof delta.input === "string" ? delta.input : ""
  const hay = `${name} ${typeof delta.content === "string" ? delta.content : ""} ${input}`.toLowerCase()
  // Spawning a sub-session — scoped to shell-ish tools (or no tool name) so an
  // Edit whose old_string happens to contain gateway tokens isn't misclassified.
  const isShellish = name === "" || /^(bash|shell|command_execution)$/i.test(name)
  if (isShellish && hay.includes("/api/sessions") && hay.includes("parentsessionid")) return "delegating…"
  // Codex-interactive emits file_read / file_edit / command_execution / shell in
  // addition to the standard Claude Read/Write/Edit/Bash/Glob/Grep tool names.
  if (/^(read|glob|grep|file_read)$/i.test(name)) return "reading…"
  if (/^(write|edit|notebookedit|file_edit)$/i.test(name)) return "editing…"
  if (/^(websearch|webfetch)$/i.test(name)) return "searching the web…"
  if (/^(task|agent)$/i.test(name)) return "delegating…"
  if (/^(bash|shell|command_execution)$/i.test(name)) return "running commands…"
  return "working…"
}

/** Pure transitions on the sessionId → ThreadActivity map. */
export function threadActivityReducer(map: ActivityMap, action: ActivityAction): ActivityMap {
  const prev = map.get(action.id)
  if (action.type === "activity") {
    if (prev?.activity === action.text) return map
    const next = new Map(map)
    next.set(action.id, { ...prev, activity: action.text })
    return next
  }
  // report: the live line ends; keep only a non-empty excerpt.
  const text = excerpt(action.text, 140)
  const entry: ThreadActivity = text ? { reportExcerpt: text } : {}
  if (prev && !prev.activity && prev.reportExcerpt === entry.reportExcerpt) return map
  const next = new Map(map)
  next.set(action.id, entry)
  return next
}
