import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { api } from "@/lib/api"
import { SttSettingsSection } from "./stt-section"

vi.mock("@/lib/api", () => ({
  api: {
    sttStatus: vi.fn(),
    sttUpdateConfig: vi.fn(),
    sttDownload: vi.fn(),
  },
}))

const ready = { available: true, model: "small", downloading: false, progress: 0, languages: ["en"] }

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.sttStatus).mockResolvedValue(ready)
  vi.mocked(api.sttUpdateConfig).mockResolvedValue({ status: "ok", languages: ["en", "fr"] })
  vi.mocked(api.sttDownload).mockResolvedValue({ status: "downloading", model: "small" })
})

describe("voice settings feedback", () => {
  it("names the language control, retains failed input, and applies a successful retry", async () => {
    vi.mocked(api.sttUpdateConfig).mockRejectedValueOnce(new Error("Voice preferences unavailable"))
    render(<SttSettingsSection />)
    const language = await screen.findByRole("combobox", { name: "Add transcription language" }) as HTMLSelectElement
    fireEvent.change(language, { target: { value: "fr" } })
    fireEvent.click(screen.getByRole("button", { name: "Add" }))

    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Voice preferences unavailable")
    expect(language.value).toBe("fr")
    expect(screen.queryByRole("button", { name: "Remove French" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    expect(await screen.findByRole("button", { name: "Remove French" })).toBeTruthy()
    expect(language.value).toBe("")
    expect(screen.queryByRole("alert")).toBeNull()
    expect(api.sttUpdateConfig).toHaveBeenLastCalledWith(["en", "fr"])
  })

  it("keeps saved languages visible when removal fails", async () => {
    vi.mocked(api.sttStatus).mockResolvedValue({ ...ready, languages: ["en", "fr"] })
    vi.mocked(api.sttUpdateConfig).mockRejectedValue(new Error("Cannot remove language"))
    render(<SttSettingsSection />)
    fireEvent.click(await screen.findByRole("button", { name: "Remove French" }))
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Cannot remove language")
    expect(screen.getByRole("button", { name: "Remove French" })).toBeTruthy()
    expect(api.sttUpdateConfig).toHaveBeenCalledWith(["en"])
  })

  it("shows status-load failures and lets the operator retry", async () => {
    vi.mocked(api.sttStatus).mockRejectedValueOnce(new Error("Voice status unavailable"))
    render(<SttSettingsSection />)
    expect((await screen.findByRole("alert")).textContent).toContain("Voice status unavailable")
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(await screen.findByRole("combobox", { name: "Add transcription language" })).toBeTruthy()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("prevents duplicate download requests and exposes a rejected start for retry", async () => {
    vi.mocked(api.sttStatus).mockResolvedValue({ ...ready, available: false, model: null })
    let rejectDownload!: (reason: Error) => void
    vi.mocked(api.sttDownload).mockReturnValueOnce(new Promise((_resolve, reject) => { rejectDownload = reject }))
    render(<SttSettingsSection />)
    fireEvent.click(await screen.findByRole("button", { name: "Download Whisper Small (~500MB)" }))
    const starting = screen.getByRole("button", { name: "Starting download..." }) as HTMLButtonElement
    expect(starting.disabled).toBe(true)
    fireEvent.click(starting)
    expect(api.sttDownload).toHaveBeenCalledTimes(1)
    rejectDownload(new Error("Download unavailable"))
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Download unavailable")
    await waitFor(() => expect(screen.getByRole("button", { name: "Download Whisper Small (~500MB)" })).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: "Download Whisper Small (~500MB)" }))
    expect(await screen.findByText("Downloading model…")).toBeTruthy()
    expect(screen.queryByRole("alert")).toBeNull()
  })
})
