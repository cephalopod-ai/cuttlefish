import { useState } from "react"
import { useKeyboardShortcuts, type ShortcutDef } from "@/hooks/use-keyboard-shortcuts"
import { useGoToNavigation, GO_TO_TARGETS } from "@/hooks/use-go-to-navigation"
import { ShortcutOverlay } from "@/components/ui/shortcut-overlay"

// Display-only rows for the g-then-key sequences and the command palette.
// ShortcutOverlay only ever reads `key`/`category`/`description` to render a
// documentation panel — it never calls `action` — so a two-character `key`
// here is safe; the real g-then-key binding lives in useGoToNavigation.
const DOC_ONLY_SHORTCUTS: ShortcutDef[] = [
  { key: "k", modifiers: ["meta"], category: "Navigation", description: "Open the command palette", action: () => {} },
  ...GO_TO_TARGETS.map((target) => ({
    key: `G ${target.key.toUpperCase()}`,
    category: "Navigation" as const,
    description: `Go to ${target.label}`,
    action: () => {},
  })),
]

/**
 * The app-wide keyboard layer: g-then-key navigation (useGoToNavigation) plus
 * the "?" shortcut sheet documenting it. Mounted once in PageLayout, so it
 * covers every route except chat (which owns a richer, page-local shortcut
 * set — including its own "?" — via useKeyboardShortcuts directly). See
 * docs/plans/2026-07-10-fleetview-ux-implementation-plan.md, Section 6.3.
 */
export function GlobalShortcuts() {
  const [open, setOpen] = useState(false)
  useGoToNavigation()

  const liveShortcuts: ShortcutDef[] = [
    { key: "?", category: "Help", description: "Toggle this shortcut sheet", action: () => setOpen((v) => !v) },
    { key: "Escape", category: "Help", description: "Close this shortcut sheet", action: () => setOpen(false), enabled: open },
  ]
  useKeyboardShortcuts(liveShortcuts)

  if (!open) return null
  return (
    <ShortcutOverlay
      shortcuts={[...DOC_ONLY_SHORTCUTS, ...liveShortcuts]}
      onClose={() => setOpen(false)}
    />
  )
}
