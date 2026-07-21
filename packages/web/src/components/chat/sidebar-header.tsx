import type React from "react"
import { Search, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { StatusDot } from "./sidebar-row-components"
import type { ViewMode } from "./sidebar-types"

export function SidebarHeader({
  listScrolled,
  viewMode,
  selectViewMode,
  needsAttentionCount,
  onOpenAttention,
  searchOpen,
  onOpenSearch,
  closeSearch,
  search,
  setSearch,
  searchInputRef,
}: {
  listScrolled: boolean
  viewMode: ViewMode
  selectViewMode: (mode: ViewMode) => void
  needsAttentionCount: number
  onOpenAttention: () => void
  searchOpen: boolean
  onOpenSearch: () => void
  closeSearch: () => void
  search: string
  setSearch: (value: string) => void
  searchInputRef: React.RefObject<HTMLInputElement | null>
}) {
  const lanes = [
    { mode: "projects" as const, label: "Team", title: "Projects grouped by root session and descendants" },
    { mode: "management" as const, label: "Management", title: "Direct manager and executive conversations" },
  ]

  return (
    <div
      className={cn(
        "shrink-0 bg-[var(--sidebar-bg)] px-3 py-2 transition-shadow duration-150",
        listScrolled && "shadow-[0_1px_0_0_var(--separator)]",
      )}
    >
      <div className="relative flex h-9 items-center">
        <div
          className={cn(
            "flex w-full items-center gap-2 transition-opacity duration-200 [transition-timing-function:var(--ease-smooth)] motion-reduce:transition-none",
            searchOpen ? "pointer-events-none opacity-0" : "opacity-100",
          )}
          aria-hidden={searchOpen}
        >
          <div className="flex items-center gap-0.5 rounded-full bg-[var(--fill-tertiary)] p-0.5 text-[11px] font-medium">
            {lanes.map(({ mode, label, title }) => (
              <button
                key={mode}
                onClick={() => selectViewMode(mode)}
                aria-pressed={viewMode === mode}
                title={title}
                className={cn(
                  "rounded-full px-2.5 py-1 transition-all",
                  viewMode === mode
                    ? "bg-[var(--bg-secondary)] text-foreground shadow-[var(--shadow-subtle)]"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {needsAttentionCount > 0 ? (
            <button
              onClick={onOpenAttention}
              title={`${needsAttentionCount} ${needsAttentionCount === 1 ? "chat needs" : "chats need"} you`}
              className="flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--fill-tertiary)] px-2.5 py-1 text-[11px] font-medium text-[var(--system-orange)] transition-colors hover:bg-[var(--fill-secondary)]"
            >
              <StatusDot color="var(--system-orange)" pulse className="size-1.5" />
              {needsAttentionCount} need you
            </button>
          ) : null}

          <div className="flex-1" />
          <button
            onClick={onOpenSearch}
            title="Search chats"
            aria-label="Search chats"
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-foreground"
          >
            <Search className="size-[18px]" />
          </button>
        </div>

        <div
          className={cn(
            "absolute inset-y-0 right-0 flex items-center gap-2 overflow-hidden rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] transition-[width,opacity] duration-200 [transition-timing-function:var(--ease-smooth)] motion-reduce:transition-none",
            searchOpen ? "w-full px-3 opacity-100" : "w-0 px-0 opacity-0",
          )}
        >
          <Search className="size-3.5 shrink-0 text-[var(--text-tertiary)]" />
          <input
            id="chat-search"
            ref={searchInputRef}
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault()
                closeSearch()
              }
            }}
            placeholder="Search..."
            aria-label="Search chats"
            tabIndex={searchOpen ? 0 : -1}
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-[var(--text-tertiary)]"
          />
          <button
            onClick={closeSearch}
            tabIndex={searchOpen ? 0 : -1}
            aria-label="Close search"
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}
