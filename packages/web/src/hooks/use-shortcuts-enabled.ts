import { useSyncExternalStore } from "react"

const STORAGE_KEY = "cuttlefish-single-key-shortcuts-enabled"
const listeners = new Set<() => void>()
let cached: boolean | null = null

function readStored(): boolean {
  if (typeof window === "undefined") return true
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw === null ? true : raw === "true"
  } catch {
    return true
  }
}

function getSnapshot(): boolean {
  if (cached === null) cached = readStored()
  return cached
}

function getServerSnapshot(): boolean {
  return true
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setSingleKeyShortcutsEnabled(next: boolean): void {
  cached = next
  try {
    window.localStorage.setItem(STORAGE_KEY, String(next))
  } catch {
    // best-effort — in-memory state still updates for this session
  }
  for (const listener of listeners) listener()
}

/**
 * DESIGN-006 / WCAG 2.1.4 (Character Key Shortcuts): every single-character,
 * no-modifier keyboard shortcut in the app (see useKeyboardShortcuts and
 * useGoToNavigation, the app's global "g then <key>" navigation) previously
 * had no way to be turned off, remapped, or scoped to a focused component —
 * any of which 2.1.4 requires. This is the shared on/off switch, persisted
 * to localStorage and kept in sync across every mounted consumer within the
 * same tab via useSyncExternalStore (localStorage's own "storage" event only
 * fires in *other* tabs, never the one that made the change).
 */
export function useSingleKeyShortcutsEnabled(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
