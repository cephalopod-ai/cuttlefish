
import { type ReactNode } from 'react'
import { ChevronLeft, SquarePen } from 'lucide-react'
import { type ChatTab } from '@/hooks/use-chat-tabs'
import { cn } from '@/lib/utils'
// Frosted pill primitives now live in the shared cross-page pill system.
import { PILL_CLASS, PillButton } from '@/components/pill-nav'

export interface ChatHeaderPillsProps {
  /** Conversation title — slim inline title on desktop, centered on the mobile
   *  thread nav bar. */
  title?: string
  /** Hide the thread chrome on mobile (e.g. over the chat-list view, which is the
   *  body and has its own header + the bottom tab bar). */
  hideOnMobile?: boolean

  /** Mobile-only: pop back from the thread to the chat list. */
  onBack?: () => void
  /** Start a new chat (compose). */
  onNew: () => void
  /** Existing "more" (…) menu element, rendered as the last pill control. */
  moreMenu?: ReactNode

  /** Retained for callers; the in-header tab switcher UI was removed. */
  tabs?: ChatTab[]
  activeIndex?: number
  onSwitch?: (index: number) => void
  onClose?: (index: number) => void
}

// Split a leading "#NNNN - " id prefix off a session title so the desktop title
// can render the id quietly (--text-tertiary) ahead of the name. Titles without
// the prefix (e.g. employee chats) fall through unchanged.
function splitTitleId(title?: string): { id?: string; rest: string } {
  if (!title) return { rest: "" }
  const m = title.match(/^(#\d+)\s*[-–—]\s*(.+)$/)
  return m ? { id: m[1], rest: m[2] } : { rest: title }
}

// The chat thread chrome. The old left toggle pill is gone — the sidebar toggle
// now lives at the top of the nav ribbon, and the conversation title relocates to
// a slim inline title (desktop) / a centered nav-bar title (mobile thread). The
// right actions pill (compose · more) stays.
export function ChatHeaderPills({
  title,
  hideOnMobile,
  onBack,
  onNew,
  moreMenu,
}: ChatHeaderPillsProps) {
  return (
    <>
      {/* DESKTOP — slim inline thread title (top-left, plain text, no pill).
          Understated by design: 15px subheadline, semibold, single line, ellipsis.
          h-10 + top-4 puts its vertical center on the same y as the right actions
          pill and the ribbon's logo/toggle slot — one clean horizontal row. */}
      <div className="pointer-events-none absolute left-6 top-4 z-10 hidden h-10 max-w-[42vw] items-center lg:flex xl:max-w-[48vw]">
        {title && (() => {
          const { id, rest } = splitTitleId(title)
          return (
            <span className="truncate text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] tracking-[-0.01em] text-[var(--text-primary)]">
              {id && <span className="font-[var(--weight-medium)] text-[var(--text-tertiary)]">{id} </span>}
              {rest}
            </span>
          )
        })()}
      </div>

      {/* DESKTOP — right actions pill: compose · more. */}
      <div className="pointer-events-none absolute right-4 top-4 z-10 hidden lg:block">
        <div className={PILL_CLASS}>
          <PillButton onClick={onNew} title="New chat (N)" ariaLabel="New chat">
            <SquarePen size={18} />
          </PillButton>
          {moreMenu}
        </div>
      </div>

      {/* MOBILE — thread nav bar: back · centered title · compose · more. Hidden
          over the list (the tab bar + list header own that screen). Frosted, no
          hairline at rest; content scrolls under it via the thread's top scrim. */}
      {!hideOnMobile && (
        <div
          className="absolute inset-x-0 top-0 z-10 lg:hidden"
          style={{ paddingTop: 'max(var(--safe-top), 0px)' }}
        >
          <div className="relative flex h-12 items-center gap-1 bg-[var(--material-thick)] px-1.5 [backdrop-filter:blur(20px)_saturate(1.3)] [-webkit-backdrop-filter:blur(20px)_saturate(1.3)]">
            <button
              onClick={onBack}
              aria-label="Back to chats"
              className="inline-flex h-9 shrink-0 items-center gap-0.5 rounded-full pl-1 pr-2.5 text-[length:var(--text-body)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)] active:bg-[var(--fill-secondary)]"
            >
              <ChevronLeft size={22} className="shrink-0" />
              Chats
            </button>
            <span
              className={cn(
                "pointer-events-none absolute left-1/2 max-w-[48vw] -translate-x-1/2 truncate text-center text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)]",
              )}
            >
              {title}
            </span>
            <div className="ml-auto flex shrink-0 items-center">
              <PillButton onClick={onNew} title="New chat (N)" ariaLabel="New chat">
                <SquarePen size={18} />
              </PillButton>
              {moreMenu}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
