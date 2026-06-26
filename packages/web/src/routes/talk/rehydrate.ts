/**
 * Cuttlefish Talk — pure rehydration transforms (server snapshot → UI state).
 *
 * On mount/reload the reused orchestrator session is fetched and replayed so the
 * transcript and COO thread chips survive a full reload or mobile tab-discard.
 * These transforms are pure (no React/DOM) so they can be unit-tested; use-talk
 * wires them into its bootstrap effect with non-clobbering setState guards.
 */
import type { TranscriptEntry, SystemEntry } from "./types"
import type { TalkGraphNodeWire } from "./protocol"
import { channelHue } from "./channel-identity"
import { stripMarkdown } from "@/lib/strip-markdown"

/**
 * Map a persisted session's messages to FINALIZED transcript entries.
 * User/assistant roles become TranscriptEntry objects (markdown-stripped).
 * Notification rows become SystemEntry objects so delegation history survives
 * a page reload — the ConversationStream component (Task 9) renders them;
 * empty bodies are dropped for user/assistant but never for notifications.
 */
export function messagesToEntries(
  session: Record<string, unknown> | undefined,
): Array<TranscriptEntry | SystemEntry> {
  if (!session) return []
  const history = (session.messages ?? session.history) as unknown
  if (!Array.isArray(history)) return []
  const out: Array<TranscriptEntry | SystemEntry> = []
  for (const raw of history) {
    const m = raw as Record<string, unknown>
    if (m.role === "notification") {
      const content = String(m.content ?? m.text ?? "")
      const id = typeof m.id === "string" && m.id ? m.id : `notification-${out.length}`
      out.push(_parseNotification(id, content))
      continue
    }
    const role = m.role === "user" ? "user" : m.role === "assistant" ? "assistant" : null
    if (!role) continue
    const text = stripMarkdown(String(m.content ?? m.text ?? "")).trim()
    if (!text) continue
    const id = typeof m.id === "string" && m.id ? m.id : `${role}-${out.length}`
    out.push({ id, role, text, partial: false, full: text })
  }
  return out
}

/**
 * Parse a notification content string into a SystemEntry.
 * Classifies by leading emoji: 📩/🔄 → "reported", ⚠️ → "error", other → "info".
 * Extracts the label from the first quoted segment, falling back to first 60 chars.
 */
/** A `delegated` chip payload for use-conversation's addSystem. */
export interface DelegationChip {
  id: string
  event: "delegated"
  label: string
  threadId: string
  hue: number
  ts: number
}

/**
 * Rebuild the `delegated` conversation rows (ThreadCards) from a graph
 * SNAPSHOT. Live delegations insert their row on the talk:graph "added" delta,
 * which a page reload can't replay — so on (re)connect the snapshot's depth-1
 * OWNED nodes are mapped back to the same `sys-del-<id>` rows. Attached nodes
 * (soft links — they get attached/detached chips, not cards) and depth-2+
 * descendants (rendered inside their root's card) are skipped. Ids are stable,
 * so the conversation reducer's dedup-by-id makes re-application (reconnect,
 * raced live delta) a no-op.
 */
export function snapshotDelegationChips(nodes: TalkGraphNodeWire[]): DelegationChip[] {
  return nodes
    .filter((n) => n.depth === 1 && !n.attached)
    .map((n) => ({
      id: `sys-del-${n.id}`,
      event: "delegated" as const,
      label: n.label,
      threadId: n.id,
      hue: channelHue(n.label || n.id),
      ts: Date.parse(n.lastActivity) || Date.now(),
    }))
}

function _parseNotification(id: string, content: string): SystemEntry {
  const emojiMatch = content.match(/^(📩|⚠️|🔄)/)
  const quotedMatch = content.match(/"([^"]+)"/)
  const label = quotedMatch ? quotedMatch[1] : content.slice(0, 60)
  let event: SystemEntry["event"] = "info"
  if (emojiMatch) {
    event = emojiMatch[1] === "⚠️" ? "error" : "reported"
  }
  return { id, kind: "system", event, label }
}
