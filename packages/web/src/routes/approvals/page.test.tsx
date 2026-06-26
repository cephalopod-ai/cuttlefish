import { describe, expect, it, vi, beforeEach } from "vitest"
import { MemoryRouter } from "react-router-dom"
import { render, screen } from "@testing-library/react"
import type { Approval, Checkpoint } from "@/lib/api"

const approvalsState = vi.hoisted(() => ({
  approvals: [] as Approval[],
  approvalsLoading: false,
  approvalsError: null as Error | null,
  checkpoints: [] as Checkpoint[],
  checkpointsLoading: false,
  checkpointsError: null as Error | null,
}))

vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock("@/context/breadcrumb-context", () => ({
  useBreadcrumbs: () => undefined,
}))

vi.mock("@/hooks/use-approvals", () => ({
  useApprovals: () => ({
    data: approvalsState.approvals,
    isLoading: approvalsState.approvalsLoading,
    error: approvalsState.approvalsError,
  }),
  useApproveApproval: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useRejectApproval: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}))

vi.mock("@/hooks/use-checkpoints", () => ({
  useCheckpoints: () => ({
    data: approvalsState.checkpoints,
    isLoading: approvalsState.checkpointsLoading,
    error: approvalsState.checkpointsError,
  }),
  useDecideCheckpoint: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
}))

import ApprovalsPage from "./page"

describe("ApprovalsPage", () => {
  beforeEach(() => {
    approvalsState.approvals = []
    approvalsState.approvalsLoading = false
    approvalsState.approvalsError = null
    approvalsState.checkpoints = []
    approvalsState.checkpointsLoading = false
    approvalsState.checkpointsError = null
  })

  it("renders fallback approvals and human checkpoints in separate sections", () => {
    approvalsState.approvals = [{
      id: "approval-1",
      sessionId: "session-12345678",
      type: "fallback",
      payload: {
        from: { engine: "claude", model: "sonnet" },
        to: { engine: "codex", model: "gpt-5.5" },
        reason: "rate_limit",
      },
      state: "pending",
      createdAt: "2026-06-26T10:00:00.000Z",
    }]
    approvalsState.checkpoints = [{
      id: "checkpoint-1",
      sessionId: "session-87654321",
      type: "checkpoint",
      payload: {
        decisionNeeded: "Approve deleting generated report",
        why: "This will remove the current draft artifact before rewriting it.",
        affectedFiles: ["reports/draft.md"],
        affectedArtifacts: ["artifact-1"],
        affectedActions: ["delete artifact-1"],
        options: ["approved", "deferred", "revised", "rejected"],
      },
      state: "pending",
      createdAt: "2026-06-26T11:00:00.000Z",
    }]

    render(
      <MemoryRouter>
        <ApprovalsPage />
      </MemoryRouter>,
    )

    expect(screen.getByText("Fallback approvals")).toBeTruthy()
    expect(screen.getByText("Human checkpoints")).toBeTruthy()
    expect(screen.getByText("Approve deleting generated report")).toBeTruthy()
    expect(screen.getByText("reports/draft.md")).toBeTruthy()
    expect(screen.getByRole("button", { name: /Revise & resume/i })).toBeTruthy()
  })

  it("renders a visible error state when either queue fails to load", () => {
    approvalsState.approvalsError = new Error("approval fetch failed")

    render(
      <MemoryRouter>
        <ApprovalsPage />
      </MemoryRouter>,
    )

    expect(screen.getByText("approval fetch failed")).toBeTruthy()
  })
})
