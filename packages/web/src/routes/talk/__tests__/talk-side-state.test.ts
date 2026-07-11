import { afterEach, describe, expect, it } from "vitest"
import { addDismissedThread, saveThreadLabel } from "../talk-storage"
import { MAX_CARDS, loadSideState } from "../talk-side-state"

afterEach(() => {
  localStorage.clear()
})

describe("Talk dock side-state", () => {
  it("rehydrates persisted label overrides and dismiss tombstones", () => {
    saveThreadLabel("coo-1", "Research")
    addDismissedThread("coo-2")

    const state = loadSideState()

    expect(state.get("coo-1")).toEqual({ labelOverride: "Research" })
    expect(state.get("coo-2")).toEqual({ dismissed: true })
  })

  it("retains the established six-card surface cap", () => {
    expect(MAX_CARDS).toBe(6)
  })
})
