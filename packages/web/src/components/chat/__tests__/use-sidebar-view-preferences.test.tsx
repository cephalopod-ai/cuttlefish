import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"
import { useSidebarViewPreferences } from "../use-sidebar-view-preferences"

describe("useSidebarViewPreferences", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("defaults the sidebar to project/session Team mode", () => {
    const { result } = renderHook(() => useSidebarViewPreferences())

    expect(result.current.viewMode).toBe("projects")
    expect(result.current.olderExpanded).toBe(false)
    expect(Array.from(result.current.expandedProjects)).toEqual([])
  })

  it("honors stored sidebar view modes", async () => {
    localStorage.setItem("cuttlefish-sidebar-collaboration-lane", "management")

    const { result } = renderHook(() => useSidebarViewPreferences())

    await waitFor(() => {
      expect(result.current.viewMode).toBe("management")
    })
  })

  it("persists collaboration lane and expanded project state", () => {
    const { result } = renderHook(() => useSidebarViewPreferences())

    act(() => {
      result.current.selectViewMode("management")
    })
    expect(result.current.viewMode).toBe("management")
    expect(localStorage.getItem("cuttlefish-sidebar-collaboration-lane")).toBe("management")

    act(() => {
      result.current.toggleOlderExpanded()
    })
    expect(result.current.olderExpanded).toBe(true)
    expect(localStorage.getItem("cuttlefish-sidebar-older-expanded")).toBe("true")

    act(() => {
      result.current.toggleProjectExpanded("project-root")
    })
    expect(result.current.expandedProjects.has("project-root")).toBe(true)
    expect(JSON.parse(localStorage.getItem("cuttlefish-sidebar-projects-expanded") ?? "[]")).toEqual(["project-root"])
  })
})
