import { useCallback, useEffect, useState } from "react"
import type { ViewMode } from "./sidebar-types"
import { loadExpandedRooms, saveExpandedRooms } from "./sidebar-storage"

const OLDER_EXPANDED_STORAGE_KEY = "cuttlefish-sidebar-older-expanded"
const VIEW_MODE_STORAGE_KEY = "cuttlefish-sidebar-focus-mode"

function isViewMode(value: string | null): value is ViewMode {
  return value === "rooms" || value === "focused" || value === "all"
}

export function useSidebarViewPreferences() {
  const [viewMode, setViewMode] = useState<ViewMode>("rooms")
  const [olderExpanded, setOlderExpanded] = useState(false)
  const [expandedRooms, setExpandedRooms] = useState<Set<string>>(new Set())

  useEffect(() => {
    setExpandedRooms(loadExpandedRooms())
    try {
      setOlderExpanded(localStorage.getItem(OLDER_EXPANDED_STORAGE_KEY) === "true")
      const stored = localStorage.getItem(VIEW_MODE_STORAGE_KEY)
      if (isViewMode(stored)) setViewMode(stored)
    } catch {}
  }, [])

  const selectViewMode = useCallback((mode: ViewMode) => {
    setViewMode(mode)
    try {
      localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode)
    } catch {}
  }, [])

  const toggleOlderExpanded = useCallback(() => {
    setOlderExpanded((prev) => {
      const next = !prev
      try {
        localStorage.setItem(OLDER_EXPANDED_STORAGE_KEY, String(next))
      } catch {}
      return next
    })
  }, [])

  const toggleRoomExpanded = useCallback((roomId: string) => {
    setExpandedRooms((prev) => {
      const next = new Set(prev)
      if (next.has(roomId)) next.delete(roomId)
      else next.add(roomId)
      saveExpandedRooms(next)
      return next
    })
  }, [])

  return {
    viewMode,
    selectViewMode,
    olderExpanded,
    toggleOlderExpanded,
    expandedRooms,
    toggleRoomExpanded,
  }
}
