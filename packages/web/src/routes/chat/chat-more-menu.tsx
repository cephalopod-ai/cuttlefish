import { Copy, MoreHorizontal, Search, Share2, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ViewMode } from '@/lib/view-mode'
import { shareDebugLog, clearDebugLog } from '@/lib/debug-log'

interface SessionMeta {
  engine?: string
  engineSessionId?: string
}

interface ChatMoreMenuProps {
  open: boolean
  selectedId: string | null
  sessionMeta: SessionMeta | null
  effectiveViewMode: ViewMode
  cliModeAvailable: boolean
  viewSwitchLocked: boolean
  cliTitle?: string
  duplicatePending: boolean
  onToggle: () => void
  onClose: () => void
  onSetViewMode: (mode: ViewMode) => void
  onOpenGlobalSearch: () => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
  onCopy: (text: string, field: string) => void
}

export function ChatMoreMenu({
  open,
  selectedId,
  sessionMeta,
  effectiveViewMode,
  cliModeAvailable,
  viewSwitchLocked,
  cliTitle,
  duplicatePending,
  onToggle,
  onClose,
  onSetViewMode,
  onOpenGlobalSearch,
  onDuplicate,
  onDelete,
  onCopy,
}: ChatMoreMenuProps) {
  return (
    <div data-more-menu className="relative">
      <button
        onClick={onToggle}
        aria-label="More options"
        className="inline-flex size-9 lg:size-8 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-foreground"
      >
        <MoreHorizontal className="size-[18px]" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-[200] mt-2 min-w-[220px] overflow-hidden rounded-[var(--radius-md)] border border-border bg-[var(--material-thick)] shadow-[var(--shadow-overlay)] backdrop-blur-xl">
          <button
            onClick={onOpenGlobalSearch}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent"
          >
            <Search className="size-3.5" />
            <span className="flex-1">Search…</span>
            <kbd className="font-mono text-[10px] text-[var(--text-quaternary)]">⌘K</kbd>
          </button>
          <div className="flex items-center gap-1 px-3 py-2">
            <button
              onClick={() => { if (!viewSwitchLocked) { onSetViewMode('chat'); onClose() } }}
              disabled={viewSwitchLocked}
              title={viewSwitchLocked ? cliTitle : undefined}
              className={cn(
                "flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors",
                effectiveViewMode === 'chat' ? "bg-[var(--accent-fill)] text-[var(--accent)]" : "text-muted-foreground hover:bg-accent",
                viewSwitchLocked && "opacity-60 cursor-not-allowed"
              )}
            >
              Chat
            </button>
            <button
              onClick={() => { if (cliModeAvailable && !viewSwitchLocked) { onSetViewMode('cli'); onClose() } }}
              disabled={!cliModeAvailable || viewSwitchLocked}
              title={cliTitle}
              className={cn(
                "flex-1 rounded-md px-2 py-1 font-mono text-xs font-medium transition-colors",
                effectiveViewMode === 'cli' ? "bg-[var(--accent-fill)] text-[var(--accent)]" : "text-muted-foreground hover:bg-accent",
                (!cliModeAvailable || viewSwitchLocked) && "opacity-45 cursor-not-allowed"
              )}
            >
              CLI
            </button>
          </div>
          {selectedId && (
            <button
              onClick={() => onDuplicate(selectedId)}
              disabled={duplicatePending}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent disabled:opacity-50"
            >
              <Copy className="size-3.5" />
              <span className="flex-1">{duplicatePending ? 'Duplicating...' : 'Duplicate...'}</span>
            </button>
          )}

          {selectedId && (
            <>
              <div className="my-0.5 border-t border-border" />
              <div className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-[var(--text-tertiary)]">
                Developer
              </div>
              <button
                onClick={() => onCopy(selectedId, 'id')}
                className="block w-full px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent"
              >
                Copy Session ID
              </button>
              {sessionMeta?.engineSessionId && (sessionMeta.engine === 'claude' || sessionMeta.engine === 'codex') && (
                <button
                  onClick={() => {
                    const cli = sessionMeta.engine === 'codex' ? 'codex' : 'claude'
                    onCopy(`${cli} --resume ${sessionMeta.engineSessionId}`, 'cli')
                  }}
                  className="block w-full px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent"
                >
                  Copy CLI Resume Command
                </button>
              )}
              <button
                onClick={() => { onClose(); shareDebugLog() }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent"
              >
                <Share2 className="size-3.5" />
                <span className="flex-1">Share debug log</span>
              </button>
              <button
                onClick={() => { onClose(); clearDebugLog() }}
                className="block w-full px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent"
              >
                Clear debug log
              </button>

              <div className="my-0.5 border-t border-border" />
              <button
                onClick={() => { onClose(); if (window.confirm('Delete this session?')) onDelete(selectedId) }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--system-red)] transition-colors hover:bg-accent"
              >
                <Trash2 className="size-3.5" />
                <span className="flex-1">Delete Session</span>
                <kbd className="font-mono text-[10px] text-[var(--text-quaternary)]">⌫</kbd>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
