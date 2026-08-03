import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { CollaborationComposer } from "../collaboration-composer"

function openRecipientPulldown() {
  const trigger = screen.getByLabelText("Select recipients")
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" })
  fireEvent.mouseDown(trigger, { button: 0, ctrlKey: false })
}

describe("CollaborationComposer", () => {
  it("uses the recipient pulldown and submits structured Team recipient IDs", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined)
    render(<CollaborationComposer lane="team" recipients={[{ id: "builder", displayName: "Builder" }]} onSend={onSend} />)
    const input = screen.getByLabelText("Team message")
    openRecipientPulldown()
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Builder/ }))
    fireEvent.change(input, { target: { value: "Please investigate" } })
    fireEvent.click(screen.getByLabelText("Send collaboration message"))
    await waitFor(() => expect(onSend).toHaveBeenCalledWith({ message: "Please investigate", recipientIds: ["builder"] }))
  })

  it("offers all active recipients from the pulldown and requires their confirmation", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined)
    render(<CollaborationComposer lane="team" recipients={[{ id: "one", displayName: "One" }, { id: "two", displayName: "Two" }]} onSend={onSend} />)
    const input = screen.getByLabelText("Team message")
    openRecipientPulldown()
    fireEvent.click(screen.getByRole("menuitem", { name: /Message all active recipients/ }))
    fireEvent.click(screen.getByRole("button", { name: "Confirm 2 recipients" }))
    fireEvent.change(input, { target: { value: "Status update" } })
    fireEvent.click(screen.getByLabelText("Send collaboration message"))
    await waitFor(() => expect(onSend).toHaveBeenCalledWith({
      message: "Status update", recipientMode: "all", confirmAllRecipients: ["one", "two"],
    }))
  })

  it("only attaches one-turn authority to an explicit eligible management recipient", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined)
    render(<CollaborationComposer lane="management" recipients={[{ id: "cuttlefish", displayName: "COO", rank: "executive", active: true }]} onSend={onSend} />)
    const input = screen.getByLabelText("Management message")
    openRecipientPulldown()
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /COO/ }))
    fireEvent.click(screen.getByRole("checkbox", { name: "approve" }))
    fireEvent.change(input, { target: { value: "Approve this turn" } })
    fireEvent.click(screen.getByLabelText("Send collaboration message"))
    await waitFor(() => expect(onSend).toHaveBeenCalledWith({
      message: "Approve this turn", recipientIds: ["cuttlefish"], operatorDelegationScopes: ["approve"],
    }))
  })
})
