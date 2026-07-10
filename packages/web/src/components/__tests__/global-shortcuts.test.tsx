import { describe, it, expect, afterEach, vi } from "vitest"
import { render, screen, act } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { GlobalShortcuts } from "../global-shortcuts"

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom")
  return { ...actual, useNavigate: () => vi.fn() }
})

function fireKey(key: string, opts: Partial<KeyboardEventInit> = {}) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...opts }))
  })
}

describe("GlobalShortcuts", () => {
  afterEach(() => {
    document.body.innerHTML = ""
  })

  it("renders nothing until ? is pressed", () => {
    render(<GlobalShortcuts />, { wrapper: MemoryRouter })
    expect(screen.queryByText("Keyboard Shortcuts")).toBeNull()
  })

  it("opens the sheet on ? and documents every go-to target plus the palette", () => {
    render(<GlobalShortcuts />, { wrapper: MemoryRouter })
    fireKey("?", { shiftKey: true })
    expect(screen.getByText("Keyboard Shortcuts")).toBeTruthy()
    expect(screen.getByText("Open the command palette")).toBeTruthy()
    expect(screen.getByText("Go to Organization")).toBeTruthy()
    expect(screen.getByText("Toggle this shortcut sheet")).toBeTruthy()
  })

  it("toggles closed on a second ?", () => {
    render(<GlobalShortcuts />, { wrapper: MemoryRouter })
    fireKey("?", { shiftKey: true })
    expect(screen.getByText("Keyboard Shortcuts")).toBeTruthy()
    fireKey("?", { shiftKey: true })
    expect(screen.queryByText("Keyboard Shortcuts")).toBeNull()
  })

  it("closes on Escape", () => {
    render(<GlobalShortcuts />, { wrapper: MemoryRouter })
    fireKey("?", { shiftKey: true })
    expect(screen.getByText("Keyboard Shortcuts")).toBeTruthy()
    fireKey("Escape")
    expect(screen.queryByText("Keyboard Shortcuts")).toBeNull()
  })
})
