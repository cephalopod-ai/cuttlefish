import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { EmployeeAvatar } from "./employee-avatar"

vi.mock("@/routes/settings-provider", () => ({
  useSettings: () => ({
    settings: {
      employeeOverrides: {
        parliamentarian: { emoji: "🦊" },
        assistant: { emoji: "🦊" },
        custom: { profileImage: "nautical:anchor", emoji: "🦊" },
      },
    },
  }),
}))

describe("EmployeeAvatar", () => {
  it("uses explicit org ocean avatars before stale emoji overrides", () => {
    render(<EmployeeAvatar name="parliamentarian" avatar="nautical:lighthouse" />)

    const img = screen.getByRole("img", { name: "parliamentarian" })
    expect(img.getAttribute("src")).toBe("/avatars/nautical/64/lighthouse.png")
  })

  it("keeps custom profile-image ocean overrides above org avatars", () => {
    render(<EmployeeAvatar name="custom" avatar="nautical:lighthouse" />)

    const img = screen.getByRole("img", { name: "custom" })
    expect(img.getAttribute("src")).toBe("/avatars/nautical/64/anchor.png")
  })
})
