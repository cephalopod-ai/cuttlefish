import { useState } from "react"
import { describe, expect, it } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { EmailSettingsSection as FacadeEmailSettingsSection } from "./settings-config-sections"
import { EmailSettingsSection } from "./settings-email-section"
import type { Config } from "./settings-constants"

function setAtPath(config: Config, path: string[], value: unknown): Config {
  const next = structuredClone(config)
  let obj: Record<string, unknown> = next as Record<string, unknown>
  for (let index = 0; index < path.length - 1; index += 1) {
    if (!obj[path[index]] || typeof obj[path[index]] !== "object") obj[path[index]] = {}
    obj = obj[path[index]] as Record<string, unknown>
  }
  obj[path[path.length - 1]] = value
  return next
}

function Harness({ initialConfig = { email: { inboxes: [] } } }: { initialConfig?: Config }) {
  const [config, setConfig] = useState<Config>(initialConfig)
  return (
    <>
      <EmailSettingsSection
        config={config}
        updateConfig={(path, value) => setConfig((prev) => setAtPath(prev, path, value))}
        updateNumberConfig={(path, value) => setConfig((prev) => setAtPath(prev, path, value.trim() ? Number(value) : undefined))}
      />
      <output data-testid="config">{JSON.stringify(config)}</output>
    </>
  )
}

describe("EmailSettingsSection", () => {
  it("reuses an available inbox ID and preserves sibling edits after removal", () => {
    const initialConfig: Config = { email: { inboxes: [
      { id: "inbox-1", address: "first@example.test" },
      { id: "inbox-3", address: "third@example.test" },
    ] } }
    render(<Harness initialConfig={initialConfig} />)
    fireEvent.click(screen.getByRole("button", { name: /add inbox/i }))
    expect(screen.getByDisplayValue("inbox-2")).toBeTruthy()
    fireEvent.click(screen.getAllByRole("button", { name: /remove/i })[0])
    fireEvent.change(screen.getByDisplayValue("third@example.test"), { target: { value: "edited@example.test" } })
    const config = JSON.parse(screen.getByTestId("config").textContent ?? "{}")
    expect(config.email.inboxes.map((inbox: { id: string }) => inbox.id)).toEqual(["inbox-3", "inbox-2"])
    expect(config.email.inboxes[0].address).toBe("edited@example.test")
    expect(initialConfig.email?.inboxes?.[1].address).toBe("third@example.test")
    fireEvent.click(screen.getAllByRole("button", { name: /remove/i })[0])
    fireEvent.click(screen.getByRole("button", { name: /remove/i }))
    expect(JSON.parse(screen.getByTestId("config").textContent ?? "{}").email.inboxes).toBeUndefined()
    expect(screen.getByText("No inboxes configured yet.")).toBeTruthy()
  })

  it("clears optional numeric inbox values without retaining a zero and masks passwords", () => {
    render(<Harness initialConfig={{ email: { inboxes: [
      { id: "inbox-1", password: "test-only-password", imapPort: 993, maxMessagesPerPoll: 10 },
    ] } }} />)
    expect((screen.getByDisplayValue("test-only-password") as HTMLInputElement).type).toBe("password")
    fireEvent.change(screen.getByDisplayValue("993"), { target: { value: "" } })
    fireEvent.change(screen.getByDisplayValue("10"), { target: { value: "" } })
    const inbox = JSON.parse(screen.getByTestId("config").textContent ?? "{}").email.inboxes[0]
    expect(inbox.imapPort).toBeUndefined()
    expect(inbox.maxMessagesPerPoll).toBeUndefined()
    expect(inbox.password).toBe("test-only-password")
  })

  it("preserves component identity through the original import path", () => {
    expect(FacadeEmailSettingsSection).toBe(EmailSettingsSection)
  })

  it("keeps the inbox ID input focused while its editable value changes", () => {
    render(<Harness />)

    fireEvent.click(screen.getByRole("button", { name: /add inbox/i }))
    const inboxIdInput = screen.getByDisplayValue("inbox-1")
    inboxIdInput.focus()

    for (const value of ["c", "cu", "cut", "cutt"]) {
      fireEvent.change(inboxIdInput, { target: { value } })
      expect(screen.getByDisplayValue(value)).toBe(inboxIdInput)
      expect(document.activeElement).toBe(inboxIdInput)
    }
  })

  it("adds and removes inboxes while enforcing the three-inbox cap", () => {
    render(<Harness />)

    const addButton = screen.getByRole("button", { name: /add inbox/i })
    fireEvent.click(addButton)
    fireEvent.click(addButton)
    fireEvent.click(addButton)

    expect(screen.getAllByDisplayValue(/Inbox \d/)).toHaveLength(3)
    expect((addButton as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getAllByRole("button", { name: /remove/i })[0])

    expect(screen.getAllByDisplayValue(/Inbox \d/)).toHaveLength(2)
    expect((addButton as HTMLButtonElement).disabled).toBe(false)
  })
})
