import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { api } from '@/lib/api'
import type { MediaAttachment } from '@/lib/conversations'
import { MediaPreview } from './media-preview'
import { useStt } from '@/hooks/use-stt'
import { WhisperDownloadModal } from '@/components/stt/whisper-download-modal'
import { ChatInputComposer } from './chat-input-composer'
import { CommandSuggestions, MentionSuggestions } from './chat-input-suggestions'
import {
  BUILTIN_COMMANDS,
  fileToAttachment,
  resolveClientCommand,
  type Employee,
  type SlashCommand,
} from './chat-input-utils'

export { resolveClientCommand, type ClientCommand } from './chat-input-utils'

/** Hold threshold (ms) that separates a quick tap from a tap-and-hold. */
export const MIC_HOLD_THRESHOLD_MS = 250

export type MicGesture = 'hold' | 'tap'

/**
 * Pure classifier for the mic button gesture. A press held for at least
 * `threshold` ms is a push-to-talk hold; anything shorter is a quick tap.
 * Exported for unit testing.
 */
export function classifyMicGesture(
  downAt: number,
  upAt: number,
  threshold: number = MIC_HOLD_THRESHOLD_MS,
): MicGesture {
  return upAt - downAt >= threshold ? 'hold' : 'tap'
}

interface ChatInputProps {
  disabled: boolean
  loading: boolean
  onSend: (message: string, media?: MediaAttachment[], interrupt?: boolean) => void
  onInterrupt?: () => void
  onNewSession: () => void
  onStatusRequest: () => void
  /** Incremented when skills change on the gateway, triggers re-fetch */
  skillsVersion?: number
  /** WebSocket events from useGateway — needed for STT download progress */
  events?: Array<{ event: string; payload: unknown }>
  /** Files dropped onto the chat area (from parent drag & drop) */
  droppedFiles?: File[]
  /** Called after droppedFiles have been consumed as pending attachments */
  onDroppedFilesConsumed?: () => void
  /** Incrementing counter that triggers textarea focus when changed */
  focusTrigger?: number
  /** Callback to open keyboard shortcuts overlay */
  onShortcutsClick?: () => void
  /** Optional Engine/Model/Effort selector row, rendered just above the input. */
  selectorSlot?: React.ReactNode
  /** Optional compact terminal controls rendered with the helper hints on desktop. */
  terminalActionsSlot?: React.ReactNode
  /** Optional compact terminal controls rendered as a tucked icon on mobile. */
  mobileTerminalActionsSlot?: React.ReactNode
  /** Keeps the terminal hint footprint reserved when inactive to avoid mode-switch shifts. */
  reserveTerminalActions?: boolean
}

/* ── Component ──────────────────────────────────────────── */

