import { describe, it, expect } from "vitest"
import { isNavItemActive } from "../pill-nav"

// The single active-route rule shared by the rail (retired), drawer, popover and
// pill. Root "/" matches ONLY the exact chat root; every other item matches by
// path prefix so nested routes (e.g. /kanban/123) keep their nav item lit.
describe("isNavItemActive", () => {
  it("matches root only on the exact chat path", () => {
    expect(isNavItemActive("/", "/")).toBe(true)
    expect(isNavItemActive("/", "/org")).toBe(false)
    expect(isNavItemActive("/", "/kanban")).toBe(false)
  })

  it("matches non-root items by prefix", () => {
    expect(isNavItemActive("/org", "/org")).toBe(true)
    expect(isNavItemActive("/kanban", "/kanban/123")).toBe(true)
    expect(isNavItemActive("/logs", "/logs")).toBe(true)
  })

  it("does not cross-match sibling routes", () => {
    expect(isNavItemActive("/org", "/kanban")).toBe(false)
    expect(isNavItemActive("/settings", "/skills")).toBe(false)
  })
})
