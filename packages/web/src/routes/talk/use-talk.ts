/**
 * Cuttlefish Talk — real voice-loop hook (Path 1).
 *
 * The voice orchestrator is a REAL gateway session (source:"talk"). Loop:
 *   mic → useStt → POST /api/sessions/{orchestratorId}/message
 *        → the orchestrator streams its reply as session:delta `text` (caption)
 *          and is spoken aloud. TTS is browser SpeechSynthesis by default (works
 *          on iOS/Android, no server deps); if the gateway ever streams Kokoro
 *          audio (talk:audio) we prefer that instead.
 *        → when it delegates to a COO child, the gateway emits talk:focus; we
 *          track that child so the UI can render it as a satellite orb.
 *        → when a COO child finishes, the orchestrator is woken (📩) and narrates
 *          — another session:delta + spoken turn.
 *
 * Mic control is plain tap-to-talk: tap the mic to start listening, tap again to
 * send. After a reply is spoken the loop returns to idle and waits for the next tap.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import { useGateway } from "@/hooks/use-gateway"
import { useStt } from "@/hooks/use-stt"
import { useSpeak } from "./use-speak"
import { stripMarkdown } from "@/lib/strip-markdown"
import { api } from "@/lib/api"
import { TalkAudioPlayer } from "./audio-player"
import {
  TALK_EVENTS,
  type TalkAudioEvent,
  type TalkFocusEvent,
  type TalkThreadLabelEvent,
  type TalkCardEvent,
  type TalkCardUpdateEvent,
  type TalkCardDismissEvent,
  type TalkEngineEvent,
  type TalkGraphEvent,
  type SessionDeltaEvent,
  type SessionCompletedEvent,
} from "./protocol"
import { graphReducer, type GraphNode, type GraphAction } from "./graph-store"
import { activityFor, threadActivityReducer, type ActivityMap } from "./thread-activity"
import type { AvatarState, Card } from "./types"
import { useConversation, type StreamRow } from "./use-conversation"
import { whisperFor } from "./talk-whisper"
import { joinStreamChunks } from "./stream-text"
import { channelHue } from "./channel-identity"
import { focusNode, deriveLabel, type DockSideMap, type DockSideState } from "./work-dock-layout"
import { MAX_CARDS, loadSideState } from "./talk-side-state"
import { useTalkSessionLifecycle } from "./use-talk-session-lifecycle"
import type { TalkEngineInfo, TtsStatus, UseTalkReturn, VoiceMode } from "./use-talk-types"
import {
  loadTargetThread,
  loadThreadLabels,
  saveThreadLabel,
  removeThreadLabel,
  addDismissedThread,
} from "./talk-storage"

export type { TalkEngineInfo, TtsStatus, UseTalkReturn, VoiceMode } from "./use-talk-types"

export function useTalk(): UseTalkReturn {
  const gateway = useGateway()

  const [state, setState] = useState<AvatarState>("idle")
  // Short under-orb hint reflecting the orchestrator's latest tool_use while it
  // thinks (routing… / searching… / preparing a card… / working…). Rendered only
  // during `thinking`; cleared the moment the turn leaves that state (effect below).
  const [whisper, setWhisper] = useState<string | null>(null)
  // The persistent conversation lives in the ConversationStream reducer; these
  // stable action creators replace the old single-exchange `entries` state.
  const {
    rows,
    appendUser,
    finalizeUser,
    removePendingUser,
    appendAssistant: appendAssistantRow,
    markSpoken,
    finalizeAssistant,
    addSystem,
    rehydrate: rehydrateRows,
    anchorCard,
    unanchorCard,
    pruneAnchors,
    cardAnchorFor,
  } = useConversation()
  // Dock side-state (rename overrides + dismiss tombstones), lazy-init from the
  // existing talk-storage localStorage so renames/dismissals survive a reload.
  const [sideState, setSideState] = useState<DockSideMap>(() => loadSideState())
  // Lazy-init from localStorage so a routed-thread selection survives a reload.
  const [targetThreadId, setTargetThreadId] = useState<string | null>(() => loadTargetThread())
  const [cards, setCards] = useState<Card[]>([])
  // Blocking cards (approval/choice) the user has acted on this session. Used to
  // un-pin them optimistically the instant the action fires, before the
  // orchestrator dismisses the card. Pruned to the live card set below.
  const [resolvedCardIds, setResolvedCardIds] = useState<ReadonlySet<string>>(() => new Set())
  const [level, setLevel] = useState<number | undefined>(undefined)
  const [ttsStatus, setTtsStatus] = useState<TtsStatus>({ kind: "idle" })
  const [voiceMode, setVoiceMode] = useState<VoiceMode>(null)
  // Silent/text mode: when muted, AURA does not speak (Kokoro audio is discarded
  // client-side + Web-Speech is cancelled) and replies are read in the transcript.
  // Persisted so the preference survives reloads.
  const [muted, setMuted] = useState<boolean>(() => {
    if (typeof window === "undefined") return false
    return localStorage.getItem("talk-muted") === "1"
  })
  const [engineInfo, setEngineInfo] = useState<TalkEngineInfo>({
    engine: null,
    model: null,
    fallback: false,
    reason: null,
    available: [],
    loaded: false,
  })

  // Heavy bootstrap is gated on activation (TalkPage calls activate() on mount),
  // so the globally-mounted provider doesn't create a talk session until used.
  const [activated, setActivated] = useState(false)
  const activate = useCallback(() => setActivated(true), [])

  const [orchestratorId, setOrchestratorId] = useState<string | null>(null)
  const orchestratorIdRef = useRef<string | null>(null)
  orchestratorIdRef.current = orchestratorId

  const playerRef = useRef<TalkAudioPlayer | null>(null)
  if (!playerRef.current) playerRef.current = new TalkAudioPlayer()

  const speak = useSpeak()
  const speakRef = useRef(speak)
  speakRef.current = speak

  const levelRafRef = useRef<number>(0)
  const levelModeRef = useRef<"mic" | "output" | null>(null)
  // Throttle state for the level loop: last committed value + timestamp, so the
  // rAF can sample every frame but only re-render the orb tree ~25fps.
  const levelLastValRef = useRef<number | undefined>(undefined)
  const levelLastCommitRef = useRef(0)
  const turnSeqRef = useRef(0)

  // Per-turn assistant bubble + accumulated text (for Web Speech on completion).
  const asstIdRef = useRef<string | null>(null)
  const turnTextRef = useRef("")
  const turnCounterRef = useRef(0)
  // Did the gateway stream Kokoro audio this turn? If so we DON'T also Web-Speak.
  const audioThisTurnRef = useRef(false)
  // Live mirror so the WS audio handler + speak path read the current mute
  // without re-subscribing.
  const mutedRef = useRef(muted)
  mutedRef.current = muted
  const [graph, setGraph] = useState<GraphNode[]>([])
  const dispatchGraph = useCallback((a: GraphAction) => {
    setGraph((prev) => graphReducer(prev, a))
  }, [])
  // Advisory per-node overlay: live "now doing" lines + final report excerpts,
  // keyed by sessionId. Fed from child session:delta / session:completed below;
  // the graph stays the structural source (a missing entry renders nothing).
  const [activity, dispatchActivity] = useReducer(threadActivityReducer, new Map() as ActivityMap)

  // Known session ids (graph) so we can route child stream events. Synced from
  // `graph` each render AND added immediately on focus/graph deltas (so a child
  // delta arriving the same tick still routes).
  const threadIdsRef = useRef<Set<string>>(new Set())
  threadIdsRef.current = new Set(graph.map((g) => g.id))
  // Live mirrors for WS-callback / send closures.
  const graphRef = useRef<GraphNode[]>(graph)
  graphRef.current = graph
  const sideStateRef = useRef<DockSideMap>(sideState)
  sideStateRef.current = sideState
  // Live mirror of the conversation rows so rehydrate can guard "seed only when
  // empty" without re-creating itself every time a row streams in.
  const rowsRef = useRef<StreamRow[]>(rows)
  rowsRef.current = rows
  const targetThreadIdRef = useRef<string | null>(targetThreadId)
  targetThreadIdRef.current = targetThreadId

  // Id of the live "pending" user row inserted on startListening (the "…" the
  // conversation shows while we capture/transcribe). Finalized to the STT text on
  // a successful turn, removed on cancel/abort/empty/error. Null when none.
  const pendingUserIdRef = useRef<string | null>(null)
  const clearPendingUser = useCallback(() => {
    const id = pendingUserIdRef.current
    if (id) {
      removePendingUser(id)
      pendingUserIdRef.current = null
    }
  }, [removePendingUser])

  // Drop the under-orb whisper the instant the turn stops thinking — speaking,
  // idle, or listening should never carry a stale "routing…" hint.
  useEffect(() => {
    if (state !== "thinking") setWhisper(null)
  }, [state])

  // Pass the gateway's `stt:*` event stream so the whisper-model download
  // progress/completion lands here too (same source ChatInput's useStt uses).
  const stt = useStt(gateway.events)
  const sttRef = useRef(stt)
  sttRef.current = stt

  // ---- Level rAF loop (mic listening OR server-audio output) ---------------
  const stopLevelLoop = useCallback(() => {
    if (levelRafRef.current) {
      cancelAnimationFrame(levelRafRef.current)
      levelRafRef.current = 0
    }
    levelModeRef.current = null
    levelLastValRef.current = undefined
    levelLastCommitRef.current = 0
    setLevel(undefined)
  }, [])

  const startLevelLoop = useCallback((mode: "mic" | "output") => {
    if (levelRafRef.current && levelModeRef.current === mode) return
    if (levelRafRef.current) cancelAnimationFrame(levelRafRef.current)
    levelModeRef.current = mode
    // The rAF samples every frame (smooth source for the orb springs) but
    // setLevel — which re-renders the orb tree — is gated: at most ~25fps and
    // only when the value moved a perceptible amount. Edge transitions to/from
    // undefined always commit so listening/idle handoffs are never dropped.
    const MIN_COMMIT_MS = 40
    const MIN_DELTA = 0.01
    const commit = (next: number | undefined) => {
      const prev = levelLastValRef.current
      const edge = (next === undefined) !== (prev === undefined)
      const changed =
        next !== undefined && prev !== undefined && Math.abs(next - prev) >= MIN_DELTA
      if (!edge && !changed) return
      const now = performance.now()
      if (!edge && now - levelLastCommitRef.current < MIN_COMMIT_MS) return
      levelLastCommitRef.current = now
      levelLastValRef.current = next
      setLevel(next)
    }
    const tick = () => {
      if (mode === "mic") {
        const analyser = sttRef.current.analyser
        if (analyser) {
          const buf = new Uint8Array(analyser.fftSize)
          analyser.getByteTimeDomainData(buf)
          let sum = 0
          for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128
            sum += v * v
          }
          const rms = Math.sqrt(sum / buf.length)
          commit(Math.min(1, rms * 3.2))
        } else commit(undefined)
      } else {
        const player = playerRef.current
        commit(player && player.playing ? player.level : undefined)
      }
      levelRafRef.current = requestAnimationFrame(tick)
    }
    levelRafRef.current = requestAnimationFrame(tick)
  }, [])

  // ---- Conversation helpers ------------------------------------------------
  // The full raw reply lives in turnTextRef (for the spoken pass); we push the
  // FULL accumulated, markdown-stripped text into the stream reducer each delta,
  // which re-splits it into sentences (one persistent AURA row, sentences grow).
  const appendAssistantText = useCallback((fragment: string) => {
    if (!asstIdRef.current) {
      turnCounterRef.current += 1
      asstIdRef.current = `a${turnCounterRef.current}`
      turnTextRef.current = ""
    }
    // joinStreamChunks inserts the missing space at content-block boundaries
    // (text before/after a tool call streams as separate blocks with no
    // separator — "…now.On it" → "…now. On it").
    turnTextRef.current = joinStreamChunks(turnTextRef.current, fragment)
    appendAssistantRow(asstIdRef.current, stripMarkdown(turnTextRef.current))
  }, [appendAssistantRow])

  // ---- Dock side-state mutators --------------------------------------------
  // The WorkTree reads the graph directly; these layer user renames + dismiss
  // tombstones over it (persisted to the existing talk-storage keys). Nodes
  // NEVER auto-hide — idle/done dims (Mission Control); only an explicit dismiss
  // removes a row (the gateway child stays alive).
  const patchSide = useCallback((id: string, patch: Partial<DockSideState>) => {
    setSideState((prev) => {
      const next = new Map(prev)
      next.set(id, { ...(next.get(id) ?? {}), ...patch })
      return next
    })
  }, [])

  // ---- Thread controls (work rail) -----------------------------------------
  const selectThread = useCallback((id: string | null) => setTargetThreadId(id), [])
  const renameThread = useCallback((id: string, label: string) => {
    if (label.trim()) {
      patchSide(id, { labelOverride: label.trim() })
      saveThreadLabel(id, label.trim()) // persist override so it survives reload
    }
  }, [patchSide])
  const dismissThread = useCallback((id: string) => {
    patchSide(id, { dismissed: true, labelOverride: undefined })
    setTargetThreadId((cur) => (cur === id ? null : cur))
    // Tombstone it (so rehydrate won't resurrect the chip from the still-alive
    // gateway child) and prune its now-dead label override.
    addDismissedThread(id)
    removeThreadLabel(id)
  }, [patchSide])

  // ---- Detail-card surface (orchestrator pushes via POST /api/talk/card) ----
  // talk:card upserts by id (re-posting the same id updates it in place);
  // talk:card:update patches one card; :dismiss drops one; :clear wipes all.
  const upsertCard = useCallback((card: Card) => {
    setCards((prev) => {
      const i = prev.findIndex((c) => c.id === card.id)
      if (i !== -1) {
        const next = prev.slice()
        next[i] = card
        return next
      }
      const next = [...prev, card]
      return next.length > MAX_CARDS ? next.slice(next.length - MAX_CARDS) : next
    })
    // Anchor the card to the turn that pushed it (the current live edge). A
    // re-push (same id) is a no-op in the anchor reducer, so the original anchor
    // is preserved. Eviction cleanup happens in the prune effect below.
    anchorCard(card.id)
  }, [anchorCard])

  const patchCard = useCallback((id: string, patch: Partial<Card>) => {
    setCards((prev) => prev.map((c) => (c.id === id ? ({ ...c, ...patch } as Card) : c)))
  }, [])

  const dismissCard = useCallback((id: string) => {
    setCards((prev) => prev.filter((c) => c.id !== id))
    unanchorCard(id)
  }, [unanchorCard])

  const clearCards = useCallback(() => setCards([]), [])

  // Keep anchors and resolved-markers in lockstep with the live card set: any
  // card removed (dismiss / clear / MAX_CARDS eviction) drops its anchor and its
  // resolved marker. Reducers/setters return the same reference when nothing
  // changes, so this never loops.
  useEffect(() => {
    const liveIds = cards.map((c) => c.id)
    pruneAnchors(liveIds)
    setResolvedCardIds((prev) => {
      if (prev.size === 0) return prev
      const live = new Set(liveIds)
      let changed = false
      const next = new Set<string>()
      for (const id of prev) {
        if (live.has(id)) next.add(id)
        else changed = true
      }
      return changed ? next : prev
    })
  }, [cards, pruneAnchors])

  // ---- Action channel (decision-card buttons) ------------------------------
  // A card button sends a SYNTHETIC user message back to the orchestrator —
  // the same sendMessage path the mic uses. No new WS event / route. The human
  // tail (after the machine `[card-action …]` tag) is shown as a user line.
  const cardAction = useCallback((message: string) => {
    const orch = orchestratorIdRef.current
    const msg = message.trim()
    if (!orch || !msg) return
    // Resolve the acted-on card: parse `card=<id>` from the machine tag and mark
    // it resolved so the pinned strip releases it immediately (optimistic), even
    // before the orchestrator dismisses it.
    const cardId = msg.match(/^\[card-action\s+card=([^\s\]]+)/)?.[1]
    if (cardId) {
      setResolvedCardIds((prev) => {
        if (prev.has(cardId)) return prev
        const next = new Set(prev)
        next.add(cardId)
        return next
      })
    }
    const display = stripMarkdown(msg.replace(/^\[card-action[^\]]*\]\s*/, "")).trim()
    if (display) {
      appendUser(`u${Date.now()}`, display)
    }
    setState("thinking")
    api.sendMessage(orch, { message: msg }).catch(() => { setState("idle"); stopLevelLoop() })
  }, [stopLevelLoop, appendUser])

  // ---- WS subscription -----------------------------------------------------
  useEffect(() => {
    const player = playerRef.current!
    player.onIdle(() => {
      setState((s) => (s === "speaking" ? "idle" : s))
      stopLevelLoop()
    })

    const sid = (p: unknown): string | undefined =>
      typeof p === "object" && p !== null ? (p as { sessionId?: string }).sessionId : undefined

    const GLOBAL_TTS = new Set<string>([
      TALK_EVENTS.ttsDownloadProgress,
      TALK_EVENTS.ttsDownloadComplete,
      TALK_EVENTS.ttsDownloadError,
    ])

    // Speak the completed reply. The transcript is driven SENTENCE-BY-SENTENCE
    // across ALL paths: each sentence REPLACES the caption (tagged with its
    // index) so it switches in sync with the voice instead of showing one
    // concatenated blob. We always route through speak() — it picks Web Speech,
    // or the estimated-timer fallback (no synth), or caption-only timers
    // (`mute`, when Kokoro audio is already playing). Markdown is stripped so
    // the TTS never reads syntax aloud.
    const speakReplyIfNeeded = (asstId: string | null) => {
      const mutedNow = mutedRef.current
      const kokoro = audioThisTurnRef.current && !mutedNow
      audioThisTurnRef.current = false
      const text = stripMarkdown(turnTextRef.current).trim()
      // Lock in the complete sentence list before the karaoke pass (the last
      // streaming delta may have raced session:completed).
      if (asstId && text) appendAssistantRow(asstId, text)
      const finalize = () => {
        if (!asstId) return
        finalizeAssistant(asstId)
      }
      // markSpoken is driven by use-speak's onSentence callback, which fires as
      // each sentence utterance STARTS (Web-Speech boundary events, or the
      // estimated-timer fallback when no synth) — true per-sentence karaoke sync
      // without a second event source.
      const captionSentence = ({ index }: { text: string; index: number }) => {
        if (!asstId) return
        markSpoken(asstId, index)
      }
      if (!text) {
        finalize()
        setState("idle")
        stopLevelLoop()
        return
      }
      // Record which voice is producing this turn so the UI can show neural vs
      // fallback. `kokoro` is true only when server talk:audio actually arrived
      // and played — so a silent Kokoro break surfaces here as "fallback". When
      // muted there is no voice at all → null (the UI shows a "Muted" badge).
      setVoiceMode(mutedNow ? null : kokoro ? "neural" : "fallback")
      setState("speaking")
      // When kokoro is true, server audio owns the speaking/idle transition via
      // player.onIdle — speak() runs caption-only timers and we only finalize.
      const onDone = () => {
        if (!kokoro) {
          setState((s) => (s === "speaking" ? "idle" : s))
          stopLevelLoop()
        }
        finalize()
      }
      // mute the synth when Kokoro audio owns playback OR the user muted: both
      // run caption-only timers so the transcript advances without any sound.
      speakRef.current
        .speak(text, { mute: mutedNow || kokoro, onSentence: captionSentence })
        .then(onDone)
        .catch(onDone)
    }

    const unsub = gateway.subscribe((event: string, payload: unknown) => {
      if (GLOBAL_TTS.has(event)) {
        if (event === TALK_EVENTS.ttsDownloadProgress) setTtsStatus({ kind: "downloading", progress: (payload as { progress?: number }).progress ?? 0 })
        else if (event === TALK_EVENTS.ttsDownloadComplete) setTtsStatus({ kind: "ready" })
        else setTtsStatus({ kind: "error", message: (payload as { error?: string }).error ?? "TTS error" })
        return
      }

      if (event === TALK_EVENTS.engine) {
        const ev = payload as TalkEngineEvent
        setEngineInfo((prev) => ({
          ...prev,
          engine: ev.engine,
          model: ev.model,
          fallback: ev.fallback,
        }))
        return
      }

      if (event === TALK_EVENTS.focus) {
        const ev = payload as TalkFocusEvent
        if (ev.parentId === orchestratorIdRef.current) {
          // Register for stream routing now (the dock node itself comes from the
          // talk:graph "added" delta — graph is the single source).
          threadIdsRef.current.add(ev.cooId)
        }
        return
      }

      if (event === TALK_EVENTS.threadLabel) {
        const ev = payload as TalkThreadLabelEvent
        if (ev.sessionId === orchestratorIdRef.current && ev.label.trim()) {
          // Server-refined topic label: apply as a transient label override so it
          // shows live on the dock chip. NOT persisted (the graph snapshot carries
          // the label on reload) and it never clobbers a user rename.
          const userSet = loadThreadLabels()[ev.threadId]
          if (!userSet) patchSide(ev.threadId, { labelOverride: ev.label.trim() })
        }
        return
      }

      if (event === TALK_EVENTS.graph) {
        const ev = payload as TalkGraphEvent
        if (ev.rootId === orchestratorIdRef.current) {
          threadIdsRef.current.add(ev.node.id)
          if (ev.change === "removed" || ev.change === "detached")
            dispatchGraph({ type: "remove", id: ev.node.id })
          else dispatchGraph({ type: "upsert", node: ev.node })
          // The dock renders depth-1 nodes straight from the graph — no second
          // mirror to keep in sync. Below we still emit conversation chips.
          // Conversation delegation chips. Owned children: "added" → delegated
          // (completion is carried by the ThreadCard's report line, not a chip).
          // Attachments: their own attached/detached chips.
          const n = ev.node
          if (n.depth === 1) {
            const hue = channelHue(n.label || n.id)
            if (ev.change === "added" && !n.attached) {
              addSystem({ id: `sys-del-${n.id}`, event: "delegated", label: n.label, threadId: n.id, hue, ts: Date.now() })
            } else if (ev.change === "attached") {
              addSystem({ id: `sys-att-${n.id}`, event: "attached", label: n.label, threadId: n.id, hue, ts: Date.now() })
            } else if (ev.change === "detached") {
              addSystem({ id: `sys-det-${n.id}-${Date.now()}`, event: "detached", label: n.label, threadId: n.id, hue, ts: Date.now() })
            }
          }
        }
        return
      }

      const s = sid(payload)
      const isOrch = s === orchestratorIdRef.current
      const isChild = s !== undefined && threadIdsRef.current.has(s)

      switch (event) {
        case "session:delta": {
          const ev = payload as SessionDeltaEvent
          if (isOrch) {
            if (ev.type === "text" && typeof ev.content === "string" && ev.content) {
              appendAssistantText(ev.content)
              setState((st) => (st === "speaking" ? st : "thinking"))
            } else if (ev.type === "tool_use") {
              // Surface what the orchestrator is doing as a short under-orb whisper.
              // The PreToolUse-sourced delta carries `input` (truncated tool_input JSON)
              // so whisperFor can distinguish delegate/search/card from generic work.
              setWhisper(whisperFor({ toolName: ev.toolName, content: ev.content, input: ev.input }))
            }
          } else if (isChild && s) {
            dispatchGraph({ type: "setStatus", id: s, status: "running" }) // keep working
            // Surface what the worker is doing — the delegation-card live line.
            if (ev.type === "tool_use") {
              dispatchActivity({ type: "activity", id: s, text: activityFor({ toolName: ev.toolName, content: ev.content, input: ev.input }) })
            } else if (ev.type === "text" || ev.type === "text_snapshot") {
              dispatchActivity({ type: "activity", id: s, text: "writing…" })
            }
          }
          break
        }
        case TALK_EVENTS.audio: {
          if (!isOrch) break
          // Muted = silent/read mode: discard server (Kokoro) audio entirely.
          // The caption still advances via speakReplyIfNeeded's mute path.
          if (mutedRef.current) break
          const ev = payload as TalkAudioEvent
          audioThisTurnRef.current = true
          player.enqueue(ev.seq, ev.mime, ev.dataBase64, ev.last)
          setState("speaking")
          startLevelLoop("output")
          break
        }
        case TALK_EVENTS.card: {
          if (!isOrch) break
          upsertCard((payload as TalkCardEvent).card)
          break
        }
        case TALK_EVENTS.cardUpdate: {
          if (!isOrch) break
          const ev = payload as TalkCardUpdateEvent
          patchCard(ev.cardId, ev.patch)
          break
        }
        case TALK_EVENTS.cardDismiss: {
          if (!isOrch) break
          dismissCard((payload as TalkCardDismissEvent).cardId)
          break
        }
        case TALK_EVENTS.cardClear: {
          if (!isOrch) break
          clearCards()
          break
        }
        case "session:completed": {
          const ev = payload as SessionCompletedEvent
          if (isOrch) {
            // Hand the finished assistant entry id to the speaker so it can swap
            // the caption per spoken sentence; the speaker finalizes `partial`.
            const finishedId = asstIdRef.current
            asstIdRef.current = null
            speakReplyIfNeeded(finishedId)
          } else if (isChild && s) {
            // A failed child reads as "error" in the card + tree (a later server
            // graph upsert may correct it — that's fine, it's fresher).
            dispatchGraph({ type: "setStatus", id: s, status: ev.error ? "error" : "idle" })
            // The live line ends; keep a sanitized excerpt of the final report.
            // Fall back to ev.error so a failed child shows something instead of blank.
            dispatchActivity({ type: "report", id: s, text: ev.result ?? ev.error ?? "" })
          }
          break
        }
      }
    })

    return () => { unsub() }
  }, [gateway, appendAssistantText, appendAssistantRow, finalizeAssistant, markSpoken, addSystem, patchSide, dispatchGraph, startLevelLoop, stopLevelLoop, upsertCard, patchCard, dismissCard, clearCards])

  const { switchEngine, switchModel } = useTalkSessionLifecycle({
    activated,
    connectionSeq: gateway.connectionSeq,
    targetThreadId,
    mutedRef,
    orchestratorIdRef,
    rowsRef,
    graphRef,
    setOrchestratorId,
    setTargetThreadId,
    setTtsStatus,
    setEngineInfo,
    rehydrateRows,
    addSystem,
    dispatchGraph,
  })

  // ---- Whisper model download (mic tap on a fresh install) -----------------
  // When the mic tap finds no local STT model, useStt flips to "no-model"; drop
  // the optimistic "listening" state back to idle so the download modal reads
  // cleanly. dismiss returns to idle; startDownload streams progress over WS.
  useEffect(() => {
    if (stt.state === "no-model") {
      clearPendingUser()
      setState((s) => (s === "listening" ? "idle" : s))
      stopLevelLoop()
    }
  }, [stt.state, stopLevelLoop, clearPendingUser])

  const dismissSttDownload = useCallback(() => {
    sttRef.current.dismissDownload()
    clearPendingUser()
    setState((s) => (s === "listening" ? "idle" : s))
    stopLevelLoop()
  }, [stopLevelLoop, clearPendingUser])

  // ---- Mic control (plain tap-to-talk) -------------------------------------
  const startListening = useCallback(() => {
    playerRef.current?.resume()
    // Unlock browser TTS within the user gesture (iOS Safari requires this, or
    // the post-network reply is silently blocked).
    try { speakRef.current.prime() } catch { /* noop */ }
    // Insert a pending user row so the conversation shows we're capturing the
    // turn. STT here is record-then-transcribe (no interim partials), so it stays
    // an "…" placeholder until stop() finalizes it to the transcript text. Clear
    // any stale pending row first (defensive — normal flow already finalized it).
    clearPendingUser()
    const id = `u${Date.now()}`
    pendingUserIdRef.current = id
    appendUser(id, "…", true)
    setState("listening")
    startLevelLoop("mic")
    void sttRef.current.handleMicClick()
  }, [startLevelLoop, appendUser, clearPendingUser])

  // ---- Shared send path (voice + typed) ------------------------------------
  // The single way a user message reaches the orchestrator: shows the clean text
  // as a user line, applies the thread route-hint override, and POSTs. Reused by
  // BOTH the mic (stop()) and the typed-text input so they never diverge.
  const sendToOrchestrator = useCallback((rawText: string) => {
    const orch = orchestratorIdRef.current
    const text = rawText.trim()
    if (!orch || !text) return
    const clean = stripMarkdown(text)
    // A voice turn already has a pending "…" row (from startListening) — finalize
    // it in place to the transcript text. A typed turn has none → append fresh.
    const pendingId = pendingUserIdRef.current
    if (pendingId) {
      finalizeUser(pendingId, clean)
      pendingUserIdRef.current = null
    } else {
      appendUser(`u${Date.now()}`, clean)
    }
    // Switch override: if a thread is selected, prepend a machine route hint so
    // the orchestrator CONTINUES that COO session instead of spawning a new one.
    // The transcript keeps the clean text; only the engine sees the hint. The
    // target's label is resolved from the graph (single source) + any user
    // rename override, matching exactly what the dock chip shows.
    const targetId = targetThreadIdRef.current
    const targetNode = targetId
      ? graphRef.current.find((n) => n.id === targetId)
      : null
    const outbound = targetNode
      ? `[Route this to the existing "${sideStateRef.current.get(targetNode.id)?.labelOverride ?? deriveLabel(targetNode.label || targetNode.id)}" COO thread: session ${targetNode.id}. Continue that thread instead of spawning a new one.]\n${text}`
      : text
    setState("thinking")
    api.sendMessage(orch, { message: outbound }).catch(() => {
      setState("idle"); stopLevelLoop()
    })
  }, [stopLevelLoop, appendUser, finalizeUser])

  /** Type-to-talk: send a typed message exactly like a transcribed voice turn.
   *  Works even when STT is unavailable — the graceful fallback for the mic. */
  const sendText = useCallback((text: string) => {
    sendToOrchestrator(text)
  }, [sendToOrchestrator])

  /** Toggle silent/text mode. Turning it ON silences any in-flight speech now. */
  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m
      try { localStorage.setItem("talk-muted", next ? "1" : "0") } catch { /* noop */ }
      // Tell the gateway so it skips (or resumes) server-side Kokoro synthesis.
      const orch = orchestratorIdRef.current
      if (orch) void api.talkSetMuted({ sessionId: orch, muted: next }).catch(() => {})
      if (next) {
        try { speakRef.current.cancel() } catch { /* noop */ }
        playerRef.current?.reset()
        setState((st) => (st === "speaking" ? "idle" : st))
        stopLevelLoop()
      }
      return next
    })
  }, [stopLevelLoop])

  const stop = useCallback(async () => {
    turnSeqRef.current++
    const seq = turnSeqRef.current
    const s = sttRef.current
    if (s.state === "recording") {
      setState("thinking")
      const text = await s.stopRecording()
      if (turnSeqRef.current !== seq) return
      if (text && text.trim()) {
        sendToOrchestrator(text)
      } else {
        // Empty/failed transcription — drop the pending row and wait for the next tap.
        clearPendingUser()
        setState("idle"); stopLevelLoop()
      }
    } else {
      s.cancelRecording()
      playerRef.current?.reset()
      clearPendingUser()
      setState("idle"); stopLevelLoop()
    }
  }, [stopLevelLoop, sendToOrchestrator, clearPendingUser])

  // ---- Interrupt playback (Stop button while speaking) ---------------------
  // Cancels the in-flight Web-Speech sentence chain (and its caption timers) and
  // resets the server-audio player in case Kokoro audio is playing, then drops
  // to idle. The backend turn already completed by the time we're speaking, so
  // there's nothing to cancel server-side; this is pure playback-stop.
  const stopSpeaking = useCallback(() => {
    try { speakRef.current.cancel() } catch { /* noop */ }
    playerRef.current?.reset()
    setState((s) => (s === "speaking" ? "idle" : s))
    stopLevelLoop()
  }, [stopLevelLoop])

  // ---- Cleanup -------------------------------------------------------------
  useEffect(() => {
    return () => {
      if (levelRafRef.current) cancelAnimationFrame(levelRafRef.current)
      try { speakRef.current.cancel() } catch { /* noop */ }
      playerRef.current?.dispose()
      playerRef.current = null
    }
  }, [])

  const listening = stt.state === "recording"

  // The focused channel hue drives the main-orb morph: the most-recent running
  // depth-1 node's identity hue (undefined → AURA's amber when nothing runs).
  const focusHue = useMemo(() => {
    const n = focusNode(graph)
    return n ? channelHue(n.label || n.id) : undefined
  }, [graph])

  return useMemo(
    () => ({
      state, whisper, orchestratorId, rows, graph, activity, sideState, focusHue, targetThreadId, cards, level,
      resolvedCardIds, cardAnchorFor,
      connected: gateway.connected,
      listening,
      sttAvailable: stt.available,
      sttError: stt.error,
      ttsStatus,
      voiceMode,
      muted, toggleMute, sendText,
      sttState: stt.state,
      sttDownloadProgress: stt.downloadProgress,
      startSttDownload: stt.startDownload,
      dismissSttDownload,
      engineInfo,
      switchEngine, switchModel,
      selectThread, renameThread, dismissThread,
      activate, cardAction,
      startListening, stop, stopSpeaking,
    }),
    [state, whisper, orchestratorId, rows, graph, activity, sideState, focusHue, targetThreadId, cards, level, resolvedCardIds, cardAnchorFor, gateway.connected, listening, stt.available, stt.error, stt.state, stt.downloadProgress, stt.startDownload, ttsStatus, voiceMode, muted, toggleMute, sendText, dismissSttDownload, engineInfo, switchEngine, switchModel, selectThread, renameThread, dismissThread, activate, cardAction, startListening, stop, stopSpeaking],
  )
}
