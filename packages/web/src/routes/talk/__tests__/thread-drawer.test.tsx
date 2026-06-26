import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"
import type { GraphNode } from "../graph-store"
import { DURATION } from "../motion"

// ---------------------------------------------------------------------------
// Module mocks — the drawer's data feeds are hook-shaped, so we mock the
// modules and mutate the hoisted holders per test.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  graph: [] as unknown[],
  chat: {
    messages: [] as unknown[],
    streamingText: "",
    loading: false,
    session: undefined as Record<string, unknown> | undefined,
    isInitialLoading: false,
    error: null as Error | null,
  },
}))

vi.mock("../use-session-chat", () => ({
  useSessionChat: () => mocks.chat,
}))

vi.mock("../talk-provider", () => ({
  useTalkContext: () => ({ orchestratorId: "orch", graph: mocks.graph }),
}))

// ChatMessages pulls the whole chat renderer (markdown, media, audio) — stub it.
vi.mock("@/components/chat/chat-messages", () => ({
  ChatMessages: () => <div data-testid="chat-messages" />,
}))

vi.mock("@/lib/api", () => ({
  api: { talkDelegate: vi.fn(), sendMessage: vi.fn() },
}))

import { ThreadDrawer } from "../thread-drawer"

const node = (over: Partial<GraphNode>): GraphNode => ({
  id: "t1",
  parentId: "root",
  depth: 1,
  label: "Lead",
  employee: null,
  status: "running",
  lastActivity: "2026-06-11T00:00:00Z",
  ...over,
})

/** root ← t1 (Lead) ← g1 (Analyst) — the talk root itself is NOT a graph node. */
const chainGraph = () => [
  node({ id: "t1", parentId: "root", depth: 1, label: "Lead" }),
  node({ id: "g1", parentId: "t1", depth: 2, label: "Analyst", status: "running" }),
]

beforeEach(() => {
  mocks.graph = []
  mocks.chat.messages = []
  mocks.chat.streamingText = ""
  mocks.chat.loading = false
  mocks.chat.session = undefined
  mocks.chat.isInitialLoading = false
  mocks.chat.error = null
  vi.clearAllMocks()
})

