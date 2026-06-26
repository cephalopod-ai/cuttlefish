/**
 * Cuttlefish Talk — backend protocol (Phase 2, real e2e voice loop).
 *
 * Canonical types shared by the /talk Agent-SDK turn, the tool dispatcher, the
 * Kokoro TTS sidecar, and the HTTP/WS plumbing. The card shapes MUST stay 1:1
 * with the frontend renderer in packages/web/src/routes/talk/types.ts — the
 * agent's show_card tool input is exactly this union.
 */

export type TalkState = "idle" | "listening" | "thinking" | "speaking"
export type JobStatus = "queued" | "running" | "done" | "error"

// ---------------------------------------------------------------------------
// Content cards — 1:1 mirror of web/src/routes/talk/types.ts `Card`.
// ---------------------------------------------------------------------------
export interface CardBase {
  id: string
  title?: string
  badge?: string
}
export interface TextCard extends CardBase { type: "text"; body: string; tldr?: string }
export interface StatCard extends CardBase {
  type: "stat"; value: string; label: string
  delta?: { dir: "up" | "down" | "flat"; value: string }
}
export interface ListCard extends CardBase {
  type: "list"; ordered?: boolean; items: Array<{ text: string; done?: boolean }>
}
export interface ImageCard extends CardBase { type: "image"; src: string; alt?: string; caption?: string }
export interface ImageGridCard extends CardBase { type: "image-grid"; images: Array<{ src: string; alt?: string }> }
export interface StatusCard extends CardBase {
  type: "status"; label: string; progress: number; state: JobStatus; chips?: string[]
}
export interface AgentActivity {
  id: string; name: string; role: string; status: JobStatus; detail?: string; progress?: number
}
export interface AgentActivityCard extends CardBase { type: "agent-activity"; agents: AgentActivity[] }
export interface LinkCard extends CardBase { type: "link"; url: string; label: string; source?: string }

// Decision-support cards — INTERACTIVE (buttons send a synthetic user message
// back to the orchestrator; see web use-talk `cardAction`).
export interface CardKV { k: string; v: string }
export interface ChoiceCard extends CardBase {
  type: "choice"; prompt?: string
  options: Array<{ id: string; label: string; detail?: string; badge?: string; meta?: CardKV[] }>
}
export interface ComparisonCard extends CardBase {
  type: "comparison"; columns: string[]
  rows: Array<{ label: string; cells: string[]; highlight?: number }>
}
export interface ApprovalCard extends CardBase {
  type: "approval"; summary: string; details?: CardKV[]
  confirmLabel?: string; rejectLabel?: string; danger?: boolean
}
export interface KeyValueCard extends CardBase {
  type: "keyvalue"; rows: Array<{ k: string; v: string; tone?: "good" | "bad" | "neutral" }>
}
export interface DiffCard extends CardBase {
  type: "diff"; hunks: Array<{ label?: string; before?: string; after?: string }>
}

export type Card =
  | TextCard | StatCard | ListCard | ImageCard
  | ImageGridCard | StatusCard | AgentActivityCard | LinkCard
  | ChoiceCard | ComparisonCard | ApprovalCard | KeyValueCard | DiffCard

export interface TrackerTask {
  id: string
  label: string
  owner: string
  status: JobStatus
  progress?: number
  result?: string
}

// ---------------------------------------------------------------------------
// WebSocket events broadcast to web clients (envelope: { event, payload, ts }).
// Names are the single source of truth — frontend mirrors these.
// ---------------------------------------------------------------------------
export const TALK_EVENTS = {
  state: "talk:state",
  transcript: "talk:transcript",
  say: "talk:say",
  audio: "talk:audio",
  card: "talk:card",
  cardUpdate: "talk:card:update",
  cardDismiss: "talk:card:dismiss",
  cardClear: "talk:card:clear",
  task: "talk:task",
  focus: "talk:focus",
  graph: "talk:graph",
  threadLabel: "talk:thread:label",
  engine: "talk:engine",
  turnDone: "talk:turn:done",
  ttsDownloadProgress: "talk:tts:download:progress",
  ttsDownloadComplete: "talk:tts:download:complete",
  ttsDownloadError: "talk:tts:download:error",
} as const

