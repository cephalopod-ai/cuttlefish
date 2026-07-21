import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ContactRow, EmployeeRow, SectionLabel, SessionRow, StatusDot } from "../sidebar-row-components"
import type { Session } from "../sidebar-types"

vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuItem: ({ children, ...props }: { children: React.ReactNode; [key: string]: unknown }) => <div {...props}>{children}</div>,
  ContextMenuSeparator: () => <hr />,
}))

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuItem: ({ children, ...props }: { children: React.ReactNode; [key: string]: unknown }) => <div {...props}>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
}))

vi.mock("@/components/ui/employee-avatar", () => ({
  EmployeeAvatar: ({ name }: { name: string }) => <div>{name}</div>,
}))

describe("sidebar row components", () => {
  it("renders a section label with its count", () => {
    render(<SectionLabel label="Managers" count={3} />)

    expect(screen.getByText("Managers")).toBeTruthy()
    expect(screen.getByText("3")).toBeTruthy()
  })

  it("exposes the status dot label for assistive text when present", () => {
    render(<StatusDot color="red" pulse title="running" />)

    expect(screen.getByLabelText("running")).toBeTruthy()
  })

  it("starts a contact chat with the selected employee", () => {
    const onContact = vi.fn()

    render(
      <ContactRow
        emp={{
          name: "cuttlefish",
          displayName: "Cuttlefish Dev",
          department: "platform",
          rank: "employee",
          engine: "claude",
          model: "opus",
          persona: "",
        }}
        onContact={onContact}
      />,
    )

    fireEvent.click(screen.getByTitle("Start a chat with Cuttlefish Dev"))
    expect(onContact).toHaveBeenCalledWith("cuttlefish")
  })

  it("uses the live session action contract with archive actions", () => {
    const setArchiveTarget = vi.fn()
    const session: Session = {
      id: "s-1",
      employee: "cuttlefish",
      title: "Cuttlefish - Status",
      source: "web",
      sourceRef: "web:s-1",
      status: "idle",
      createdAt: "2026-06-25T10:00:00.000Z",
      lastActivity: "2026-06-25T10:00:00.000Z",
    }

    render(
      <SessionRow
        session={session}
        selectedId={null}
        readSessions={new Set([session.id])}
        pinnedSessions={new Set()}
        renamingSessionId={null}
        renameCancelledRef={{ current: false }}
        fixTitle={(title) => title ?? "Untitled"}
        onSelect={vi.fn()}
        onEmployeeSessionsAvailable={vi.fn()}
        togglePin={vi.fn()}
        handleDuplicate={vi.fn()}
        setArchiveTarget={setArchiveTarget}
        setDeleteTarget={vi.fn()}
        setRenamingSessionId={vi.fn()}
        updateSessionTitle={vi.fn()}
      />,
    )

    expect(screen.getAllByText("Rename").length).toBeGreaterThan(0)
    expect(screen.getAllByText("Duplicate...").length).toBeGreaterThan(0)
    expect(screen.getAllByText("Archive...").length).toBeGreaterThan(0)
    expect(screen.getAllByText("Delete session").length).toBeGreaterThan(0)
    fireEvent.click(screen.getAllByText("Archive...")[0])
    expect(setArchiveTarget).toHaveBeenCalledWith(expect.objectContaining({
      kind: "chat",
      title: "Cuttlefish - Status",
      sessionIds: ["s-1"],
    }))
    const actionsButton = screen.getByLabelText("Session actions")
    const buttons = screen.getAllByRole("button")
    const rowButton = buttons.find((button) => button !== actionsButton && button.textContent?.includes("Cuttlefish - Status"))
    expect(rowButton).toBeTruthy()
    expect(rowButton?.contains(actionsButton)).toBe(false)
  })

  it("renders an accessible new-agent-message indicator for an unread completed session", () => {
    const session: Session = {
      id: "s-agent-message",
      title: "Delegated work",
      source: "web",
      sourceRef: "web:s-agent-message",
      status: "idle",
      jobState: "finished",
      lastAgentMessageAt: "2026-07-20T20:00:00.000Z",
      createdAt: "2026-07-20T19:00:00.000Z",
      lastActivity: "2026-07-20T20:00:00.000Z",
    }

    render(
      <SessionRow
        session={session}
        selectedId={null}
        readSessions={new Set()}
        pinnedSessions={new Set()}
        renamingSessionId={null}
        renameCancelledRef={{ current: false }}
        fixTitle={(title) => title ?? "Untitled"}
        onSelect={vi.fn()}
        onEmployeeSessionsAvailable={vi.fn()}
        togglePin={vi.fn()}
        handleDuplicate={vi.fn()}
        setArchiveTarget={vi.fn()}
        setDeleteTarget={vi.fn()}
        setRenamingSessionId={vi.fn()}
        updateSessionTitle={vi.fn()}
      />,
    )

    expect(screen.getByLabelText("new agent message")).toBeTruthy()
    // The label and title live in separate elements (so the label can be
    // colored independently) — match on the combined textContent rather than
    // getByText's default direct-text-node-only comparison.
    expect(
      screen.getByText(
        (_, element) => element?.textContent === "New agent message · Delegated work",
      ),
    ).toBeTruthy()
  })

  it("color-codes the job-state label on a nested session row, not just top-level flat rows", () => {
    const session: Session = {
      id: "s-attention",
      title: "Blocked task",
      source: "web",
      sourceRef: "web:s-attention",
      status: "waiting",
      createdAt: "2026-07-20T19:00:00.000Z",
      lastActivity: "2026-07-20T19:00:00.000Z",
    }

    render(
      <SessionRow
        session={session}
        selectedId={null}
        readSessions={new Set([session.id])}
        pinnedSessions={new Set()}
        renamingSessionId={null}
        renameCancelledRef={{ current: false }}
        fixTitle={(title) => title ?? "Untitled"}
        onSelect={vi.fn()}
        onEmployeeSessionsAvailable={vi.fn()}
        togglePin={vi.fn()}
        handleDuplicate={vi.fn()}
        setArchiveTarget={vi.fn()}
        setDeleteTarget={vi.fn()}
        setRenamingSessionId={vi.fn()}
        updateSessionTitle={vi.fn()}
      />,
    )

    const label = screen.getByText("Needs your attention")
    expect(label.className).toContain("text-[var(--system-orange)]")
  })

  it("employee row's status dot surfaces the most urgent child session, not just the latest one", () => {
    const newestFinished: Session = {
      id: "newest",
      employee: "alice",
      title: "Newest chat",
      source: "web",
      sourceRef: "web:newest",
      status: "idle",
      jobState: "finished",
      createdAt: "2026-07-20T20:00:00.000Z",
      lastActivity: "2026-07-20T20:00:00.000Z",
    }
    const olderNeedsAttention: Session = {
      id: "older",
      employee: "alice",
      title: "Older chat",
      source: "web",
      sourceRef: "web:older",
      status: "waiting",
      createdAt: "2026-07-20T18:00:00.000Z",
      lastActivity: "2026-07-20T18:00:00.000Z",
    }

    render(
      <EmployeeRow
        item={{
          type: "employee",
          employeeName: "alice",
          sessions: [newestFinished, olderNeedsAttention],
          sortKey: newestFinished.lastActivity!,
          pinKey: "emp:alice",
          groupKey: "alice",
          total: 2,
        }}
        selectedId={null}
        readSessions={new Set([newestFinished.id, olderNeedsAttention.id])}
        pinnedSessions={new Set()}
        expanded={{}}
        renamingSessionId={null}
        renameCancelledRef={{ current: false }}
        fixTitle={(title) => title ?? "Untitled"}
        onSelect={vi.fn()}
        onEmployeeSessionsAvailable={vi.fn()}
        togglePin={vi.fn()}
        handleMarkAllRead={vi.fn()}
        handleEmployeeClick={vi.fn()}
        setArchiveTarget={vi.fn()}
        setDeleteTarget={vi.fn()}
        onLoadMore={vi.fn()}
        loadingMore={new Set()}
        setRenamingSessionId={vi.fn()}
        updateSessionTitle={vi.fn()}
        handleDuplicate={vi.fn()}
      />,
    )

    // Both sessions are already "read"; the old aggregation only inspected the
    // newest/first-unread session and would have shown a quiet green "finished"
    // dot here, hiding the older session that's actually blocked on the user.
    expect(screen.getByLabelText("needs your attention")).toBeTruthy()
  })
})
