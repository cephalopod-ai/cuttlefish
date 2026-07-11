import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react"
import { api } from "@/lib/api"
import { messagesToEntries, snapshotDelegationChips } from "./rehydrate"
import { saveTargetThread } from "./talk-storage"
import type { GraphAction, GraphNode } from "./graph-store"
import type { StreamRow, UseConversationReturn } from "./use-conversation"
import type { TalkEngineInfo, TtsStatus } from "./use-talk-types"

interface UseTalkSessionLifecycleOptions {
  activated: boolean
  connectionSeq: number
  targetThreadId: string | null
  mutedRef: MutableRefObject<boolean>
  orchestratorIdRef: MutableRefObject<string | null>
  rowsRef: MutableRefObject<StreamRow[]>
  graphRef: MutableRefObject<GraphNode[]>
  setOrchestratorId: Dispatch<SetStateAction<string | null>>
  setTargetThreadId: Dispatch<SetStateAction<string | null>>
  setTtsStatus: Dispatch<SetStateAction<TtsStatus>>
  setEngineInfo: Dispatch<SetStateAction<TalkEngineInfo>>
  rehydrateRows: UseConversationReturn["rehydrate"]
  addSystem: UseConversationReturn["addSystem"]
  dispatchGraph: (action: GraphAction) => void
}

/**
 * Owns the Talk orchestrator's durable lifecycle: session rehydration, gated
 * bootstrap, reconnect catch-up, and engine/model selection. The live Talk UI
 * state remains in useTalk; it is passed here explicitly so this hook never
 * imports the public use-talk facade.
 */
