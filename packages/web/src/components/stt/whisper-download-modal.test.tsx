import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { WhisperDownloadModal } from "./whisper-download-modal"

describe("WhisperDownloadModal", () => {
  it("announces a modal, moves focus inside, traps Tab, and restores focus", () => {
    const opener = document.createElement("button")
    document.body.appendChild(opener)
    opener.focus()
    const onCancel = vi.fn()
    const { rerender } = render(
      <WhisperDownloadModal open progress={null} onDownload={() => {}} onCancel={onCancel} />,
    )

    const dialog = screen.getByRole("dialog", { name: "Enable voice input?" })
    const cancel = screen.getByRole("button", { name: "Cancel" })
    const download = screen.getByRole("button", { name: "Download" })
    expect(document.activeElement).toBe(cancel)
    download.focus()
    fireEvent.keyDown(dialog, { key: "Tab" })
    expect(document.activeElement).toBe(cancel)

    rerender(<WhisperDownloadModal open={false} progress={null} onDownload={() => {}} onCancel={onCancel} />)
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it("cancels with Escape only before a download starts", () => {
    const onCancel = vi.fn()
    const { rerender } = render(
      <WhisperDownloadModal open progress={null} onDownload={() => {}} onCancel={onCancel} />,
    )
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })
    expect(onCancel).toHaveBeenCalledTimes(1)

    rerender(<WhisperDownloadModal open progress={10} onDownload={() => {}} onCancel={onCancel} />)
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it("keeps focus inside the dialog while the download has no enabled controls", () => {
    const background = document.createElement("button")
    document.body.appendChild(background)
    const { rerender } = render(
      <WhisperDownloadModal open progress={null} onDownload={() => {}} onCancel={() => {}} />,
    )

    rerender(<WhisperDownloadModal open progress={25} onDownload={() => {}} onCancel={() => {}} />)
    const dialog = screen.getByRole("dialog")
    expect(document.activeElement).toBe(dialog)
    fireEvent.keyDown(dialog, { key: "Tab" })
    expect(document.activeElement).toBe(dialog)
    expect(document.activeElement).not.toBe(background)
    background.remove()
  })
})
