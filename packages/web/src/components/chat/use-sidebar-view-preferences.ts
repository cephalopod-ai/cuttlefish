import { useCallback, useEffect, useState } from "react"
import type { ViewMode } from "./sidebar-types"
import { loadExpandedProjects, saveExpandedProjects } from "./sidebar-storage"

const OLDER_EXPANDED_STORAGE_KEY = "cuttlefish-sidebar-older-expanded"
const VIEW_MODE_STORAGE_KEY = "cuttlefish-sidebar-collaboration-lane"

function isViewMode(value: string | null): value is ViewMode {
  return value === "projects" || value === "management"
}

export function useSidebarViewPreferences() {
  const [viewMode, setViewMode] = useState<ViewMode>("projects")
  const [olderExpanded, setOlderExpanded] = useState(false)
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())

  useEffect(() => {
    setExpandedProjects(loadExpandedProjects())
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

  const toggleProjectExpanded = useCallback((rootSessionId: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev)
      if (next.has(rootSessionId)) next.delete(rootSessionId)
      else next.add(rootSessionId)
      saveExpandedProjects(next)
      return next
    })
  }, [])

  return {
    viewMode,
    selectViewMode,
    olderExpanded,
    toggleOlderExpanded,
    expandedProjects,
    toggleProjectExpanded,
  }
}
