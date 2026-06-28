import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { ErrorBoundary } from "./error-boundary"

function Broken(): never {
  throw new Error("boom")
}

describe("ErrorBoundary", () => {
  it("renders a visible default fallback when no fallback prop is provided", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})

    render(
      <ErrorBoundary>
        <Broken />
      </ErrorBoundary>,
    )

    expect(screen.getByRole("alert").textContent).toContain("Something went wrong.")
    spy.mockRestore()
  })
})
