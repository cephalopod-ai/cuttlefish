import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { TriageChip } from "../triage-chip"

describe("TriageChip", () => {
  it("renders the label, count, and links to href", () => {
    render(
      <MemoryRouter>
        <TriageChip label="Needs approval" count={3} href="/approvals" icon={<span>icon</span>} />
      </MemoryRouter>,
    )
    expect(screen.getByText("Needs approval")).toBeTruthy()
    expect(screen.getByText("3")).toBeTruthy()
    expect(screen.getByRole("link").getAttribute("href")).toBe("/approvals")
  })

  it("uses attention styling when count > 0", () => {
    render(
      <MemoryRouter>
        <TriageChip label="Blocked" count={2} href="/kanban" icon={<span>icon</span>} />
      </MemoryRouter>,
    )
    expect(screen.getByRole("link").className).toContain("system-orange")
  })

  it("uses calm/neutral styling when count is 0", () => {
    render(
      <MemoryRouter>
        <TriageChip label="Blocked" count={0} href="/kanban" icon={<span>icon</span>} />
      </MemoryRouter>,
    )
    expect(screen.getByRole("link").className).not.toContain("system-orange")
  })
})
