import { useEffect } from 'react'

export interface ShortcutDef {
  key: string
  modifiers?: ('meta' | 'shift' | 'alt')[]
  category: 'Navigation' | 'Actions' | 'Help'
  description: string
  action: () => void
  enabled?: boolean
}

export interface ShortcutOptions {
  isModalOpen?: boolean
}

function matchesShortcut(e: KeyboardEvent, s: ShortcutDef): boolean {
  const mods = s.modifiers ?? []
  const hasMeta = mods.includes('meta')
  const hasShift = mods.includes('shift')
  const hasAlt = mods.includes('alt')

  // Special case: '?' is produced by Shift+/, match on e.key directly
  if (s.key === '?') {
    if (e.key !== '?') return false
    if (e.metaKey || e.altKey || e.ctrlKey) return false
    return true
  }

  // Key comparison: case-insensitive for single letters
  const eventKey = e.key.length === 1 ? e.key.toLowerCase() : e.key
  const defKey = s.key.length === 1 ? s.key.toLowerCase() : s.key

  if (eventKey !== defKey) return false

  if (hasMeta !== e.metaKey) return false
  if (hasShift !== e.shiftKey) return false
  if (hasAlt !== e.altKey) return false
  if (e.ctrlKey && !hasMeta) return false

  return true
}

export function useKeyboardShortcuts(shortcuts: ShortcutDef[], options: ShortcutOptions = {}) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const isEscape = e.key === 'Escape'
      const active = document.activeElement as HTMLElement | null
      const tagName = active?.tagName?.toLowerCase() ?? ''
      const isEditing = tagName === 'input' || tagName === 'textarea' || active?.isContentEditable === true

      for (const s of shortcuts) {
        if (s.enabled === false) continue
        if (!matchesShortcut(e, s)) continue

        const hasModifiers = (s.modifiers ?? []).length > 0
        const isThisEscape = s.key === 'Escape'

        // Modal guard: only Escape passes
        if (options.isModalOpen && !isThisEscape) continue

        // Input guard: block single-key shortcuts (except Escape) when editing
        if (isEditing && !hasModifiers && !isThisEscape) continue

        e.preventDefault()
        s.action()
        return
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [shortcuts, options.isModalOpen])
}