describe("ThreadDrawer", () => {
  it("renders the breadcrumb path from graph parent links", () => {
    mocks.graph = chainGraph()
    render(<ThreadDrawer sessionId="g1" onClose={vi.fn()} onNavigate={vi.fn()} />)
    expect(screen.getByText("AURA")).toBeTruthy()
    // Ancestor crumb is a clickable button.
    expect(screen.getByRole("button", { name: "Lead" })).toBeTruthy()
    // Current crumb is emphasized, NOT a button.
    const current = screen.getByText("Analyst")
    expect(current.closest("button")).toBeNull()
  })

  it("ancestor crumb click navigates the drawer to that session", () => {
    mocks.graph = chainGraph()
    const onNavigate = vi.fn()
    render(<ThreadDrawer sessionId="g1" onClose={vi.fn()} onNavigate={onNavigate} />)
    fireEvent.click(screen.getByRole("button", { name: "Lead" }))
    expect(onNavigate).toHaveBeenCalledWith("t1")
  })

  it("lists sub-threads from childrenOf and descends on click", () => {
    mocks.graph = chainGraph()
    const onNavigate = vi.fn()
    render(<ThreadDrawer sessionId="t1" onClose={vi.fn()} onNavigate={onNavigate} />)
    expect(screen.getByText("Sub-threads")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /open sub-thread: analyst/i }))
    expect(onNavigate).toHaveBeenCalledWith("g1")
  })

  it("renders no Sub-threads strip when the node has no children", () => {
    mocks.graph = chainGraph()
    render(<ThreadDrawer sessionId="g1" onClose={vi.fn()} onNavigate={vi.fn()} />)
    expect(screen.queryByText("Sub-threads")).toBeNull()
  })

  it("renders the chat surface for running empty sessions", () => {
    mocks.chat.loading = true
    render(<ThreadDrawer sessionId="t1" onClose={vi.fn()} onNavigate={vi.fn()} />)
    expect(screen.getByTestId("chat-messages")).toBeTruthy()
    expect(screen.queryByText("No messages yet")).toBeNull()
  })

  it("Escape calls onClose", () => {
    mocks.graph = chainGraph()
    const onClose = vi.fn()
    render(<ThreadDrawer sessionId="t1" onClose={onClose} onNavigate={vi.fn()} />)
    fireEvent.keyDown(document, { key: "Escape" })
    expect(onClose).toHaveBeenCalled()
  })

  it("scrim click calls onClose", () => {
    mocks.graph = chainGraph()
    const onClose = vi.fn()
    const { container } = render(
      <ThreadDrawer sessionId="t1" onClose={onClose} onNavigate={vi.fn()} />,
    )
    const scrim = container.querySelector(".tdrawer-scrim")
    expect(scrim).toBeTruthy()
    fireEvent.click(scrim!)
    expect(onClose).toHaveBeenCalled()
  })

  it("shows plain Attach buttons when the session is not attached", () => {
    mocks.graph = chainGraph()
    render(<ThreadDrawer sessionId="t1" onClose={vi.fn()} onNavigate={vi.fn()} />)
    expect(screen.getByRole("button", { name: "Attach" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Attach + engage" })).toBeTruthy()
    expect(screen.queryByLabelText("Message this session")).toBeNull()
  })

  it("shows the engage composer only when attached in engage mode", () => {
    mocks.graph = [node({ id: "t1", attached: true, mode: "engage" })]
    render(<ThreadDrawer sessionId="t1" onClose={vi.fn()} onNavigate={vi.fn()} />)
    expect(screen.getByLabelText("Message this session")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Detach" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Attach + engage" })).toBeNull()
  })

  it("falls back to AURA ▸ header label when the node left the graph", () => {
    mocks.graph = []
    mocks.chat.session = { title: "Old Thread" }
    render(<ThreadDrawer sessionId="zz" onClose={vi.fn()} onNavigate={vi.fn()} />)
    expect(screen.getByText("AURA")).toBeTruthy()
    const current = screen.getByText("Old Thread")
    expect(current.closest("button")).toBeNull()
  })

  it("renders nothing while closed (sessionId null)", () => {
    const { container } = render(
      <ThreadDrawer sessionId={null} onClose={vi.fn()} onNavigate={vi.fn()} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it("Escape during IME composition does NOT close", () => {
    mocks.graph = chainGraph()
    const onClose = vi.fn()
    render(<ThreadDrawer sessionId="t1" onClose={onClose} onNavigate={vi.fn()} />)
    fireEvent.keyDown(document, { key: "Escape", isComposing: true })
    expect(onClose).not.toHaveBeenCalled()
    // Sanity: a plain Escape still closes.
    fireEvent.keyDown(document, { key: "Escape" })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("uses sideState labelOverride (deriveLabel'd) for crumbs, current and child rows", () => {
    mocks.graph = chainGraph()
    const sideState = new Map([
      ["t1", { labelOverride: "Renamed Lead" }],
      ["g1", { labelOverride: "Renamed Analyst" }],
    ])
    render(
      <ThreadDrawer
        sessionId="t1"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        sideState={sideState}
      />,
    )
    // Current crumb uses the override…
    expect(screen.getByText("Renamed Lead")).toBeTruthy()
    expect(screen.queryByText("Lead")).toBeNull()
    // …and so does the child row.
    expect(
      screen.getByRole("button", { name: /open sub-thread: renamed analyst/i }),
    ).toBeTruthy()
  })

  it("keeps the Sub-threads label outside the role=list element", () => {
    mocks.graph = chainGraph()
    render(<ThreadDrawer sessionId="t1" onClose={vi.fn()} onNavigate={vi.fn()} />)
    const list = screen.getByRole("list", { name: "Sub-threads" })
    const label = screen.getByText("Sub-threads")
    expect(list.contains(label)).toBe(false)
  })

  it("Tab wraps focus from last to first focusable inside the panel", () => {
    mocks.graph = chainGraph()
    const { container } = render(
      <ThreadDrawer sessionId="t1" onClose={vi.fn()} onNavigate={vi.fn()} />,
    )
    const panel = container.querySelector<HTMLElement>(".tdrawer")!
    const focusables = panel.querySelectorAll<HTMLElement>(
      'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])',
    )
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    last.focus()
    fireEvent.keyDown(last, { key: "Tab" })
    expect(document.activeElement).toBe(first)
    // Shift+Tab from the first wraps back to the last.
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true })
    expect(document.activeElement).toBe(last)
  })
})

// ---------------------------------------------------------------------------
// Close-path lifecycle — jsdom never fires transitionend, so the fallback
// timer path is the deterministic exit under fake timers.
// ---------------------------------------------------------------------------
describe("ThreadDrawer close-path lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const drawer = (sessionId: string | null, onClose = vi.fn()) => (
    <ThreadDrawer sessionId={sessionId} onClose={onClose} onNavigate={vi.fn()} />
  )

  it("keeps content mounted during exit, unmounts after the fallback timer", () => {
    mocks.graph = chainGraph()
    const { container, rerender } = render(drawer("t1"))
    expect(container.querySelector(".tdrawer")).toBeTruthy()

    rerender(drawer(null))
    // Exit state: still mounted immediately (panel slides out).
    expect(container.querySelector(".tdrawer")).toBeTruthy()

    act(() => {
      vi.advanceTimersByTime(DURATION.slow + 50)
    })
    expect(container.querySelector(".tdrawer")).toBeNull()
  })

  it("rapid null→new-id during exit cancels the pending unmount and shows the new session", () => {
    mocks.graph = chainGraph()
    const { container, rerender } = render(drawer("t1"))

    rerender(drawer(null))
    rerender(drawer("g1"))

    act(() => {
      vi.advanceTimersByTime(DURATION.slow + 50)
    })
    // Pending unmount was cancelled; the drawer now shows g1 (current crumb).
    expect(container.querySelector(".tdrawer")).toBeTruthy()
    expect(screen.getByText("Analyst")).toBeTruthy()
  })

  it("focuses the panel on open and restores the trigger on close", () => {
    mocks.graph = chainGraph()
    const trigger = document.createElement("button")
    document.body.appendChild(trigger)
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    const { container, rerender } = render(drawer("t1"))
    const panel = container.querySelector<HTMLElement>(".tdrawer")!
    expect(panel.contains(document.activeElement)).toBe(true)

    rerender(drawer(null))
    act(() => {
      vi.advanceTimersByTime(DURATION.slow + 50)
    })
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })
})
