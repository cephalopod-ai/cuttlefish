
import { useState, useCallback, useEffect, useMemo } from 'react'

interface BaseTab {
  label: string        // Employee name, session title, or file basename
  /** If true, this is a "pinned" tab (VS Code style) — won't be replaced by preview. */
  pinned?: boolean
}

export interface SessionTab extends BaseTab {
  kind: 'session'
  sessionId: string
  employeeName?: string // Employee name for avatar generation
  status: 'idle' | 'running' | 'error'
  unread: boolean
}

export interface FileTab extends BaseTab {
  kind: 'file'
  path: string
}

export type ChatTab = SessionTab | FileTab

/** Stable identity for keying/dedupe across both kinds. */
export function tabKey(t: ChatTab): string {
  return t.kind === 'file' ? `file:${t.path}` : t.sessionId
}

const STORAGE_KEY = 'cuttlefish-chat-tabs'
const MAX_TABS = 12

interface TabState {
  tabs: ChatTab[]
  activeIndex: number
}

function clampState(state: TabState): TabState {
  if (state.tabs.length === 0) return { tabs: [], activeIndex: -1 }
  if (state.activeIndex < 0 || state.activeIndex >= state.tabs.length) {
    return { tabs: state.tabs, activeIndex: 0 }
  }
  return state
}

function loadTabs(): TabState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = clampState(JSON.parse(raw))
      // Migrate persisted tabs that predate `kind`: a tab missing `kind` but
      // carrying a sessionId is a legacy session tab.
      const migrated = parsed.tabs.map((t) => {
        const tab = t as Partial<ChatTab> & { sessionId?: string }
        if (!tab.kind && tab.sessionId) {
          return { ...tab, kind: 'session' } as ChatTab
        }
        return tab as ChatTab
      })
      return { tabs: migrated, activeIndex: parsed.activeIndex }
    }
  } catch {}
  return { tabs: [], activeIndex: -1 }
}

