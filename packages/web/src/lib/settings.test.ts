import { beforeEach, describe, expect, it } from "vitest"
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  loadSettings,
} from "./settings"

describe("loadSettings", () => {
  beforeEach(() => localStorage.clear())

  it("fills notification defaults when loading an older partial preference record", () => {
    localStorage.setItem("cuttlefish-settings", JSON.stringify({
      notificationPreferences: { approvals: { badge: false } },
    }))

    expect(loadSettings().notificationPreferences).toEqual({
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      approvals: { badge: false, toast: false },
    })
  })

  it("falls back to usable collection defaults for malformed persisted values", () => {
    localStorage.setItem("cuttlefish-settings", JSON.stringify({
      navOrder: "settings-first",
      notificationPreferences: null,
    }))

    const settings = loadSettings()
    expect(settings.navOrder).toEqual([])
    expect(settings.notificationPreferences).toEqual(DEFAULT_NOTIFICATION_PREFERENCES)
  })
})
