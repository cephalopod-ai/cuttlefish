import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"
import { useSidebarViewPreferences } from "../use-sidebar-view-preferences"

describe("useSidebarViewPreferences", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("defaults the sidebar to room mode", () => {
    const { result } = renderHook(() => useSidebarViewPreferences())

    expect(result.current.viewMode).toBe("rooms")
    expect(result.current.olderExpanded).toBe(false)
    expect(Array.from(result.current.expandedRooms)).toEqual([])
  })

  it("honors stored sidebar view modes", async () => {
    localStorage.setItem("cuttlefish-sidebar-focus-mode", "focused")

    const { result } = renderHook(() => useSidebarViewPreferences())

    await waitFor(() => {
      expect(result.current.viewMode).toBe("focused")
    })
  })

  it("persists view mode and expanded room state", () => {
    const { result } = renderHook(() => useSidebarViewPreferences())

    act(() => {
      result.current.selectViewMode("all")
    })
    expect(result.current.viewMode).toBe("all")
    expect(localStorage.getItem("cuttlefish-sidebar-focus-mode")).toBe("all")

    act(() => {
      result.current.toggleOlderExpanded()
    })
    expect(result.current.olderExpanded).toBe(true)
    expect(localStorage.getItem("cuttlefish-sidebar-older-expanded")).toBe("true")

    act(() => {
      result.current.toggleRoomExpanded("platform")
    })
    expect(result.current.expandedRooms.has("platform")).toBe(true)
    expect(JSON.parse(localStorage.getItem("cuttlefish-sidebar-rooms-expanded") ?? "[]")).toEqual(["platform"])
  })
})
