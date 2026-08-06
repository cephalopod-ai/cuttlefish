import { act, renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const getOnboarding = vi.fn()
vi.mock("@/lib/api", () => ({ api: { getOnboarding: (...args: unknown[]) => getOnboarding(...args) } }))

import { SettingsProvider, useSettings } from "./settings-provider"

function wrapper({ children }: { children: ReactNode }) {
  return <SettingsProvider>{children}</SettingsProvider>
}

describe("SettingsProvider", () => {
  beforeEach(() => {
    localStorage.clear()
    getOnboarding.mockReset()
  })

  it("preserves preference changes made while onboarding identity is loading", async () => {
    let resolveOnboarding!: (value: { portalName: string; operatorName: string }) => void
    getOnboarding.mockReturnValue(new Promise((resolve) => { resolveOnboarding = resolve }))
    const { result } = renderHook(() => useSettings(), { wrapper })

    act(() => result.current.setAttentionAwareLanding(true))
    await act(async () => resolveOnboarding({ portalName: "Harbor", operatorName: "Ari" }))

    await waitFor(() => expect(result.current.settings.portalName).toBe("Harbor"))
    expect(result.current.settings.attentionAwareLanding).toBe(true)
    expect(JSON.parse(localStorage.getItem("cuttlefish-settings")!).attentionAwareLanding).toBe(true)
  })
})