function saveTabs(state: TabState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

export function useChatTabs() {
  const [{ tabs, activeIndex }, setState] = useState<TabState>({ tabs: [], activeIndex: -1 })

  useEffect(() => {
    setState(loadTabs())
  }, [])

  useEffect(() => {
    saveTabs({ tabs, activeIndex })
  }, [tabs, activeIndex])

  const activeTab = activeIndex >= 0 ? tabs[activeIndex] : null

  /**
   * Open a tab in "preview" mode (VS Code style):
   * - If the session is already open, just switch to it.
   * - If there's an existing unpinned preview tab, replace it.
   * - Otherwise, append a new preview tab.
   * The `pinned` field on the incoming tab is respected — if true, it opens pinned.
   */
  const openTab = useCallback((incoming: Omit<SessionTab, 'kind'>) => {
    const tab: SessionTab = { ...incoming, kind: 'session' }
    setState((current) => {
      // Already open? Just switch to it — keep existing label/status.
      // Dedupe on session identity only among session tabs.
      const existing = current.tabs.findIndex((t) => t.kind === 'session' && t.sessionId === tab.sessionId)
      if (existing >= 0) {
        return { tabs: current.tabs, activeIndex: existing }
      }

      // If incoming tab is not explicitly pinned, replace the existing preview tab
      if (!tab.pinned) {
        const previewIdx = current.tabs.findIndex((t) => !t.pinned)
        if (previewIdx >= 0) {
          const nextTabs = [...current.tabs]
          nextTabs[previewIdx] = { ...tab, pinned: false }
          return { tabs: nextTabs, activeIndex: previewIdx }
        }
      }

      if (current.tabs.length >= MAX_TABS) {
        // Replace oldest unpinned tab
        const replaceIdx = current.tabs.findIndex((t) => !t.pinned)
        if (replaceIdx >= 0) {
          const nextTabs = [...current.tabs]
          nextTabs[replaceIdx] = tab
          return { tabs: nextTabs, activeIndex: replaceIdx }
        }
      }

      return {
        tabs: [...current.tabs, tab],
        activeIndex: current.tabs.length,
      }
    })
  }, [])

  /** Open (or focus, if already open) a file tab. File tabs are pinned so the
   *  preview-open flow never replaces them. */
  const openFileTab = useCallback((path: string) => {
    setState((current) => {
      const existing = current.tabs.findIndex((t) => t.kind === 'file' && t.path === path)
      if (existing >= 0) return { tabs: current.tabs, activeIndex: existing }
      const label = path.split(/[\\/]/).pop() || path // basename only
      const tab: FileTab = { kind: 'file', path, label, pinned: true }
      if (current.tabs.length >= MAX_TABS) {
        const replaceIdx = current.tabs.findIndex((t) => !t.pinned)
        if (replaceIdx >= 0) {
          const next = [...current.tabs]
          next[replaceIdx] = tab
          return { tabs: next, activeIndex: replaceIdx }
        }
      }
      return { tabs: [...current.tabs, tab], activeIndex: current.tabs.length }
    })
  }, [])

  /** Pin the tab at the given index (VS Code style — makes it permanent). */
  const pinTab = useCallback((index: number) => {
    setState((current) => {
      if (index < 0 || index >= current.tabs.length) return current
      if (current.tabs[index].pinned) return current
      const nextTabs = current.tabs.map((t, i) => i === index ? { ...t, pinned: true } : t)
      return { ...current, tabs: nextTabs }
    })
  }, [])

  const closeTab = useCallback((index: number) => {
    setState((current) => {
      const nextTabs = current.tabs.filter((_, i) => i !== index)
      if (nextTabs.length === 0) return { tabs: [], activeIndex: -1 }

      let nextActiveIndex = current.activeIndex
      if (current.activeIndex === index) nextActiveIndex = Math.min(index, nextTabs.length - 1)
      else if (current.activeIndex > index) nextActiveIndex = current.activeIndex - 1

      return { tabs: nextTabs, activeIndex: nextActiveIndex }
    })
  }, [])

  const switchTab = useCallback((index: number) => {
    setState((current) => {
      if (index < 0 || index >= current.tabs.length) return current
      return { tabs: current.tabs, activeIndex: index }
    })
  }, [tabs.length])

  /** Move a tab from one position to another (for drag & drop reordering). */
  const moveTab = useCallback((from: number, to: number) => {
    setState((current) => {
      if (from === to) return current
      if (from < 0 || from >= current.tabs.length) return current
      if (to < 0 || to >= current.tabs.length) return current

      const nextTabs = [...current.tabs]
      const [moved] = nextTabs.splice(from, 1)
      nextTabs.splice(to, 0, moved)

      // Keep activeIndex pointing to the same tab
      let nextActive = current.activeIndex
      if (current.activeIndex === from) {
        nextActive = to
      } else if (from < current.activeIndex && to >= current.activeIndex) {
        nextActive = current.activeIndex - 1
      } else if (from > current.activeIndex && to <= current.activeIndex) {
        nextActive = current.activeIndex + 1
      }

      return { tabs: nextTabs, activeIndex: nextActive }
    })
  }, [])

  const nextTab = useCallback(() => {
    setState((current) => {
      if (current.tabs.length === 0) return current
      const nextActive = (current.activeIndex + 1 + current.tabs.length) % current.tabs.length
      return { tabs: current.tabs, activeIndex: nextActive }
    })
  }, [tabs.length])

  const prevTab = useCallback(() => {
    setState((current) => {
      if (current.tabs.length === 0) return current
      const nextActive = (current.activeIndex - 1 + current.tabs.length) % current.tabs.length
      return { tabs: current.tabs, activeIndex: nextActive }
    })
  }, [tabs.length])

  const clearActiveTab = useCallback(() => {
    setState((current) => ({ ...current, activeIndex: -1 }))
  }, [])

  const updateTabStatus = useCallback((sessionId: string, updates: Partial<SessionTab>) => {
    setState((current) => {
      const idx = current.tabs.findIndex((t) => t.kind === 'session' && t.sessionId === sessionId)
      if (idx < 0) return current
      const tab = current.tabs[idx] as SessionTab
      // Bail out if nothing actually changed — prevents infinite re-render loops
      const keys = Object.keys(updates) as (keyof SessionTab)[]
      if (keys.every((k) => tab[k] === updates[k])) return current
      const nextTabs: ChatTab[] = current.tabs.map((t, i) => (i === idx ? { ...tab, ...updates } : t))
      return { ...current, tabs: nextTabs }
    })
  }, [])

  /** Close the tab for a given sessionId (no-op if not open). */
  const closeTabBySessionId = useCallback((sessionId: string) => {
    setState((current) => {
      const idx = current.tabs.findIndex((t) => t.kind === 'session' && t.sessionId === sessionId)
      if (idx < 0) return current
      const nextTabs = current.tabs.filter((_, i) => i !== idx)
      if (nextTabs.length === 0) return { tabs: [], activeIndex: -1 }
      let nextActiveIndex = current.activeIndex
      if (current.activeIndex === idx) nextActiveIndex = Math.min(idx, nextTabs.length - 1)
      else if (current.activeIndex > idx) nextActiveIndex = current.activeIndex - 1
      return { tabs: nextTabs, activeIndex: nextActiveIndex }
    })
  }, [])

  /**
   * Reconcile persisted tabs against an authoritative session list:
   * - Drop any tab whose sessionId no longer exists.
   * - Normalize stale `status: 'running'` to match the server-side status
   *   when the server reports the session as `idle` or `error` (cleans up
   *   after daemon restarts / external state changes).
   * - Optionally update labels to match server titles (fixes stale title
   *   after rename when the tab wasn't focused).
   */
  const reconcileTabs = useCallback(
    (
      sessions: Array<{ id: string; title?: string; status?: string; employee?: string }>
    ) => {
      const byId = new Map(sessions.map((s) => [s.id, s]))
      setState((current) => {
        if (current.tabs.length === 0) return current
        const nextTabs: ChatTab[] = []
        for (const tab of current.tabs) {
          // File tabs are never orphaned by the session list — keep unchanged.
          if (tab.kind === 'file') {
            nextTabs.push(tab)
            continue
          }
          const session = byId.get(tab.sessionId)
          if (!session) continue // orphan — drop
          let updated: SessionTab = tab
          // Normalize stale 'running' if server says otherwise
          if (
            tab.status === 'running' &&
            (session.status === 'idle' || session.status === 'error')
          ) {
            updated = {
              ...updated,
              status: session.status === 'error' ? 'error' : 'idle',
            }
          }
          // Sync label if the server has a non-empty title that differs
          if (session.title && session.title !== tab.label) {
            updated = { ...updated, label: session.title }
          }
          if (session.employee && session.employee !== tab.employeeName) {
            updated = { ...updated, employeeName: session.employee }
          }
          nextTabs.push(updated)
        }
        if (nextTabs.length === current.tabs.length) {
          // No structural change — only commit if any field actually changed
          const unchanged = nextTabs.every((t, i) => {
            const o = current.tabs[i]
            if (t.kind === 'session' && o.kind === 'session') {
              return t.label === o.label && t.status === o.status && t.employeeName === o.employeeName
            }
            return t.label === o.label
          })
          if (unchanged) return current
        }
        let nextActive = current.activeIndex
        if (nextActive >= 0) {
          const activeTab = current.tabs[nextActive]
          const activeKey = activeTab ? tabKey(activeTab) : null
          nextActive = activeKey ? nextTabs.findIndex((t) => tabKey(t) === activeKey) : -1
          if (nextActive < 0) nextActive = nextTabs.length > 0 ? 0 : -1
        }
        return { tabs: nextTabs, activeIndex: nextActive }
      })
    },
    []
  )

  return useMemo(() => ({
    tabs, activeTab, activeIndex,
    openTab, openFileTab, closeTab, switchTab, nextTab, prevTab,
    pinTab, moveTab,
    clearActiveTab, updateTabStatus,
    closeTabBySessionId, reconcileTabs,
  }), [tabs, activeTab, activeIndex,
    openTab, openFileTab, closeTab, switchTab, nextTab, prevTab,
    pinTab, moveTab,
    clearActiveTab, updateTabStatus,
    closeTabBySessionId, reconcileTabs])
}
