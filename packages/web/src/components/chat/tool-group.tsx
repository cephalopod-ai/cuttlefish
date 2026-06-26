import { useState } from "react"
import { ChevronDown, Wrench } from "lucide-react"
import type { Message } from "@/lib/conversations"
import { statusMark } from "./chat-blocks"
import { findActiveToolIndex, isToolDone } from "./chat-message-groups"

export function ToolGroup({
  msgs,
  isActive,
}: {
  msgs: Message[]
  isActive: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const [showAllTools, setShowAllTools] = useState(false)
  const allDone = msgs.every(isToolDone)
  const activeIndex = isActive ? findActiveToolIndex(msgs) : -1
  const label = isActive && !allDone
    ? `${msgs.length} tool${msgs.length !== 1 ? "s" : ""} running…`
    : `${msgs.length} tool${msgs.length !== 1 ? "s" : ""}`
  const indexedMsgs = msgs.map((msg, index) => ({ msg, index }))
  const activeEntry = activeIndex >= 10 ? indexedMsgs[activeIndex] : undefined
  const visibleEntries = showAllTools
    ? indexedMsgs
    : activeEntry
      ? [...indexedMsgs.slice(0, 9), activeEntry]
      : indexedMsgs.slice(0, 10)
  const hiddenToolCount = Math.max(0, msgs.length - visibleEntries.length)

  return (
    // Share the assistant text gutter (.assistant-msg-row -> space-3 / space-8 @lg)
    // so the tool card's left edge lines up with the message text column.
    <div className="assistant-msg-row mb-[var(--space-1)]">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="inline-flex min-h-9 max-w-full items-center gap-2 rounded-full border-none bg-[var(--fill-quaternary)] py-1 pl-3 pr-2.5 text-[length:var(--text-caption1)] text-[var(--text-secondary)] shadow-none transition-[background-color,scale] duration-150 ease-[var(--ease-smooth)] hover:bg-[var(--fill-secondary)] active:scale-[0.97]"
      >
        <Wrench size={13} className="shrink-0 text-[var(--text-tertiary)]" />
        <span className="min-w-0 truncate font-[var(--weight-medium)]">{label}</span>
        {isActive && !allDone && (
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--system-blue)] animate-[cuttlefish-pulse_1.4s_infinite]" />
        )}
        <ChevronDown size={14} className={`ml-0.5 shrink-0 text-[var(--text-quaternary)] transition-transform duration-150 ease-[var(--ease-smooth)] ${expanded ? "rotate-180" : "rotate-0"}`} />
      </button>
      {expanded && (
        <div
          className="mt-1.5 flex max-w-[min(620px,calc(100vw_-_var(--space-6)))] flex-col items-start gap-1 pl-1"
          data-testid="tool-group-list"
        >
          {visibleEntries.map(({ msg: m, index }) => {
            const done = isToolDone(m)
            const key = m.id || `${m.toolCall}-${index}`
            const status = done ? "done" : index === activeIndex ? "running" : "queued"
            return (
              <div
                key={key}
                className="inline-flex min-h-9 max-w-full items-center gap-1.5 px-2.5 py-1 text-left"
              >
                <span className="grid size-4 shrink-0 place-items-center">
                  {statusMark(status)}
                </span>
                <span className="min-w-0 truncate text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-primary)]">
                  {m.toolCall || `Tool ${index + 1}`}
                </span>
              </div>
            )
          })}
          {hiddenToolCount > 0 && (
            <button
              type="button"
              onClick={() => setShowAllTools(true)}
              className="ml-6 inline-flex min-h-8 items-center gap-1 rounded-full border-none bg-transparent px-2.5 text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-tertiary)] transition-[background-color,color,scale] duration-150 ease-[var(--ease-smooth)] hover:bg-[var(--fill-quaternary)] hover:text-[var(--text-secondary)] active:scale-[0.96]"
            >
              Show {hiddenToolCount} more
              <ChevronDown size={13} className="shrink-0 text-[var(--text-quaternary)]" />
            </button>
          )}
        </div>
      )}
    </div>
  )
}