export interface TalkStateEvent { sessionId: string; state: TalkState }
export interface TalkTranscriptEvent { sessionId: string; role: "user"; text: string }
/** A chunk of the assistant's spoken reply (also what TTS voices). */
export interface TalkSayEvent { sessionId: string; text: string; final?: boolean }
/** One sentence-level TTS audio chunk, base64-encoded, ordered by seq. */
export interface TalkAudioEvent { sessionId: string; seq: number; mime: string; dataBase64: string; last?: boolean }
export interface TalkCardEvent { sessionId: string; card: Card }
export interface TalkCardUpdateEvent { sessionId: string; cardId: string; patch: Partial<Card> }
export interface TalkCardDismissEvent { sessionId: string; cardId: string }
export interface TalkCardClearEvent { sessionId: string }
export interface TalkTaskEvent { sessionId: string; task: TrackerTask }
export interface TalkTurnDoneEvent { sessionId: string; ok: boolean; error?: string }
/**
 * The active orchestrator engine/model changed (POST /api/talk/engine). The model
 * applies on the live session's next turn; the engine — new-chat-only, mirroring
 * PATCH /api/sessions — applies when the talk session is next (re)created. Harmless
 * if a client doesn't handle it.
 */
export interface TalkEngineEvent {
  engine: string | null
  model: string
  /** True when the requested/configured engine was unavailable and we fell back. */
  fallback: boolean
}

// ---------------------------------------------------------------------------
// HTTP request/response shapes.
// ---------------------------------------------------------------------------
export interface TalkTurnRequest { sessionId: string; text: string }
export interface TalkTurnResponse { ok: boolean; error?: string }
export interface TalkTtsRequest { text: string; voice?: string }
export interface TalkStatusResponse {
  ttsAvailable: boolean
  ttsDownloading: boolean
  progress: number
  voice: string
  ready: boolean
}

/** Broadcast function injected everywhere (matches gateway server's `emit`). */
export type Emit = (event: string, payload: unknown) => void

/** Kokoro-82M TTS engine (sidecar-backed). Implemented by kokoro.ts. */
export interface Tts {
  /**
   * Synthesize `text`, sentence-chunked, streaming talk:audio events; resolves
   * with the number of chunks emitted. `seqStart` continues a per-turn monotonic
   * sequence across calls; `final:false` suppresses the `last:true` flag so a
   * turn streamed sentence-by-sentence only signals end-of-audio on the flush.
   */
  speak(sessionId: string, text: string, emit: Emit, opts?: { seqStart?: number; final?: boolean }): Promise<number>
  /**
   * One-shot synthesis of arbitrary `text` into a single WAV buffer (no WS
   * streaming). Backs the standalone POST /api/tts read-aloud surface. Rejects if
   * the engine is unavailable (missing venv/weights).
   */
  synthesize(text: string): Promise<Buffer>
  status(): { available: boolean; downloading: boolean; progress: number; voice: string; ready: boolean }
  /** Pre-spawn the sidecar and load the model so the first real speak is fast. No-op if weights/venv are missing. */
  warm?(): Promise<void>
  /** Download Kokoro weights on first use, emitting talk:tts:download:* events. */
  download(emit: Emit): Promise<void>
  shutdown(): void
}

// ---------------------------------------------------------------------------
// Voice orchestrator (Path 1) — WS events the gateway emits for the Talk surface
// on top of the canonical `talk:*` set above. `talk:focus` tells the UI which
// COO child the orchestrator is currently delegating to / narrating, so the
// avatar can animate to that "channel".
// ---------------------------------------------------------------------------
export interface TalkFocusEvent {
  /** The COO child session now in focus (the orchestrator's parentSessionId === orchestrator). */
  cooId: string
  /** Short human label for the channel (derived from the brief). */
  label: string
  /** The orchestrator session that owns this COO child. */
  parentId: string
}

/**
 * The orchestrator (or a process on its behalf) sets/refines a COO thread's
 * topic label. `sessionId` is the orchestrator (talk) surface; `threadId` is the
 * COO child session id. POST /api/talk/thread/label emits this.
 */
export interface TalkThreadLabelEvent {
  sessionId: string
  threadId: string
  label: string
}
