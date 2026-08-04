import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { ProjectSummary } from "@cuttlefish/contracts"
import { ProjectDeleteDialog } from "../project-delete-dialog"

const project: ProjectSummary = {
  rootSessionId: "project-root",
  title: "Old chat",
  lastActivity: "2026-08-04T00:00:00.000Z",
  jobState: "finished",
  sessionCount: 3,
  participantIds: [],
  integrity: "valid",
  runningCount: 0,
  needsAttentionCount: 0,
}

describe("ProjectDeleteDialog", () => {
  it("uses a Yes/No decision without requiring typed confirmation", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    render(
      <ProjectDeleteDialog
        project={project}
        open
        deleting={false}
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
      />,
    )

    expect(screen.queryByLabelText("Project deletion confirmation")).toBeNull()
    expect(screen.getByRole("button", { name: "No" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete" }))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith())
  })

  it("closes without deleting when the operator chooses No", () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    const onOpenChange = vi.fn()
    render(
      <ProjectDeleteDialog
        project={project}
        open
        deleting={false}
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "No" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
