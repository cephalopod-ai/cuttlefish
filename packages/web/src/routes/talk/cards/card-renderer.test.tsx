import { describe, it, expect } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { CardRenderer } from "./card-renderer"
import type { ImageCard } from "../types"

describe("CardRenderer image cards — remote auto-fetch gating (AR-11)", () => {
  it("does not auto-load a remote http(s) image; requires an explicit click", () => {
    const card: ImageCard = { id: "c1", type: "image", src: "https://attacker.example/beacon.png", alt: "x" }
    render(<CardRenderer card={card} />)

    // No <img> is rendered up front, so the browser fires no zero-click GET.
    expect(document.querySelector("img")).toBeNull()
    const loadButton = screen.getByRole("button", { name: /load image from attacker\.example/i })
    expect(loadButton).toBeTruthy()

    fireEvent.click(loadButton)
    const img = document.querySelector("img")
    expect(img).not.toBeNull()
    expect(img?.getAttribute("src")).toBe("https://attacker.example/beacon.png")
  })

  it("loads relative/same-origin images immediately (not remote)", () => {
    const card: ImageCard = { id: "c1", type: "image", src: "/assets/local.png", alt: "x" }
    render(<CardRenderer card={card} />)
    const img = document.querySelector("img")
    expect(img).not.toBeNull()
    expect(img?.getAttribute("src")).toBe("/assets/local.png")
  })

  it("loads a bare-seed placeholder immediately (fixed placeholder host, not card-controlled)", () => {
    const card: ImageCard = { id: "c1", type: "image", src: "seed-word", alt: "x" }
    render(<CardRenderer card={card} />)
    const img = document.querySelector("img")
    expect(img).not.toBeNull()
    expect(img?.getAttribute("src")).toContain("picsum.photos")
  })
})
