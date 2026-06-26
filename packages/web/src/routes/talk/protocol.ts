/**
 * Cuttlefish Talk — frontend protocol (Phase 2 real loop).
 *
 * Mirrors packages/cuttlefish/src/talk/protocol.ts. The WS event names + payloads are
 * the contract between the gateway and the real-loop hook (use-talk.ts). Card is
 * reused verbatim from ./types (the renderer's input).
 */
import type { Card, AvatarState } from "./types"

export type { Card }
export type TalkState = AvatarState // idle | listening | thinking | speaking

export const TALK_EVENTS = {
  state: "talk:state",
  transcript: "talk:transcript",
  say: "talk:say",
  audio: "talk:audio",
  card: "talk:card",
  cardUpdate: "talk:card:update",
  cardDismiss: "talk:card:dismiss",
  cardClear: "talk:card:clear",
  focus: "talk:focus",
  threadLabel: "talk:thread:label",
  turnDone: "talk:turn:done",
  ttsDownloadProgress: "talk:tts:download:progress",
  ttsDownloadComplete: "talk:tts:download:complete",
  ttsDownloadError: "talk:tts:download:error",
  engine: "talk:engine",
  graph: "talk:graph",
} as const

export interface TalkStateEvent { sessionId: string; state: TalkState }
export interface TalkTranscriptEvent { sessionId: string; role: "user"; text: string }
export interface TalkSayEvent { sessionId: string; text: string; final?: boolean }
export interface TalkAudioEvent { sessionId: string; seq: number; mime: string; dataBase64: string; last?: boolean }
export interface TalkCardEvent { sessionId: string; card: Card }
export interface TalkCardUpdateEvent { sessionId: string; cardId: string; patch: Partial<Card> }
export interface TalkCardDismissEvent { sessionId: string; cardId: string }
export interface TalkCardClearEvent { sessionId: string }
export interface TalkTurnDoneEvent { sessionId: string; ok: boolean; error?: string }
/** Which COO child the orchestrator is delegating to / narrating (Path 1). */
export interface TalkFocusEvent { cooId: string; label: string; parentId: string }
/** Orchestrator sets/refines a COO thread's topic label. */
export interface TalkThreadLabelEvent { sessionId: string; threadId: string; label: string }
/** The active orchestrator engine/model changed (POST /api/talk/engine). The model
 *  applies on the live session's next turn; the engine is new-chat-only (the UI
 *  re-bootstraps the talk session for an engine change). */
export interface TalkEngineEvent { engine: string | null; model: string | null; fallback: boolean }

/**
 * Core gateway stream events the Talk loop also consumes (Path 1). The voice
 * orchestrator is a normal gateway session, so its reply arrives as session:delta
 * `text` chunks and the turn ends with session:completed — both keyed by the
 * orchestrator's sessionId.
 */
export interface SessionDeltaEvent {
  sessionId: string
  type: "text" | "text_snapshot" | "tool_use" | "tool_result" | "status" | "context"
  content?: string | number
  toolName?: string
  toolId?: string
  /** Truncated (≤200 chars) stringified tool input. Present on PreToolUse-sourced
   *  `tool_use` deltas only; absent on the initial SSE-proxy delta. */
  input?: string
}
export interface SessionCompletedEvent { sessionId: string; result?: string | null; error?: string | null }

/** One node of the delegation tree under the orchestrator (Mission Control). */
export interface TalkGraphNodeWire {
  id: string; parentId: string | null; depth: number; label: string
  employee: string | null; status: string; lastActivity: string
  /** First ~140 chars of the session's prompt — "what was asked" of this node. */
  briefExcerpt?: string
  /** Present (true) when the node is an attachment (soft link), not an owned descendant. */
  attached?: true
  /** Attachment mode — only on attached nodes. */
  mode?: "observe" | "engage"
}
export interface TalkGraphEvent {
  rootId: string
  change: "added" | "status" | "completed" | "removed" | "attached" | "detached"
  node: TalkGraphNodeWire
}
