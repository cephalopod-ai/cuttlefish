import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { FieldRow, SettingsInput, SettingsSelect, SettingsTextarea, ToggleSwitch } from "./settings-fields"

describe("settings field labels", () => {
  it("associates visible labels with native inputs, selects, textareas and switches", () => {
    const change = vi.fn()
    render(<>
      <FieldRow label="Port"><SettingsInput value="8888" type="number" onChange={change} /></FieldRow>
      <FieldRow label="Engine"><SettingsSelect value="fixture" options={[{ value: "fixture", label: "Fixture" }]} onChange={change} /></FieldRow>
      <FieldRow label="Notes"><SettingsTextarea value="owned text" onChange={change} /></FieldRow>
      <FieldRow label="Enabled"><ToggleSwitch checked={false} onChange={change} /></FieldRow>
    </>)

    expect(screen.getByLabelText("Port").tagName).toBe("INPUT")
    expect(screen.getByRole("combobox", { name: "Engine" })).toBe(screen.getByLabelText("Engine"))
    expect(screen.getByRole("textbox", { name: "Notes" }).tagName).toBe("TEXTAREA")
    const toggle = screen.getByRole("switch", { name: "Enabled" })
    fireEvent.click(toggle)
    expect(change).toHaveBeenCalledWith(true)
  })

  it("keeps repeated field identities unique", () => {
    render(<>
      <FieldRow label="Enabled"><ToggleSwitch checked={false} onChange={vi.fn()} /></FieldRow>
      <FieldRow label="Enabled"><ToggleSwitch checked={true} onChange={vi.fn()} /></FieldRow>
    </>)
    const controls = screen.getAllByRole("switch", { name: "Enabled" })
    expect(controls.map(control => control.id).every(Boolean)).toBe(true)
    expect(new Set(controls.map(control => control.id)).size).toBe(controls.length)
  })

  it("names grouped start and end controls without duplicate IDs", () => {
    render(<FieldRow label="Weekday Window" multiple>
      <SettingsInput value="22:00" ariaLabel="Weekday Window Start" onChange={vi.fn()} />
      <SettingsInput value="04:00" ariaLabel="Weekday Window End" onChange={vi.fn()} />
    </FieldRow>)
    const start = screen.getByRole("textbox", { name: "Weekday Window Start" })
    const end = screen.getByRole("textbox", { name: "Weekday Window End" })
    expect(start.id).not.toBe(end.id)
    expect(screen.getByRole("group", { name: "Weekday Window" }).contains(start)).toBe(true)
  })
})
