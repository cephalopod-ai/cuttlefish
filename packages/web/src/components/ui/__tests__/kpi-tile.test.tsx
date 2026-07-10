import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { KpiTile } from "../kpi-tile"

describe("KpiTile", () => {
  it("renders the value, detail, and links to href", () => {
    render(
      <MemoryRouter>
        <KpiTile title="Agents" value="12" detail="registered across the org" href="/org" icon={<span>icon</span>} />
      </MemoryRouter>,
    )
    expect(screen.getByText("12")).toBeTruthy()
    expect(screen.getByText("registered across the org")).toBeTruthy()
    expect(screen.getByRole("link").getAttribute("href")).toBe("/org")
  })

  it("applies emphasized styling when requested", () => {
    render(
      <MemoryRouter>
        <KpiTile title="Running" value="3" detail="live" href="/org" icon={<span>icon</span>} emphasized />
      </MemoryRouter>,
    )
    expect(screen.getByRole("link").className).toContain("accent")
  })
})
