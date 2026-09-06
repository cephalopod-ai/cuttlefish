import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ReactFlowProvider } from "@xyflow/react"
import { DepartmentGroupNode, type DepartmentGroupNodeData } from "./department-group-node"

function renderGroup(data: DepartmentGroupNodeData) {
  const nodeProps = {
    data,
    id: `group-${data.label}`,
    type: "departmentGroup",
    selected: false,
    dragging: false,
    zIndex: 0,
    isConnectable: false,
  } as never

  return render(
    <ReactFlowProvider>
      <DepartmentGroupNode {...(nodeProps as Parameters<typeof DepartmentGroupNode>[0])} />
    </ReactFlowProvider>,
  )
}

describe("DepartmentGroupNode — rename from the group header", () => {
  it("shows a rename control on a real department", () => {
    renderGroup({ label: "dataflow", renamable: true, onRename: vi.fn() })
    expect(screen.getByRole("button", { name: "Rename dataflow department" })).toBeTruthy()
  })

  it("offers no rename for the synthetic Unassigned block", () => {
    // Nothing backs it on disk, so there is nothing to rename.
    renderGroup({ label: "Unassigned", renamable: false, onRename: vi.fn() })
    expect(screen.queryByRole("button", { name: /Rename/ })).toBeNull()
  })

  it("offers no rename when the page supplied no handler", () => {
    renderGroup({ label: "qa", renamable: true })
    expect(screen.queryByRole("button", { name: /Rename/ })).toBeNull()
  })

  it("renames on Enter, sending the trimmed value", async () => {
    const onRename = vi.fn().mockResolvedValue(undefined)
    renderGroup({ label: "qa", renamable: true, onRename })

    fireEvent.click(screen.getByRole("button", { name: "Rename qa department" }))
    const input = screen.getByLabelText("Rename qa department") as HTMLInputElement
    expect(input.value).toBe("qa")

    fireEvent.change(input, { target: { value: "  quality  " } })
    fireEvent.keyDown(input, { key: "Enter" })

    await waitFor(() => expect(onRename).toHaveBeenCalledWith("quality"))
  })

  it("closes without calling the handler on Escape", () => {
    const onRename = vi.fn()
    renderGroup({ label: "qa", renamable: true, onRename })

    fireEvent.click(screen.getByRole("button", { name: "Rename qa department" }))
    fireEvent.change(screen.getByLabelText("Rename qa department"), { target: { value: "quality" } })
    fireEvent.keyDown(screen.getByLabelText("Rename qa department"), { key: "Escape" })

    expect(onRename).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Rename qa department" })).toBeTruthy()
  })

  it("does not fire a rename for an unchanged or blank name", () => {
    const onRename = vi.fn()
    renderGroup({ label: "qa", renamable: true, onRename })

    fireEvent.click(screen.getByRole("button", { name: "Rename qa department" }))
    fireEvent.keyDown(screen.getByLabelText("Rename qa department"), { key: "Enter" })
    expect(onRename).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Rename qa department" }))
    fireEvent.change(screen.getByLabelText("Rename qa department"), { target: { value: "   " } })
    fireEvent.keyDown(screen.getByLabelText("Rename qa department"), { key: "Enter" })
    expect(onRename).not.toHaveBeenCalled()
  })

  it("keeps the field open and shows the gateway's reason when the rename is refused", async () => {
    const onRename = vi.fn().mockRejectedValue(new Error('department "quality" already exists'))
    renderGroup({ label: "qa", renamable: true, onRename })

    fireEvent.click(screen.getByRole("button", { name: "Rename qa department" }))
    const input = screen.getByLabelText("Rename qa department")
    fireEvent.change(input, { target: { value: "quality" } })
    fireEvent.keyDown(input, { key: "Enter" })

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain('department "quality" already exists')
    // The operator's typing survives a refusal, so they can correct it.
    expect((screen.getByLabelText("Rename qa department") as HTMLInputElement).value).toBe("quality")
  })

  it("does not submit twice while a rename is in flight", async () => {
    let release: (() => void) | undefined
    const onRename = vi.fn().mockReturnValue(new Promise<void>((resolve) => { release = () => resolve() }))
    renderGroup({ label: "qa", renamable: true, onRename })

    fireEvent.click(screen.getByRole("button", { name: "Rename qa department" }))
    const input = screen.getByLabelText("Rename qa department")
    fireEvent.change(input, { target: { value: "quality" } })
    fireEvent.keyDown(input, { key: "Enter" })
    fireEvent.keyDown(input, { key: "Enter" })

    expect(onRename).toHaveBeenCalledTimes(1)
    // The field is locked while the write is in flight...
    expect((input as HTMLInputElement).disabled).toBe(true)

    release?.()
    // ...and closes once it lands, leaving the header back at rest.
    await waitFor(() => expect(screen.getByRole("button", { name: "Rename qa department" })).toBeTruthy())
  })

  it("marks the field so React Flow does not treat typing as a canvas pan", () => {
    renderGroup({ label: "qa", renamable: true, onRename: vi.fn() })
    fireEvent.click(screen.getByRole("button", { name: "Rename qa department" }))
    const input = screen.getByLabelText("Rename qa department")
    expect(input.className).toContain("nodrag")
    expect(input.className).toContain("nopan")
  })

  it("still renders the department name", () => {
    renderGroup({ label: "engineering", renamable: true, onRename: vi.fn() })
    expect(screen.getByText("engineering")).toBeTruthy()
  })
})
