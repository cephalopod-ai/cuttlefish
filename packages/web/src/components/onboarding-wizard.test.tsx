import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OnboardingWizard } from "./onboarding-wizard"
import { ResetSection } from "@/routes/settings/settings-page-sections"

const mocks = vi.hoisted(() => ({
  getEngines: vi.fn(),
  getOnboarding: vi.fn(),
  completeOnboarding: vi.fn(),
  createSession: vi.fn(),
}))

vi.mock("@/lib/api", () => ({ api: mocks }))
vi.mock("@/routes/settings-provider", () => ({
  useSettings: () => ({
    settings: {}, setPortalName: vi.fn(), setOperatorName: vi.fn(),
    setAccentColor: vi.fn(), setLanguage: vi.fn(),
  }),
}))
vi.mock("@/routes/providers", () => ({
  useTheme: () => ({ theme: "reef-light", setTheme: vi.fn() }),
}))

function registry(available: boolean) {
  return { default: "codex", engines: { codex: {
    name: "codex", available, defaultModel: "test-model",
    models: [{ id: "test-model", label: "Test model" }],
  } } }
}

function next(count: number) {
  for (let i = 0; i < count; i++) fireEvent.click(screen.getByRole("button", { name: "Next" }))
}

describe("onboarding availability and replay", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mocks.getEngines.mockResolvedValue(registry(false))
    mocks.getOnboarding.mockResolvedValue({ onboarded: true, needed: false })
    mocks.completeOnboarding.mockResolvedValue({ status: "ok" })
    mocks.createSession.mockResolvedValue({})
  })

  it("explains unavailable CLIs despite populated catalogs and saves without a failed chat", async () => {
    const onClose = vi.fn()
    render(<MemoryRouter><OnboardingWizard forceOpen onClose={onClose} /></MemoryRouter>)
    await screen.findByText("Welcome to Cuttlefish")
    next(3)
    expect(await screen.findByText(/No AI engine is available/)).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Test model" })).toBeNull()
    next(1)
    fireEvent.click(screen.getByRole("button", { name: "Get Started" }))
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(mocks.completeOnboarding).toHaveBeenCalledOnce()
    expect(mocks.createSession).not.toHaveBeenCalled()
  })

  it("still launches the selected available engine after saving", async () => {
    mocks.getEngines.mockResolvedValue(registry(true))
    render(<MemoryRouter><OnboardingWizard forceOpen /></MemoryRouter>)
    await screen.findByText("Welcome to Cuttlefish")
    next(3)
    await screen.findByText("Test model")
    next(1)
    fireEvent.click(screen.getByRole("button", { name: "Get Started" }))
    await waitFor(() => expect(mocks.createSession).toHaveBeenCalledWith(expect.objectContaining({ engine: "codex", model: "test-model" })))
  })

  it("reopens and dismisses the wizard even when server and browser are already onboarded", async () => {
    localStorage.setItem("cuttlefish-onboarded", "true")
    render(<MemoryRouter><ResetSection resetAll={vi.fn()} /></MemoryRouter>)
    fireEvent.click(screen.getByRole("button", { name: "Re-run Onboarding Wizard" }))
    await screen.findByText("Welcome to Cuttlefish")
    next(3)
    await screen.findByText(/No AI engine is available/)
    next(1)
    fireEvent.click(screen.getByRole("button", { name: "Get Started" }))
    await waitFor(() => expect(screen.queryByText("Welcome to Cuttlefish")).toBeNull())
    await waitFor(() => expect(screen.queryByRole("button", { name: "Get Started" })).toBeNull())
    expect(localStorage.getItem("cuttlefish-onboarded")).toBe("true")
    fireEvent.click(screen.getByRole("button", { name: "Re-run Onboarding Wizard" }))
    await screen.findByText("Welcome to Cuttlefish")
  })
})
