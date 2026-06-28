import { describe, it, expect } from "vitest"
import { canonicalIcon, iconPatchFromPickerValue } from "./employee-icon"

describe("iconPatchFromPickerValue", () => {
  it("maps an ocean avatar id to avatar and clears emoji", () => {
    expect(iconPatchFromPickerValue("nautical:life_ring")).toEqual({ avatar: "nautical:life_ring", emoji: "" })
  })

  it("maps a plain emoji to emoji and clears avatar", () => {
    expect(iconPatchFromPickerValue("🦊")).toEqual({ avatar: "", emoji: "🦊" })
  })

  it("maps the empty value to a full clear", () => {
    expect(iconPatchFromPickerValue("")).toEqual({ avatar: "", emoji: "" })
  })
})

describe("canonicalIcon", () => {
  it("prefers avatar over emoji", () => {
    expect(canonicalIcon({ avatar: "aquatic:octopus", emoji: "🦊" })).toBe("aquatic:octopus")
  })

  it("falls back to emoji, then empty", () => {
    expect(canonicalIcon({ emoji: "🦊" })).toBe("🦊")
    expect(canonicalIcon({})).toBe("")
  })
})
