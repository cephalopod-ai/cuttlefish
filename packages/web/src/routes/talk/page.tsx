/**
 * Cuttlefish Talk — /talk route (AURA voice surface).
 *
 * Mobile-first. The orchestrator orb sits center; when it spawns COO child
 * sessions they appear as rows in the WorkTree rail (right edge). One big mic
 * button drives the loop (tap to talk, tap to send). TTS is browser
 * SpeechSynthesis by default, so it speaks aloud on the phone with no server deps.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { ArrowLeft, Mic, Square, Sun, Moon, Keyboard, Volume2, VolumeX, Send, Search } from "lucide-react"
import { cn } from "@/lib/utils"
import { mainButtonMode } from "./main-button"
import { useTheme } from "@/routes/providers"
import { ConversationStream } from "./conversation-stream"
import { OrbLayer } from "./orb-layer"
import { PinnedCards, selectInlineCards, selectPinnedCards } from "./cards/card-stack"
import { ErrorBoundary } from "@/components/error-boundary"
import { WorkTree } from "./work-tree"
import { ThreadDrawer } from "./thread-drawer"
import { SessionSearchSheet } from "./session-search-sheet"
import { AttachBanner } from "./attach-banner"
import { hasEngageAttachment } from "./session-search"
import { TalkEnginePicker } from "./talk-engine-picker"
import { TalkVoiceIndicator } from "./talk-voice-indicator"
import { WhisperDownloadModal } from "@/components/stt/whisper-download-modal"
import { useTalkContext } from "./talk-provider"
import { useStageMode } from "./stage"
import { isLightTheme } from "@/lib/themes"
import "./talk-tokens.css"
import "./talk-layout.css"

export default function TalkPage() {
  const { theme, setTheme } = useTheme()
  const toggleTheme = useCallback(() => {
    if (theme === 'reef-light') return setTheme('reef-dark')
    if (theme === 'reef-dark') return setTheme('reef-light')
    if (theme === 'signal-light') return setTheme('signal-dark')
    if (theme === 'signal-dark') return setTheme('signal-light')
    setTheme(isLightTheme(theme) ? 'dark' : 'light')
  }, [setTheme, theme])
  // State lives in TalkProvider (above the router) so it survives navigation;
  // activate() kicks off the (gated) bootstrap the first time Talk is opened.
  const talk = useTalkContext()
  const { activate } = talk
  useEffect(() => { activate() }, [activate])
  // Partition cards: blocking approval/choice (unresolved) pin to the bottom
  // strip; everything else renders inline at its anchored turn in the stream.
  const inlineCards = useMemo(
    () => selectInlineCards(talk.cards, talk.resolvedCardIds),
    [talk.cards, talk.resolvedCardIds],
  )
  const pinnedCards = useMemo(
    () => selectPinnedCards(talk.cards, talk.resolvedCardIds),
    [talk.cards, talk.resolvedCardIds],
  )
  // Stage mode — who owns the centre: orb (hero), transcript (conversing), or
  // a blocking card (content). Drives the grid via data-stage + the orb dock.
  const stage = useStageMode({
    state: talk.state,
    hasRows: talk.rows.length > 0,
    pinnedCount: pinnedCards.length,
  })
  // ONE derived flag drives both the dock row activation and the dock-row
  // whisper — the two must stay structurally identical or the whisper can
  // render into a zero-height row.
  const docked = stage !== "hero"
  // Anchors the OrbLayer measures: stage cell centre (hero) + 56px dock box.
  const heroAnchorRef = useRef<HTMLDivElement | null>(null)
  const dockAnchorRef = useRef<HTMLDivElement | null>(null)
  // Which session's chat the peek popup is showing (null → closed).
  const [chatSessionId, setChatSessionId] = useState<string | null>(null)
  // Session-search sheet (opened from the top-bar search icon).
  const [searchOpen, setSearchOpen] = useState(false)
  const showAttachBanner = useMemo(() => hasEngageAttachment(talk.graph), [talk.graph])
  // Type-to-talk: a tucked-away text input for when you can't (or don't want to)
  // speak. Sends via the same path as a voice turn. Works without the mic/STT.
  const [typing, setTyping] = useState(false)
  const [draft, setDraft] = useState("")
  const submitText = useCallback(() => {
    const t = draft.trim()
    if (!t) return
    talk.sendText(t)
    setDraft("")
  }, [draft, talk])

  const isRecording = talk.listening
  // The text input has content → the main mic button morphs into a Send button.
  const hasText = typing && draft.trim().length > 0
  const mode = mainButtonMode({ listening: isRecording, hasText })

  const onMic = useCallback(() => {
    if (talk.listening) talk.stop()
    else talk.startListening()
  }, [talk])

  // One action-aware button: send the draft when there's text, otherwise drive
  // the mic (start, or stop-and-send while recording).
  const onMainButton = useCallback(() => {
    if (mode === "send") submitText()
    else onMic()
  }, [mode, submitText, onMic])

  // Transient "Switched to <engine>" marker — switching the engine re-bootstraps
  // the talk session (new chat), so a quiet note confirms the change landed.
  const [engineNotice, setEngineNotice] = useState<string | null>(null)
  const onSwitchEngine = useCallback((engine: string) => {
    talk.switchEngine(engine)
    const label = engine.charAt(0).toUpperCase() + engine.slice(1)
    setEngineNotice(`Switched to ${label}`)
  }, [talk])
  useEffect(() => {
    if (!engineNotice) return
    const t = window.setTimeout(() => setEngineNotice(null), 2600)
    return () => window.clearTimeout(t)
  }, [engineNotice])

  // No installed engine for the orchestrator → the loop can't run; surface an
  // actionable message instead of letting the mic silently fail.
  const noEngine = talk.engineInfo.loaded && talk.engineInfo.available.length === 0

  const hint = (() => {
    if (!talk.connected) return "Connecting"
    if (noEngine) return "No voice engine — open settings ⚙"
    if (talk.listening) return "Listening"
    if (talk.state === "thinking") return "Thinking"
    if (talk.state === "speaking") return "Speaking"
    // Errors get an actionable sentence (not a one-word state): tapping the mic
    // clears the error and retries, so the mic button doubles as Retry.
    if (talk.sttError) return "Didn't catch that — tap to retry"
    if (talk.ttsStatus.kind === "error") return talk.ttsStatus.message || "No voice output"
    if (talk.sttAvailable === false) return "Mic only"
    return "Tap to talk"
  })()

  return (
    <div
      data-state={talk.state}
      data-stage={stage}
      className="talk-root relative select-none"
      style={{
        background:
          "radial-gradient(125% 125% at 50% 34%, var(--bg-tertiary) 0%, var(--bg) 60%, var(--bg) 100%)",
        color: "var(--text-primary)",
      }}
    >
      {/* row 1: top bar */}
      <div className="talk-topbar">
        <Link
          to="/"
          aria-label="Back to Cuttlefish"
          className="inline-flex h-9 items-center gap-1.5 rounded-full border border-[var(--separator)] bg-[var(--material-regular)] px-3 text-footnote text-[var(--text-secondary)] backdrop-blur-md transition-colors active:bg-[var(--fill-secondary)]"
        >
          <ArrowLeft size={15} /> Dock
        </Link>
        <span className="pointer-events-none select-none font-[family-name:var(--font-code)] text-[10px] uppercase tracking-[0.28em] text-[var(--text-tertiary)]">
          Cuttlefish · Talk <span className="text-[var(--accent)]">// AURA</span>
        </span>
        <div className="flex items-center gap-2">
          {/* Session search — opens the search sheet (title + message FTS). */}
          <button
            onClick={() => setSearchOpen(true)}
            aria-label="Search sessions"
            title="Search sessions"
            className="inline-flex size-9 items-center justify-center rounded-full border border-[var(--separator)] bg-[var(--material-regular)] text-[var(--text-secondary)] backdrop-blur-md transition-colors active:bg-[var(--fill-secondary)]"
          >
            <Search size={16} />
          </button>
          {/* Engine/model picker — tiny gear, tucked beside the theme toggle. */}
          <TalkEnginePicker
            engineInfo={talk.engineInfo}
            onSwitchEngine={onSwitchEngine}
            onSwitchModel={talk.switchModel}
          />
          {/* Mute (silent/read mode) — icon-only, matches the gear + theme buttons. */}
          <button
            onClick={talk.toggleMute}
            aria-pressed={talk.muted}
            aria-label={talk.muted ? "Unmute" : "Mute"}
            title={talk.muted ? "Muted — replies are read, not spoken" : "Mute — silent/read mode"}
            className={cn(
              "inline-flex size-9 items-center justify-center rounded-full border backdrop-blur-md transition-colors",
              talk.muted
                ? "border-[var(--accent)] bg-[var(--accent-fill)] text-[var(--accent)]"
                : "border-[var(--separator)] bg-[var(--material-regular)] text-[var(--text-secondary)] active:bg-[var(--fill-secondary)]",
            )}
          >
            {talk.muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>
          <button
            onClick={toggleTheme}
            aria-label="Toggle theme"
            className="inline-flex size-9 items-center justify-center rounded-full border border-[var(--separator)] bg-[var(--material-regular)] text-[var(--text-secondary)] backdrop-blur-md transition-colors active:bg-[var(--fill-secondary)]"
          >
            {isLightTheme(theme) ? <Moon size={16} /> : <Sun size={16} />}
          </button>
        </div>
      </div>

      {/* row 2: engage-attachment banner(s) — one slim strip per live engage
          soft link. The row collapses to zero height when empty. */}
      <div className="talk-banner-row">
        {showAttachBanner && (
          <AttachBanner graph={talk.graph} orchestratorId={talk.orchestratorId} />
        )}
      </div>

      {/* row 3: orb dock — reserves the docked orb's space; anchor + whisper.
          The OrbLayer below chases the anchor's rect when docked. */}
      <div className="talk-orbdock" data-active={docked}>
        <div ref={dockAnchorRef} className="talk-orbdock__anchor" aria-hidden />
        {docked && talk.state === "thinking" && talk.whisper && (
          <p className="talk-whisper text-caption1 text-[var(--text-quaternary)]">{talk.whisper}</p>
        )}
      </div>

      {/* The persistent orchestrator orb — position:fixed, spring-morphs between
          the stage centre (hero) and the dock anchor above. Placed BEFORE
          .talk-main in the DOM so the stream + pinned cards out-paint it on
          equal z-index. */}
      <OrbLayer
        mode={stage}
        state={talk.state}
        level={talk.level}
        channelHue={talk.focusHue}
        heroAnchorRef={heroAnchorRef}
        dockAnchorRef={dockAnchorRef}
      />

      {/* row 4: main — transcript stage + WorkTree rail */}
      <div className="talk-main">
        <div ref={heroAnchorRef} className="talk-stage">
          {/* Persistent conversation — user lines, AURA karaoke replies,
              delegation chips. Fills the stage cell; the wrapper is
              pointer-events:none and the scroll viewport + links/chips
              re-enable pointer-events. */}
          <ConversationStream
            rows={talk.rows}
            state={talk.state}
            onOpenThread={setChatSessionId}
            graph={talk.graph}
            activity={talk.activity}
            sideState={talk.sideState}
            inlineCards={inlineCards}
            cardAnchorFor={talk.cardAnchorFor}
            onCardAction={talk.cardAction}
          />
        </div>
        <div className="talk-rail">
          {/* WorkTree — the single graph-driven work rail: every node of the
              delegation tree is a labeled row (any depth), ⋯ menu on roots for
              rename/dismiss/pin, live activity lines on working rows. */}
          <WorkTree
            graph={talk.graph}
            sideState={talk.sideState}
            activity={talk.activity}
            targetThreadId={talk.targetThreadId}
            onOpenThread={setChatSessionId}
            onSelectTarget={talk.selectThread}
            onRename={talk.renameThread}
            onDismiss={talk.dismissThread}
            idle={talk.state === "idle"}
          />
        </div>
      </div>

      {/* row 5: pinned blocking cards — ONLY unresolved approval/choice cards,
          always reachable without scrolling the transcript. All other cards
          render INLINE in the stream. Row collapses when empty. */}
      {pinnedCards.length > 0 && (
        <div className="talk-pinned">
          {/* Fence the deck: a malformed card degrades to a small "card failed"
              note instead of unmounting the whole Talk app. Resets when the card
              set changes (orchestrator re-push / clear). */}
          <ErrorBoundary
            label="talk-cards"
            resetKey={pinnedCards.map((c) => c.id).join(",")}
            fallback={
              <div className="pointer-events-none rounded-[var(--radius-lg)] border border-[var(--separator)] bg-[var(--material-regular)] px-4 py-2 text-caption1 text-[var(--text-tertiary)] backdrop-blur-md">
                A card couldn’t be displayed.
              </div>
            }
          >
            <PinnedCards cards={pinnedCards} onAction={talk.cardAction} />
          </ErrorBoundary>
        </div>
      )}

      {/* row 6: bottom controls — a single big mic button + status hint */}
      <div className="talk-controls">
        {talk.state === "speaking" && !talk.muted && (
          <button
            onClick={talk.stopSpeaking}
            aria-label="Stop speaking"
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-[var(--separator)] bg-[var(--material-regular)] px-3 text-footnote text-[var(--text-secondary)] backdrop-blur-md transition-colors active:bg-[var(--fill-secondary)]"
          >
            <Square size={11} className="fill-current" /> Stop
          </button>
        )}
        {/* Transient "Switched to <engine>" marker after an engine re-bootstrap. */}
        {engineNotice && (
          <div className="rounded-full border border-[var(--separator)] bg-[var(--material-regular)] px-3 py-1 text-caption2 text-[var(--text-secondary)] backdrop-blur-md">
            {engineNotice}
          </div>
        )}
        <div className="flex items-center gap-2">
          <p className="text-caption1 text-[var(--text-quaternary)]">{hint}</p>
          {/* Neural-vs-fallback voice indicator (no "Muted" — the active top-right
              mute button already conveys silent mode). */}
          <TalkVoiceIndicator voiceMode={talk.voiceMode} />
        </div>

        {/* Type-to-talk: compact text input, revealed by the keyboard toggle.
            No separate send button — the main button below morphs into Send when
            this has text; Enter also sends. */}
        {typing && (
          <form
            onSubmit={(e) => { e.preventDefault(); submitText() }}
            className="w-full max-w-sm px-4"
          >
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Type a message to AURA…"
              aria-label="Type a message to AURA"
              className="h-10 w-full rounded-full border border-[var(--separator)] bg-[var(--material-regular)] px-4 text-footnote text-[var(--text-primary)] outline-none backdrop-blur-md placeholder:text-[var(--text-quaternary)] focus:border-[var(--accent)]"
            />
          </form>
        )}

        {/* One action-aware button: Mic ↔ Send ↔ Stop by context (see mainButtonMode). */}
        <button
          onClick={onMainButton}
          aria-label={mode === "send" ? "Send message" : mode === "stop" ? "Stop and send" : "Start talking"}
          className={cn(
            "inline-flex size-16 touch-manipulation items-center justify-center rounded-full shadow-[var(--shadow-overlay)] transition-all duration-200 active:scale-95",
            mode === "stop"
              ? "bg-[var(--system-red)] text-white"
              : "bg-[var(--accent)] text-[var(--accent-contrast)]",
          )}
        >
          {mode === "stop" ? (
            <Square size={22} className="fill-current" />
          ) : mode === "send" ? (
            <Send size={24} />
          ) : (
            <Mic size={26} />
          )}
        </button>

        {/* Secondary control: type-to-talk toggle (mute now lives in the top bar). */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setTyping((v) => !v)}
            aria-pressed={typing}
            aria-label="Type a message instead of talking"
            title="Type instead of talk"
            className={cn(
              "inline-flex size-8 items-center justify-center rounded-full border backdrop-blur-md transition-colors",
              typing
                ? "border-[var(--accent)] bg-[var(--accent-fill)] text-[var(--accent)]"
                : "border-[var(--separator)] bg-[var(--material-regular)] text-[var(--text-secondary)] active:bg-[var(--fill-secondary)]",
            )}
          >
            <Keyboard size={15} />
          </button>
        </div>
      </div>

      {/* Thread drawer for a tapped session (chip, tree row, or search row) —
          breadcrumb path + descend into sub-threads, attach controls + engage
          composer. The conversation stays visible behind the scrim. */}
      <ThreadDrawer
        sessionId={chatSessionId}
        onClose={() => setChatSessionId(null)}
        onNavigate={setChatSessionId}
        sideState={talk.sideState}
      />

      {/* Session-search sheet (title + message FTS), opened from the top bar. */}
      <SessionSearchSheet
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onPeek={setChatSessionId}
      />

      {/* Whisper STT model-download — shown when the mic is tapped on a fresh
          install with no local model (same flow /chat uses). */}
      <WhisperDownloadModal
        open={talk.sttState === "no-model"}
        progress={talk.sttDownloadProgress}
        onDownload={talk.startSttDownload}
        onCancel={talk.dismissSttDownload}
      />
    </div>
  )
}
