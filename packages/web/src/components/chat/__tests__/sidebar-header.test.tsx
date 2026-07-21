import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { SidebarHeader } from "../sidebar-header"

describe("SidebarHeader", () => {
  it("surfaces Team and Management instead of the legacy room modes", () => {
    const selectViewMode = vi.fn()
    render(
      <SidebarHeader
        listScrolled={false}
        viewMode="projects"
        selectViewMode={selectViewMode}
        needsAttentionCount={0}
        onOpenAttention={vi.fn()}
        searchOpen={false}
        onOpenSearch={vi.fn()}
        closeSearch={vi.fn()}
        search=""
        setSearch={vi.fn()}
        searchInputRef={{ current: null }}
      />,
    )

    expect(screen.getByRole("button", { name: "Team" }).getAttribute("aria-pressed")).toBe("true")
    expect(screen.queryByRole("button", { name: "Rooms" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Focused" })).toBeNull()
    expect(screen.queryByRole("button", { name: "All" })).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Management" }))
    expect(selectViewMode).toHaveBeenCalledWith("management")
  })
})
