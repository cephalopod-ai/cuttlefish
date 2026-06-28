import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import type { OrgChangeRequest } from "@/lib/api-hr"

// Keep the test focused on the panel: stub the data hook, the app shell, and the
// breadcrumb side effect so we don't drag in the gateway/query/nav providers.
const sampleChange: OrgChangeRequest = {
  id: "change-1",
  changeType: "create_agent",
  status: "pending_approval",
  employeeName: "ui-test-reviewer",
  proposedBy: "user",
  proposed: {},
  rationale: "Need flaky UI test triage.",
  evidenceRefs: [],
  beforeYaml: null,
  afterYaml: "name: ui-test-reviewer\npersona: reviews flaky tests\n",
  riskLevel: "high",
  requiresHumanApproval: true,
  hrCritique: "Overlaps the existing QA reviewer — consider reusing it.",
  approvalId: null,
  createdAt: new Date("2026-06-27T10:00:00Z").toISOString(),
  updatedAt: new Date("2026-06-27T10:00:00Z").toISOString(),
  appliedAt: null,
}

const approveMutate = vi.fn()
const rejectMutate = vi.fn()
vi.mock("@/hooks/use-org-changes", () => ({
  useOrgChanges: () => ({ data: { changeRequests: [sampleChange] }, isLoading: false, error: null }),
  useApproveOrgChange: () => ({ mutate: approveMutate, isPending: false, error: null }),
  useRejectOrgChange: () => ({ mutate: rejectMutate, isPending: false, error: null }),
  useRetiredEmployees: () => ({ data: { employees: [] }, isLoading: false, error: null }),
}))
vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock("@/context/breadcrumb-context", () => ({ useBreadcrumbs: () => {} }))
// Stub the Radix tab primitives to passthroughs so both panels render without
// needing real pointer events to switch tabs in jsdom.
vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  TabsContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

import HrPage from "./page"

function renderPage() {
  return render(
    <MemoryRouter>
      <HrPage />
    </MemoryRouter>,
  )
}

describe("HrPage", () => {
  it("links the Chat tab to a new chat with the HR Manager employee", () => {
    renderPage()
    const link = screen.getByRole("link", { name: /open chat with hr manager/i })
    expect(link.getAttribute("href")).toBe("/?employee=hr-manager")
  })

  it("renders pending org change requests with the HR critique on the Changes tab", () => {
    renderPage()

    expect(screen.getByText("create_agent")).toBeTruthy()
    expect(screen.getByText("ui-test-reviewer")).toBeTruthy()
    expect(screen.getByText(/awaiting approval/i)).toBeTruthy()

    // Expanding the card reveals the HR critique + after YAML.
    fireEvent.click(screen.getByText("create_agent"))
    expect(screen.getByText(/overlaps the existing qa reviewer/i)).toBeTruthy()
  })

  it("approves a pending change via the approve button", () => {
    renderPage()
    fireEvent.click(screen.getByRole("button", { name: /approve & apply/i }))
    expect(approveMutate).toHaveBeenCalledWith("change-1")
  })
})