export function useTalkSessionLifecycle({
  activated,
  connectionSeq,
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
}: UseTalkSessionLifecycleOptions) {
  // ---- Server rehydration --------------------------------------------------
  // Replay the reused orchestrator session so the transcript + COO thread chips
  // survive a full reload / mobile tab-discard. Non-clobbering: a live transcript
  // is never overwritten, and thread rebuilds MERGE (additive) so a reconnect
  // can pick up threads created while the socket was down without dropping live
  // ones. Cards are intentionally NOT rehydrated — they are transient; the
  // orchestrator re-pushes any decision card it still wants on screen.
  const rehydrate = useCallback(async (orchId: string) => {
    try {
      const [session, graphSnap] = await Promise.all([
        api.getSession(orchId).catch(() => undefined),
        api.getTalkGraph(orchId).catch(() => undefined),
      ])
      if (orchestratorIdRef.current !== orchId) return // superseded
      // Seed the ConversationStream from the server snapshot — user/assistant
      // lines AND system delegation chips. Non-clobbering: only seed when the
      // stream is still empty (a live conversation is never overwritten).
      const allEntries = messagesToEntries(session as Record<string, unknown> | undefined)
      if (allEntries.length && rowsRef.current.length === 0) rehydrateRows(allEntries)

      // The dock rebuilds straight from the graph snapshot — the single source.
      // (Child sessions are no longer mirrored into a separate thread store.)
      const snapNodes = graphSnap?.nodes ?? []
      if (snapNodes.length) dispatchGraph({ type: "snapshot", nodes: snapNodes })
      // Rebuild the delegation ThreadCards: live cards are inserted by the
      // talk:graph "added" delta, which a reload can't replay. This runs AFTER
      // rehydrateRows above (dispatches process in order), so rebuilt cards
      // append after history — the original live insertion position is
      // approximated by append-at-end, which is acceptable (cards mostly trail
      // the turn that spawned them). The conversation reducer dedups by row id,
      // so chips already added live (or by a prior reconnect) are no-ops.
      for (const chip of snapshotDelegationChips(snapNodes)) addSystem(chip)
      // Drop a persisted target selection that no longer maps to a live node.
      setTargetThreadId((cur) => {
        if (!cur) return cur
        const exists =
          snapNodes.some((n) => n.id === cur) || graphRef.current.some((n) => n.id === cur)
        return exists ? cur : null
      })
    } catch {
      /* best-effort; a later reconnect rehydrate will retry */
    }
  }, [dispatchGraph, rehydrateRows, addSystem])

  // Marks that the bootstrap has kicked off the INITIAL rehydrate, so the
  // reconnect effect below only gates on it (never consumes it) — otherwise the
  // first genuine reconnect (the first firing where orch is non-null) would be
  // swallowed and a mobile tab-resume right after load wouldn't re-pull.
  const didInitialReconnectRef = useRef(false)

  // Create (or reuse) the orchestrator session and rehydrate it. Extracted so an
  // ENGINE switch can RE-BOOTSTRAP: the POST /api/talk/session reuse-guard refuses
  // to reuse a session whose engine differs from the freshly-resolved one, so a
  // plain re-create lands the new engine on a fresh session id.
  const bootstrapSession = useCallback(async () => {
    try {
      const r = await api.talkCreateSession()
      setOrchestratorId(r.sessionId)
      // Re-apply the current mute state to the (possibly brand-new) session id so
      // the gateway skips synthesis from the first turn when we're in silent mode.
      if (mutedRef.current) void api.talkSetMuted({ sessionId: r.sessionId, muted: true }).catch(() => {})
      void rehydrate(r.sessionId)
      didInitialReconnectRef.current = true
    } catch { /* surfaced via connection hint */ }
  }, [rehydrate])

  // Refresh the active orchestrator engine/model + the available engine set.
  const refreshEngineInfo = useCallback(async () => {
    try {
      const e = await api.talkEngineGet()
      setEngineInfo({
        engine: e.engine, model: e.model, fallback: e.fallback, reason: e.reason, available: e.available, loaded: true,
      })
    } catch { /* keep prior info */ }
  }, [])

  // ---- Bootstrap orchestrator + probe TTS/engine (gated on activation) ------
  useEffect(() => {
    if (!activated) return
    let alive = true
    void bootstrapSession()
    void refreshEngineInfo()
    api.talkStatus()
      .then((s) => {
        if (!alive) return
        if (s.ttsDownloading) setTtsStatus({ kind: "downloading", progress: s.progress ?? 0 })
        else if (s.ttsAvailable) setTtsStatus({ kind: "ready" })
        else setTtsStatus({ kind: "idle" })
      })
      .catch(() => {})
    return () => { alive = false }
  }, [activated, bootstrapSession, refreshEngineInfo])

  // ---- Engine / model switching --------------------------------------------
  // Engine: persist then re-bootstrap (new-chat-only). Model: persist only
  // (applies on the live session's next turn — the backend mutates it for us).
  const switchEngine = useCallback((engine: string) => {
    void (async () => {
      try {
        const r = await api.talkEngineSet({ engine })
        setEngineInfo((prev) => ({
          ...prev, engine: r.engine, model: r.model, fallback: r.fallback, reason: r.reason, available: r.available,
        }))
        await bootstrapSession()
      } catch { /* leave prior engine; fallback surfaced in the picker */ }
    })()
  }, [bootstrapSession])

  const switchModel = useCallback((model: string) => {
    void (async () => {
      try {
        const r = await api.talkEngineSet({ model })
        setEngineInfo((prev) => ({
          ...prev, engine: r.engine, model: r.model, fallback: r.fallback, reason: r.reason, available: r.available,
        }))
      } catch { /* keep prior */ }
    })()
  }, [])

  // ---- Persist the routed-thread selection ---------------------------------
  useEffect(() => { saveTargetThread(targetThreadId) }, [targetThreadId])

  // ---- Re-rehydrate after a WS reconnect (mobile tab-resume) ----------------
  // Only GATES on the bootstrap's initial-rehydrate flag (set in the bootstrap
  // effect, not consumed here), so the first real reconnect after load re-pulls.
  useEffect(() => {
    if (!activated) return
    const orch = orchestratorIdRef.current
    if (!orch) return
    if (!didInitialReconnectRef.current) return // bootstrap hasn't rehydrated yet
    void rehydrate(orch)
  }, [activated, connectionSeq, rehydrate])

  return { switchEngine, switchModel }
}