export function ChatInput({
  disabled,
  loading,
  onSend,
  onInterrupt,
  onNewSession,
  onStatusRequest,
  skillsVersion,
  events,
  droppedFiles,
  onDroppedFilesConsumed,
  focusTrigger,
  onShortcutsClick,
  selectorSlot,
  terminalActionsSlot,
  mobileTerminalActionsSlot,
  reserveTerminalActions,
}: ChatInputProps) {
  const [value, setValue] = useState('')
  const [employees, setEmployees] = useState<Employee[]>([])
  const [showMentions, setShowMentions] = useState(false)
  const [mentionFilter, setMentionFilter] = useState('')
  const [mentionIndex, setMentionIndex] = useState(0)
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>(BUILTIN_COMMANDS)
  const [showCommands, setShowCommands] = useState(false)
  const [commandFilter, setCommandFilter] = useState('')
  const [commandIndex, setCommandIndex] = useState(0)
  const [pendingAttachments, setPendingAttachments] = useState<MediaAttachment[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const rafRef = useRef<number | null>(null)

  const resize = useCallback((el: HTMLTextAreaElement) => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 180) + 'px'
    })
  }, [])

  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  // Focus textarea when focusTrigger changes (session select / "+ New").
  // Skip on mobile — auto-focus pops the on-screen keyboard, which is jarring
  // when the trigger is a session switch the user did with their thumb.
  // Defer with requestAnimationFrame so the textarea has finished mounting
  // after ChatPane's key-driven remount.
  useEffect(() => {
    if (!focusTrigger || focusTrigger <= 0) return
    if (window.innerWidth < 768) return
    const raf = requestAnimationFrame(() => textareaRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [focusTrigger])
  const mentionItemRefs = useRef<Map<number, HTMLButtonElement>>(new Map())

  const stt = useStt(events, (text) => {
    // Called when timeout auto-stops recording and transcription completes
    if (text) {
      setValue((prev) => prev ? prev + ' ' + text : text)
    }
  })

  // Consume files dropped onto the chat area by the parent
  const consumedRef = useRef<File[] | undefined>(undefined)
  useEffect(() => {
    if (!droppedFiles || droppedFiles.length === 0) return
    // Guard against React Strict Mode double-firing the effect
    if (consumedRef.current === droppedFiles) return
    consumedRef.current = droppedFiles
    ;(async () => {
      const newAttachments: MediaAttachment[] = []
      for (const file of droppedFiles) {
        newAttachments.push(await fileToAttachment(file))
      }
      setPendingAttachments((prev) => [...prev, ...newAttachments])
      onDroppedFilesConsumed?.()
    })()
  }, [droppedFiles, onDroppedFilesConsumed])

  // Load employees for @mention (with full details)
  useEffect(() => {
    api
      .getOrg()
      .then((data) => {
        if (!Array.isArray(data.employees)) return
        setEmployees(data.employees.map((emp) => ({
          name: emp.name,
          displayName: emp.displayName,
          department: emp.department,
          rank: emp.rank,
          engine: emp.engine,
          avatar: emp.avatar,
          emoji: emp.emoji,
        })))
      })
      .catch(() => {})
  }, [])

  // Load skills as slash commands (re-fetches when skills change on gateway)
  useEffect(() => {
    api.getSkills()
      .then((skills) => {
        if (!Array.isArray(skills)) return
        const skillCommands: SlashCommand[] = skills
          .filter((s) => !BUILTIN_COMMANDS.some((b) => b.name === s.name))
          .map((s) => ({
            name: s.name as string,
            description: (s.description as string) || '',
            needsEmployee: s.name === 'sync',
          }))
        setSlashCommands([...BUILTIN_COMMANDS, ...skillCommands])
      })
      .catch(() => {})
  }, [skillsVersion])


  const handleMentionSelect = useCallback(
    (name: string) => {
      const atIdx = value.lastIndexOf('@')
      if (atIdx !== -1) {
        const before = value.slice(0, atIdx)
        setValue(before + '@' + name + ' ')
      }
      setShowMentions(false)
      textareaRef.current?.focus()
    },
    [value]
  )

  const handleCommandSelect = useCallback(
    (cmd: SlashCommand) => {
      if (cmd.needsEmployee) {
        // Insert command + @ to trigger mention autocomplete
        setValue('/' + cmd.name + ' @')
        setShowCommands(false)
        // Trigger mention dropdown
        setMentionFilter('')
        setMentionIndex(0)
        setShowMentions(true)
      } else {
        setValue('/' + cmd.name)
        setShowCommands(false)
      }
      textareaRef.current?.focus()
    },
    []
  )

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value
    setValue(val)

    // Detect slash commands: text starts with / and has no space yet (still typing the command name)
    if (val.startsWith('/') && !val.includes(' ')) {
      const filter = val.slice(1).toLowerCase()
      setCommandFilter(filter)
      setCommandIndex(0)
      setShowCommands(true)
      setShowMentions(false)
      return
    }
    setShowCommands(false)

    // Detect @mentions
    const atIdx = val.lastIndexOf('@')
    if (atIdx !== -1) {
      const afterAt = val.slice(atIdx + 1)
      if (!afterAt.includes(' ') && !afterAt.includes('\n')) {
        setMentionFilter(afterAt.toLowerCase())
        setMentionIndex(0)
        setShowMentions(true)
        return
      }
    }
    setShowMentions(false)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Command autocomplete navigation
    if (showCommands && filteredCommands.length > 0) {
      const max = filteredCommands.length
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCommandIndex((prev) => (prev + 1) % max)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCommandIndex((prev) => (prev - 1 + max) % max)
        return
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault()
        handleCommandSelect(filteredCommands[commandIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setShowCommands(false)
        return
      }
    }

    // Mention autocomplete navigation
    if (showMentions && filteredEmployees.length > 0) {
      const max = Math.min(filteredEmployees.length, 8)
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionIndex((prev) => (prev + 1) % max)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIndex((prev) => (prev - 1 + max) % max)
        return
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault()
        handleMentionSelect(filteredEmployees[mentionIndex].name)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setShowMentions(false)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  function handleSubmit() {
    const trimmed = value.trim()
    const hasMedia = pendingAttachments.length > 0

    if ((!trimmed && !hasMedia) || disabled) return

    const command = resolveClientCommand(trimmed)
    if (command === 'new') {
      setValue('')
      onNewSession()
      return
    }
    if (command === 'status') {
      setValue('')
      onStatusRequest()
      return
    }
    const mediaToSend = hasMedia ? [...pendingAttachments] : undefined
    setValue('')
    setPendingAttachments([])
    setShowMentions(false)
    setShowCommands(false)

    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }

    onSend(trimmed, mediaToSend, false)
  }

  async function handleFileAttach(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (!files || files.length === 0) return

    const newAttachments: MediaAttachment[] = []
    for (let i = 0; i < files.length; i++) {
      newAttachments.push(await fileToAttachment(files[i]))
    }
    setPendingAttachments((prev) => [...prev, ...newAttachments])
    e.target.value = ''
  }

  function removePendingAttachment(index: number) {
    setPendingAttachments((prev) => prev.filter((_, i) => i !== index))
  }

  async function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items
    if (!items) return

    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        e.preventDefault()
        const file = items[i].getAsFile()
        if (file) {
          const att = await fileToAttachment(file)
          setPendingAttachments((prev) => [...prev, att])
        }
        return
      }
    }
  }

  /* ── Speech-to-text (offline whisper.cpp) ─────────────── */

  const fillTextarea = useCallback((text: string) => {
    if (!text) return
    setValue((prev) => prev ? prev + ' ' + text : text)
  }, [])

  // Auto-resize textarea when value changes programmatically (e.g., from STT)
  useEffect(() => {
    if (textareaRef.current) {
      resize(textareaRef.current)
    }
  }, [value, resize])

  // Stop the current recording, transcribe, and drop the text into the input.
  const transcribeAndFill = useCallback(async () => {
    const text = await stt.stopRecording()
    fillTextarea(text ?? '')
    textareaRef.current?.focus()
  }, [stt, fillTextarea])

  /* ── Mic gestures: tap-and-hold (push-to-talk) + quick-tap (toggle) ──── */
  // Refs avoid stale-closure races between pointerdown and pointerup.
  const micDownAtRef = useRef<number | null>(null)   // timestamp of an active press
  const micHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const micToggleActiveRef = useRef(false)           // recording left on by a quick tap

  useEffect(() => {
    return () => {
      if (micHoldTimerRef.current) clearTimeout(micHoldTimerRef.current)
    }
  }, [])

  function handleMicPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    // Keep the card click-to-focus handler from also firing.
    e.stopPropagation()
    if (stt.state === 'transcribing') return

    // Already recording from a previous quick tap → this press toggles it off.
    if (micToggleActiveRef.current || stt.state === 'recording') {
      micToggleActiveRef.current = false
      micDownAtRef.current = null
      if (micHoldTimerRef.current) { clearTimeout(micHoldTimerRef.current); micHoldTimerRef.current = null }
      void transcribeAndFill()
      return
    }

    // Begin a fresh press: start recording and arm the hold detector.
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* noop */ }
    micDownAtRef.current = Date.now()
    if (micHoldTimerRef.current) clearTimeout(micHoldTimerRef.current)
    micHoldTimerRef.current = setTimeout(() => { micHoldTimerRef.current = null }, MIC_HOLD_THRESHOLD_MS)
    // handleMicClick() starts recording, or opens the download modal if no model.
    stt.handleMicClick()
  }

  function handleMicPointerUp() {
    const downAt = micDownAtRef.current
    if (downAt == null) return // no active press (e.g. toggle-off already handled)
    micDownAtRef.current = null
    if (micHoldTimerRef.current) { clearTimeout(micHoldTimerRef.current); micHoldTimerRef.current = null }

    // If the model wasn't ready, recording never started — leave the modal alone.
    if (stt.state === 'no-model' || stt.state === 'transcribing') return

    const gesture = classifyMicGesture(downAt, Date.now())
    if (gesture === 'hold') {
      // Push-to-talk release → stop + transcribe.
      void transcribeAndFill()
    } else {
      // Quick tap that started recording → leave it running; next tap stops it.
      micToggleActiveRef.current = true
    }
  }

  const filteredCommands = useMemo(
    () => slashCommands.filter((c) => c.name?.toLowerCase().startsWith(commandFilter)),
    [slashCommands, commandFilter]
  )

  const filteredEmployees = useMemo(
    () => employees.filter((e) => e.name?.toLowerCase().includes(mentionFilter)),
    [employees, mentionFilter]
  )

  const hasContent = value.trim().length > 0 || pendingAttachments.length > 0

  return (
    <div className="px-3 sm:px-4 pt-[var(--space-3)] pb-[max(var(--safe-bottom),var(--space-3))] bg-[var(--bg)] shrink-0 relative">
      {/* Soft top scrim — fades scrolling content into the composer instead of a
          hard 1px divider. Borderless, readable over the thread in both themes. */}
      <div aria-hidden className="pointer-events-none absolute -top-5 left-0 right-0 h-5 bg-gradient-to-b from-transparent to-[var(--bg)]" />
      {showCommands && (
        <CommandSuggestions
          commands={filteredCommands}
          highlightedIndex={commandIndex}
          onSelect={handleCommandSelect}
        />
      )}

      {showMentions && (
        <MentionSuggestions
          employees={filteredEmployees}
          highlightedIndex={mentionIndex}
          itemRefs={mentionItemRefs}
          onSelect={handleMentionSelect}
        />
      )}

      {/* Pending attachments preview */}
      {pendingAttachments.length > 0 && (
        <div className="mb-[var(--space-2)]">
          <MediaPreview
            attachments={pendingAttachments}
            onRemove={removePendingAttachment}
          />
        </div>
      )}

      <ChatInputComposer
        disabled={disabled}
        loading={loading}
        value={value}
        hasContent={hasContent}
        textareaRef={textareaRef}
        fileInputRef={fileInputRef}
        stt={stt}
        selectorSlot={selectorSlot}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onInput={(e) => resize(e.target as HTMLTextAreaElement)}
        onFileAttach={handleFileAttach}
        onMicPointerDown={handleMicPointerDown}
        onMicPointerUp={handleMicPointerUp}
        onSubmit={handleSubmit}
        onInterrupt={onInterrupt}
      />

      {/* Slim helper row — shortcuts + terminal access (CLI view). Quiet; the
          command/mention hints were dropped (discoverable by typing / or @). */}
      {(onShortcutsClick || terminalActionsSlot || reserveTerminalActions || mobileTerminalActionsSlot) && (
        <div className="flex items-center justify-end gap-[var(--space-3)] mt-1.5 px-1.5 min-w-0">
          {onShortcutsClick && (
            <button
              onClick={onShortcutsClick}
              className="hidden sm:flex items-center gap-1 text-[length:var(--text-caption2)] text-[var(--text-quaternary)] hover:text-[var(--text-tertiary)] transition-colors bg-transparent border-none cursor-pointer p-0 font-[inherit]"
            >
              <kbd className="font-mono text-[10px] leading-none not-italic">?</kbd>
              <span>shortcuts</span>
            </button>
          )}
          {(terminalActionsSlot || reserveTerminalActions) && (
            <span
              className={`hidden sm:flex items-center text-[length:var(--text-caption2)] text-[var(--text-quaternary)] ${terminalActionsSlot ? '' : 'invisible pointer-events-none'}`}
              aria-hidden={!terminalActionsSlot}
            >
              {terminalActionsSlot ?? (
                <span className="flex items-center gap-1">
                  <kbd className="flex size-4 items-center justify-center text-[10px] leading-none not-italic">⌨</kbd>
                  <span>terminal</span>
                </span>
              )}
            </span>
          )}
          {mobileTerminalActionsSlot && (
            <div className="flex items-center sm:hidden">{mobileTerminalActionsSlot}</div>
          )}
        </div>
      )}

      {/* STT error banner */}
      {stt.state === 'error' && stt.error && (
        <div className="flex items-center gap-[var(--space-2)] mt-[var(--space-2)] py-[var(--space-2)] px-[var(--space-3)] rounded-[var(--radius-sm)] text-[length:var(--text-caption1)] text-[var(--system-red)]" style={{ background: 'color-mix(in srgb, var(--system-red) 12%, transparent)' }}>
          <span className="flex-1">Voice input error: {stt.error}</span>
          <button
            onClick={stt.dismissError}
            className="bg-none border-none cursor-pointer text-[var(--system-red)] text-[length:var(--text-caption1)] font-semibold py-0.5 px-1.5"
          >Dismiss</button>
        </div>
      )}

      {/* STT model download modal */}
      <WhisperDownloadModal
        open={stt.state === 'no-model'}
        progress={stt.downloadProgress}
        onDownload={stt.startDownload}
        onCancel={stt.dismissDownload}
      />

      <style>{`
        @keyframes stt-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        /* Idle base shadow + soft accent ring when the composer holds focus.
           Not a 1px border — a 4px --accent-fill wash. Overridden inline while
           streaming so the brighter loading ring takes precedence. */
        .composer-card { box-shadow: var(--shadow-card); }
        .composer-card:focus-within { box-shadow: var(--shadow-card), 0 0 0 4px var(--accent-fill); }
      `}</style>
    </div>
  )
}
