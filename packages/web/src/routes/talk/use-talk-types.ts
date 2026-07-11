import type { SttState } from "@/hooks/use-stt"
import type { GraphNode } from "./graph-store"
import type { ActivityMap } from "./thread-activity"
import type { AvatarState, Card } from "./types"
import type { StreamRow } from "./use-conversation"
import type { DockSideMap } from "./work-dock-layout"

export type TtsStatus =
  | { kind: "idle" }
  | { kind: "downloading"; progress: number }
  | { kind: "ready" }
  | { kind: "error"; message: string }

/** Which voice actually produced the most recent spoken turn. `neural` = the
 *  gateway streamed Kokoro audio (talk:audio) and it played; `fallback` = the
 *  browser Web-Speech synth (or caption-only). null → nothing spoken yet. This
 *  makes a silent Kokoro break visible instead of degrading unnoticed. */
export type VoiceMode = "neural" | "fallback" | null

/** Active orchestrator engine/model + the available set, for the picker. */
export interface TalkEngineInfo {
  engine: string | null
  model: string | null
  fallback: boolean
  reason: string | null
  available: string[]
  /** False until GET /api/talk/engine has resolved — so an empty `available`
   *  before the first fetch isn't mistaken for "no engine installed". */
  loaded: boolean
}

export interface UseTalkReturn {
  state: AvatarState
  /** Short under-orb hint of the orchestrator's latest tool_use while thinking
   *  (routing… / searching… / preparing a card… / working…). Null when not thinking. */
  whisper: string | null
  /** This talk session's id (orchestratorId) — the `sessionId` for talkDelegate
   *  calls. Null until the orchestrator session is bootstrapped. */
  orchestratorId: string | null
  /** The persistent conversation: user lines, AURA replies, delegation chips. */
  rows: StreamRow[]
  /**
   * Full delegation-graph: every session in the talk tree at any depth. Depth-1
   * nodes are the COO threads (WorkTree root rows); depth-2+ are employee
   * descendants (indented sub-rows). Nodes persist and NEVER auto-hide — idle nodes
   * are dimmed by the renderer. This is the SINGLE source for the work rail.
   */
  graph: GraphNode[]
  /**
   * Advisory per-node overlay keyed by sessionId: live "now doing" line while a
   * node works + sanitized final-report excerpt on completion. Renders alongside
   * the graph (the structural source); a missing entry just renders nothing.
   */
  activity: ActivityMap
  /** Per-node UI side-state (rename overrides + dismiss tombstones) for the dock. */
  sideState: DockSideMap
  /** Hue of the focused (most-recent running depth-1) node — drives the orb
   *  morph; undefined → AURA's amber identity. */
  focusHue: number | undefined
  /** The thread the next dispatch is routed to continue (null → new thread). */
  targetThreadId: string | null
  /** Detail cards the orchestrator pushed for the current answer(s). */
  cards: Card[]
  /** Blocking cards (approval/choice) the user has acted on — un-pinned from the
   *  bottom strip optimistically before the orchestrator dismisses them. */
  resolvedCardIds: ReadonlySet<string>
  /** Resolve a card's inline anchor to a stream row id (null → render at end). */
  cardAnchorFor: (cardId: string) => string | null
  /** 0..1 while listening/speaking (server audio), undefined → orb self-animates. */
  level: number | undefined
  connected: boolean
  listening: boolean
  sttAvailable: boolean | null
  /** Last speech-to-text failure (null when none). Surfaced so a failed turn
   * isn't silent; tapping the mic again clears it and retries. */
  sttError: string | null
  ttsStatus: TtsStatus
  /** Voice that produced the last spoken turn (neural Kokoro vs Web-Speech). */
  voiceMode: VoiceMode
  /** Silent/text mode: when true AURA doesn't speak; replies are read. */
  muted: boolean
  /** Toggle silent/text mode (persisted; silences any in-flight speech). */
  toggleMute: () => void
  /** Type-to-talk: send a typed message via the same path as a voice turn. */
  sendText: (text: string) => void
  /** Raw STT lifecycle state — drives the whisper-model-download modal. */
  sttState: SttState
  /** 0..100 while the whisper model downloads (null otherwise). */
  sttDownloadProgress: number | null
  /** Kick off the local whisper model download (progress streams over WS). */
  startSttDownload: () => void
  /** Dismiss the download modal and return the avatar to idle. */
  dismissSttDownload: () => void
  /** Active orchestrator engine/model + available engines (for the picker). */
  engineInfo: TalkEngineInfo
  /** Switch the orchestrator ENGINE — persists then RE-BOOTSTRAPS the session so
   *  the new engine is adopted immediately (a live PTY can't swap mid-turn). */
  switchEngine: (engine: string) => void
  /** Switch the orchestrator MODEL — applies on the live session's next turn. */
  switchModel: (model: string) => void
  /** Route the next dispatch to continue an existing thread (null → new). */
  selectThread: (id: string | null) => void
  /** Rename a thread's topic label (UI-only). */
  renameThread: (id: string, label: string) => void
  /** Remove a thread chip (does not kill the gateway session). */
  dismissThread: (id: string) => void
  /**
   * Begin the heavy bootstrap (create/reuse the orchestrator session, probe TTS,
   * rehydrate). Idempotent. TalkPage calls this on mount; the provider is
   * globally mounted but stays dormant until a page activates it.
   */
  activate: () => void
  /**
   * Action channel: a decision-card button sends a synthetic user message back
   * to the orchestrator (reuses the same sendMessage path as the mic). The
   * message carries a machine `[card-action …]` tag the orchestrator interprets.
   */
  cardAction: (message: string) => void
  startListening: () => void
  stop: () => void
  /**
   * Interrupt the current spoken reply: stops Web-Speech / server audio
   * playback and returns the avatar to idle. Playback-stop only — it does not
   * re-open the mic or cancel the (already-finished) backend turn.
   */
  stopSpeaking: () => void
}
