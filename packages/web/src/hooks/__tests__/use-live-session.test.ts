/**
 * useLiveSession — read-only live pipeline (the Talk child-session modal path).
 *
 * Verifies the behaviours the modal relies on and that the old refetch-only hook
 * never had: live token streaming, live media, and a running-state spinner.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"

// Mock the API module the hook loads sessions through.
const getSession = vi.fn()
vi.mock("@/lib/api", () => ({ api: { getSession: (id: string) => getSession(id) } }))

import {
  __cacheLiveSessionSnapshotForTests,
  __clearLiveSessionSnapshotCacheForTests,
  __getLiveSessionSnapshotCacheSizeForTests,
  useLiveSession,
} from "../use-live-session"

type Listener = (event: string, payload: unknown) => void

/** A manual gateway subscribe that lets the test emit WS events. */
function makeBus() {
  let listener: Listener | null = null
  const subscribe = (fn: Listener) => {
    listener = fn
    return () => { listener = null }
  }
  const emit = (event: string, payload: unknown) => listener?.(event, payload)
  return { subscribe, emit }
}

beforeEach(() => {
  getSession.mockReset()
  __clearLiveSessionSnapshotCacheForTests()
})

describe("useLiveSession (read-only)", () => {
  it("loads history and seeds loading from running state", async () => {
    getSession.mockResolvedValue({
      status: "running",
      messages: [{ id: "m1", role: "user", content: "hi" }],
    })
    const { subscribe } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })
    expect(result.current.messages.map((m) => m.content)).toEqual(["hi"])
    expect(result.current.loading).toBe(true) // running → spinner
  })

  it("filters obsolete block types from loaded history", async () => {
    getSession.mockResolvedValue({
      status: "idle",
      messages: [{
        id: "m1",
        role: "assistant",
        content: "Answer text",
        blocks: [{
          id: "approval",
          type: "approval",
          version: 1,
          payload: { actionId: "approve" },
        }],
      }],
    })
    const { subscribe } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })

    expect(result.current.messages).toHaveLength(1)
    expect(result.current.messages[0]?.content).toBe("Answer text")
    expect(result.current.messages[0]?.blocks).toBeUndefined()
  })

  it("hydrates valid task-list blocks from loaded running history", async () => {
    getSession.mockResolvedValue({
      status: "running",
      messages: [
        {
          id: "tool-1",
          role: "assistant",
          content: "Using read_file",
          toolCall: "read_file",
        },
        {
          id: "plan-row",
          role: "assistant",
          content: "Plan",
          blocks: [{
            id: "plan",
            type: "task-list",
            version: 1,
            title: "Plan",
            payload: { items: [{ id: "a", text: "Read file", status: "running" }] },
          }],
        },
      ],
    })
    const { subscribe } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })

    expect(result.current.loading).toBe(true)
    expect(result.current.messages[0]?.toolCall).toBe("read_file")
    expect(result.current.messages[1]?.blocks?.[0]?.id).toBe("plan")
    expect(result.current.messages[1]?.blocks?.[0]?.payload).toEqual({
      items: [{ id: "a", text: "Read file", status: "running" }],
    })
  })

  it("accumulates streaming text and clears it on completion", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })

    act(() => {
      emit("session:delta", { sessionId: "s1", type: "text", content: "Hel" })
      emit("session:delta", { sessionId: "s1", type: "text", content: "lo" })
    })
    expect(result.current.streamingText).toBe("Hello")
    expect(result.current.loading).toBe(true)

    await act(async () => {
      emit("session:completed", { sessionId: "s1", result: "Hello there." })
      await Promise.resolve()
    })
    expect(result.current.streamingText).toBe("")
    expect(result.current.loading).toBe(false)
    expect(result.current.messages.at(-1)?.content).toBe("Hello there.")
  })

  it("does not duplicate the answer when a late tool_use froze the streamed text (grok dedup)", async () => {
    // Reproduces the grok duplicate: answer text streams live, then a transcript
    // tool_use lands LATE and freezes that streamed text into a permanent assistant
    // bubble. Completion then delivers the identical canonical result — which must
    // be reconciled by identity, NOT appended a second time.
    getSession.mockResolvedValue({ status: "running", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })

    act(() => {
      emit("session:delta", { sessionId: "s1", type: "text", content: "The answer is 42." })
      // Late transcript tool_use → flushes the streamed text into a permanent bubble.
      emit("session:delta", { sessionId: "s1", type: "tool_use", content: "Using read", toolName: "read" })
    })
    // After the flush: one frozen answer bubble + one tool card, nothing streaming.
    expect(result.current.streamingText).toBe("")
    expect(result.current.messages.filter((m) => m.content === "The answer is 42." && !m.toolCall)).toHaveLength(1)

    await act(async () => {
      emit("session:completed", { sessionId: "s1", result: "The answer is 42." })
      await Promise.resolve()
    })
    // Exactly ONE copy of the answer survives (no duplicate), and the transient
    // tool row is collapsed away with the rest of the active turn.
    expect(result.current.messages.filter((m) => m.content === "The answer is 42." && !m.toolCall)).toHaveLength(1)
    expect(result.current.messages.some((m) => m.toolCall === "read")).toBe(false)
  })

  it("collapses partial rows loaded from a running session when completion arrives", async () => {
    getSession.mockResolvedValue({
      status: "running",
      messages: [
        { id: "u1", role: "user", content: "do it", timestamp: 1 },
        { id: "p1", role: "assistant", content: "PROGRESS-FIRST", timestamp: 2, partial: true },
        { id: "p2", role: "assistant", content: "Using Bash", timestamp: 3, partial: true, toolCall: "Bash" },
      ],
    })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })

    expect(result.current.messages.map((m) => m.content)).toEqual(["do it", "PROGRESS-FIRST", "Using Bash"])

    await act(async () => {
      emit("session:completed", { sessionId: "s1", result: "PROGRESS-FINAL" })
      await Promise.resolve()
    })

    expect(result.current.messages.map((m) => m.content)).toEqual(["do it", "PROGRESS-FINAL"])
    expect(result.current.messages.some((m) => m.toolCall)).toBe(false)
  })

  it("collapses visible progress around a tool call to only the final answer on completion", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })

    act(() => {
      emit("session:delta", { sessionId: "s1", type: "text", content: "PROGRESS-FIRST" })
      emit("session:delta", { sessionId: "s1", type: "tool_use", content: "Using Bash", toolName: "Bash" })
      emit("session:delta", { sessionId: "s1", type: "tool_result", content: "TOOL-CALL-OK", toolName: "Bash" })
      emit("session:delta", { sessionId: "s1", type: "text", content: "PROGRESS-FINAL" })
    })

    await act(async () => {
      emit("session:completed", { sessionId: "s1", result: "PROGRESS-FINAL" })
      await Promise.resolve()
    })

    expect(result.current.messages.map((m) => m.content)).toEqual(["PROGRESS-FINAL"])
    expect(result.current.messages.some((m) => m.toolCall)).toBe(false)
  })

  it("shows transient status deltas and clears them when real output arrives", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })

    act(() => {
      emit("session:delta", { sessionId: "s1", type: "status", content: "checking" })
      emit("session:delta", { sessionId: "s1", type: "status", content: "files" })
    })
    expect(result.current.messages.map((m) => m.content)).toEqual(["Thinking: checking files"])

    act(() => {
      emit("session:delta", { sessionId: "s1", type: "status", content: "Plan: patch parser" })
    })
    expect(result.current.messages.map((m) => m.content)).toEqual(["Plan: patch parser"])
    expect(result.current.messages[0]?.role).toBe("notification")

    act(() => {
      emit("session:delta", { sessionId: "s1", type: "text", content: "Done" })
    })
    expect(result.current.messages).toEqual([])
    expect(result.current.streamingText).toBe("Done")

    await act(async () => {
      emit("session:completed", { sessionId: "s1", result: "Done." })
      await Promise.resolve()
    })
    expect(result.current.messages.map((m) => m.content)).toEqual(["Done."])
  })

  it("applies live block put, patch, and remove deltas without text duplication", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })

    act(() => {
      emit("session:delta", { sessionId: "s1", type: "text", content: "Intro" })
      emit("session:delta", {
        sessionId: "s1",
        type: "block",
        content: "Plan",
        block: {
          op: "put",
          block: {
            id: "plan",
            type: "task-list",
            version: 1,
            title: "Plan",
            payload: { items: [{ id: "a", text: "Read code", status: "running" }] },
          },
        },
      })
    })

    expect(result.current.streamingText).toBe("")
    expect(result.current.messages.filter((m) => m.content === "Intro")).toHaveLength(1)
    expect(result.current.messages.at(-1)?.blocks?.[0]?.id).toBe("plan")

    act(() => {
      emit("session:delta", {
        sessionId: "s1",
        type: "block",
        content: "Plan complete",
        block: {
          op: "patch",
          block: {
            id: "plan",
            type: "task-list",
            version: 1,
            status: "done",
            payload: { summary: "Complete" },
          },
        },
      })
    })

    expect(result.current.messages.filter((m) => m.blocks?.[0]?.id === "plan")).toHaveLength(1)
    expect(result.current.messages.filter((m) => m.content === "Intro")).toHaveLength(1)
    expect(result.current.messages.find((m) => m.blocks?.[0]?.id === "plan")?.content).toBe("Plan complete")
    expect(result.current.messages.find((m) => m.blocks?.[0]?.id === "plan")?.blocks?.[0]?.payload).toMatchObject({ summary: "Complete" })

    act(() => {
      emit("session:delta", {
        sessionId: "s1",
        type: "block",
        block: {
          op: "remove",
          block: { id: "plan", type: "task-list", version: 1, payload: {} },
        },
      })
    })

    expect(result.current.messages.filter((m) => m.blocks?.[0]?.id === "plan")).toHaveLength(0)
    expect(result.current.messages.filter((m) => m.content === "Intro")).toHaveLength(1)
  })

  it("keeps live task-list blocks separate from tool-call rows", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })

    act(() => {
      emit("session:delta", { sessionId: "s1", type: "tool_use", toolName: "file_edit", content: "file_edit" })
      emit("session:delta", {
        sessionId: "s1",
        type: "block",
        content: "Plan",
        block: {
          op: "put",
          block: {
            id: "plan",
            type: "task-list",
            version: 1,
            title: "Plan",
            payload: { items: [{ id: "a", text: "Read code", status: "running" }] },
          },
        },
      })
    })

    expect(result.current.messages).toHaveLength(2)
    expect(result.current.messages[0]?.toolCall).toBe("file_edit")
    expect(result.current.messages[0]?.blocks).toBeUndefined()
    expect(result.current.messages[1]?.blocks?.[0]?.id).toBe("plan")
  })

  it("drops live task-list blocks when a turn completes with text", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })

    act(() => {
      emit("session:delta", {
        sessionId: "s1",
        type: "block",
        content: "Plan running.",
        block: {
          op: "put",
          block: {
            id: "plan",
            type: "task-list",
            version: 1,
            title: "Plan",
            payload: { items: [{ id: "a", text: "Read code", status: "running" }] },
          },
        },
      })
    })

    await act(async () => {
      emit("session:completed", { sessionId: "s1", result: "Done." })
      await Promise.resolve()
    })

    expect(result.current.messages.map((m) => m.content)).toEqual(["Done."])
    expect(result.current.messages.some((m) => m.blocks?.some((block) => block.id === "plan"))).toBe(false)
  })

  it("marks the matching unfinished tool row done when a block arrives before tool_result", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })

    act(() => {
      emit("session:delta", { sessionId: "s1", type: "tool_use", toolName: "file_edit", toolId: "tool-1" })
      emit("session:delta", {
        sessionId: "s1",
        type: "block",
        content: "Plan",
        block: {
          op: "put",
          block: {
            id: "plan",
            type: "task-list",
            version: 1,
            title: "Plan",
            payload: { items: [{ id: "a", text: "Edit file", status: "running" }] },
          },
        },
      })
      emit("session:delta", { sessionId: "s1", type: "tool_result", toolName: "file_edit", toolId: "tool-1" })
    })

    expect(result.current.messages.find((m) => m.toolCall === "file_edit")?.content).toBe("Used file_edit")
    expect(result.current.messages.some((m) => m.blocks?.some((block) => block.id === "plan"))).toBe(true)
  })

  it("marks an earlier unfinished tool row done by toolId without closing a later tool", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })

    act(() => {
      emit("session:delta", { sessionId: "s1", type: "tool_use", toolName: "search", toolId: "tool-1" })
      emit("session:delta", { sessionId: "s1", type: "tool_use", toolName: "read", toolId: "tool-2" })
      emit("session:delta", { sessionId: "s1", type: "tool_result", toolId: "tool-1" })
    })

    expect(result.current.messages.find((m) => m.toolCall === "search")?.content).toBe("Used search")
    expect(result.current.messages.find((m) => m.toolCall === "read")?.content).toBe("Using read")
  })

  it("ignores obsolete block types from live deltas", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })

    act(() => {
      emit("session:delta", {
        sessionId: "s1",
        type: "block",
        content: "Diff",
        block: {
          op: "put",
          block: {
            id: "diff",
            type: "diff",
            version: 1,
            payload: { hunks: [{ before: "old", after: "new" }] },
          },
        },
      })
    })

    expect(result.current.messages).toEqual([])
  })

  it("appends a live media attachment", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })

    act(() => {
      emit("session:attachment", {
        sessionId: "s1",
        id: "att1",
        content: "chart",
        media: [{ type: "image", url: "https://x/y.png" }],
      })
    })
    const last = result.current.messages.at(-1)
    expect(last?.media?.[0]?.url).toBe("https://x/y.png")
    // Idempotent on a duplicate event (same id).
    act(() => {
      emit("session:attachment", {
        sessionId: "s1",
        id: "att1",
        content: "chart",
        media: [{ type: "image", url: "https://x/y.png" }],
      })
    })
    expect(result.current.messages.filter((m) => m.id === "att1").length).toBe(1)
  })

  it("ignores events for a different session", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })
    act(() => {
      emit("session:delta", { sessionId: "OTHER", type: "text", content: "nope" })
    })
    expect(result.current.streamingText).toBe("")
  })

  it("surfaces a load error instead of hanging (modal anti-hang)", async () => {
    getSession.mockRejectedValue(new Error("boom"))
    const { subscribe } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })
    expect(result.current.error).toBeInstanceOf(Error)
    expect(result.current.messages).toEqual([])
    expect(result.current.session).toBeNull()
  })
})

describe("useLiveSession (editable write path)", () => {
  it("hydrates from the in-memory session cache immediately while revalidating", async () => {
    getSession.mockResolvedValueOnce({
      status: "idle",
      messages: [{ id: "m1", role: "user", content: "cached question" }],
    })
    const { subscribe } = makeBus()
    const first = renderHook(() => useLiveSession("s-cache", { subscribe }))
    await act(async () => { await Promise.resolve() })
    expect(first.result.current.messages.map((m) => m.content)).toEqual(["cached question"])
    first.unmount()

    let resolveFresh!: (value: unknown) => void
    getSession.mockReturnValueOnce(new Promise((resolve) => { resolveFresh = resolve }))
    const second = renderHook(() => useLiveSession("s-cache", { subscribe }))

    expect(second.result.current.hydrating).toBe(false)
    expect(second.result.current.messages.map((m) => m.content)).toEqual(["cached question"])
    expect(getSession).toHaveBeenCalledTimes(2)

    await act(async () => {
      resolveFresh({
        status: "idle",
        messages: [{ id: "m2", role: "assistant", content: "fresh answer" }],
      })
      await Promise.resolve()
    })
    expect(second.result.current.messages.map((m) => m.content)).toEqual(["fresh answer"])
  })

  it("reports hydrating for an uncached session until the first fetch resolves", async () => {
    let resolveFresh!: (value: unknown) => void
    getSession.mockReturnValue(new Promise((resolve) => { resolveFresh = resolve }))
    const { subscribe } = makeBus()
    const { result } = renderHook(() => useLiveSession("s-cold", { subscribe }))

    expect(result.current.hydrating).toBe(true)

    await act(async () => {
      resolveFresh({ status: "idle", messages: [] })
      await Promise.resolve()
    })
    expect(result.current.hydrating).toBe(false)
  })

  it("keeps the pending user message visible while a newly-created session hydrates", async () => {
    let resolveFresh!: (value: unknown) => void
    getSession.mockReturnValue(new Promise((resolve) => { resolveFresh = resolve }))
    const { subscribe } = makeBus()
    const pendingUserMessage = {
      id: "u1",
      role: "user" as const,
      content: "start this task",
      timestamp: 1,
    }
    const { result } = renderHook(() =>
      useLiveSession("s-new", { subscribe, pendingUserMessage }),
    )

    expect(result.current.messages.map((m) => m.content)).toEqual(["start this task"])
    expect(result.current.loading).toBe(true)
    expect(result.current.hydrating).toBe(false)

    await act(async () => { await Promise.resolve() })

    expect(result.current.messages.map((m) => m.content)).toEqual(["start this task"])
    expect(result.current.loading).toBe(true)
    expect(result.current.hydrating).toBe(false)

    await act(async () => {
      resolveFresh({
        status: "running",
        messages: [{ id: "u1", role: "user", content: "start this task", timestamp: 1 }],
      })
      await Promise.resolve()
    })

    expect(result.current.messages.map((m) => m.content)).toEqual(["start this task"])
    expect(result.current.loading).toBe(true)
    expect(result.current.hydrating).toBe(false)
  })

  it("evicts old session cache entries so switching does not grow unbounded", () => {
    for (let i = 0; i < 25; i++) {
      __cacheLiveSessionSnapshotForTests(`s-${i}`, {
        messages: [{ id: `m-${i}`, role: "user", content: `message ${i}`, timestamp: i }],
        streamingText: "",
        loading: false,
        session: { id: `s-${i}`, status: "idle" },
        liveContextTokens: null,
        backgroundActivity: null,
      })
    }

    expect(__getLiveSessionSnapshotCacheSizeForTests()).toBeLessThanOrEqual(16)
  })

  it("replaces a cached in-flight snapshot with collapsed idle history after switching back", async () => {
    __cacheLiveSessionSnapshotForTests("s-stale", {
      messages: [
        { id: "u1", role: "user", content: "long task", timestamp: 1 },
        { id: "p1", role: "assistant", content: "Working through files", timestamp: 2 },
        { id: "t1", role: "assistant", content: "Using Bash", timestamp: 3, toolCall: "Bash" },
        { id: "p2", role: "assistant", content: "More progress", timestamp: 4 },
      ],
      streamingText: "partial final",
      loading: true,
      session: { id: "s-stale", status: "running" },
      liveContextTokens: 123,
      backgroundActivity: null,
    })
    getSession.mockResolvedValue({
      status: "idle",
      messages: [
        { id: "u1", role: "user", content: "long task", timestamp: 1 },
        { id: "a1", role: "assistant", content: "Final answer", timestamp: 5 },
      ],
    })
    const { subscribe } = makeBus()
    const { result } = renderHook(() => useLiveSession("s-stale", { subscribe }))

    expect(result.current.messages.map((m) => m.content)).toEqual([
      "long task",
      "Working through files",
      "Using Bash",
      "More progress",
    ])
    expect(result.current.streamingText).toBe("partial final")
    expect(result.current.loading).toBe(true)

    await act(async () => { await Promise.resolve() })

    expect(result.current.messages.map((m) => m.content)).toEqual(["long task", "Final answer"])
    expect(result.current.messages.some((m) => m.toolCall)).toBe(false)
    expect(result.current.streamingText).toBe("")
    expect(result.current.loading).toBe(false)
    expect(result.current.liveContextTokens).toBeNull()
  })

  it("seeds loading from a running session after reload or tab switch", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [{ id: "m1", role: "user", content: "hi" }] })
    const { subscribe } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await act(async () => { await Promise.resolve() })
    expect(result.current.loading).toBe(true)
  })

  it("sets loading true when a queued turn starts", async () => {
    getSession.mockResolvedValue({ status: "idle", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await act(async () => { await Promise.resolve() })
    expect(result.current.loading).toBe(false)

    act(() => {
      emit("session:started", { sessionId: "s1" })
    })
    expect(result.current.loading).toBe(true)
  })

  it("optimistic send → delta accumulation → completion replaces with result", async () => {
    getSession.mockResolvedValue({ status: "idle", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await act(async () => { await Promise.resolve() })

    act(() => {
      result.current.beginSend({
        id: "u1",
        role: "user",
        content: "do it",
        timestamp: 1,
      })
    })
    expect(result.current.messages.at(-1)?.content).toBe("do it")
    expect(result.current.loading).toBe(true)

    act(() => {
      emit("session:delta", { sessionId: "s1", type: "text", content: "work" })
      emit("session:delta", { sessionId: "s1", type: "text", content: "ing" })
    })
    expect(result.current.streamingText).toBe("working")

    await act(async () => {
      emit("session:completed", { sessionId: "s1", result: "Done." })
      await Promise.resolve()
    })
    expect(result.current.loading).toBe(false)
    expect(result.current.streamingText).toBe("")
    expect(result.current.messages.map((m) => m.content)).toEqual(["do it", "Done."])
  })

  it("does not remove an older identical assistant answer when a later turn completes", async () => {
    getSession.mockResolvedValue({
      status: "idle",
      messages: [
        { id: "u-old", role: "user", content: "old question", timestamp: 1 },
        { id: "a-old", role: "assistant", content: "Done.", timestamp: 2 },
      ],
    })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await act(async () => { await Promise.resolve() })

    act(() => {
      result.current.beginSend({
        id: "u-new",
        role: "user",
        content: "new question",
        timestamp: 3,
      })
    })

    await act(async () => {
      emit("session:completed", { sessionId: "s1", result: "Done." })
      await Promise.resolve()
    })

    expect(result.current.messages.map((m) => m.content)).toEqual([
      "old question",
      "Done.",
      "new question",
      "Done.",
    ])
  })

  it("seeds backgroundActivity from the session fetch and clears it on session switch", async () => {
    getSession.mockResolvedValue({
      status: "idle",
      messages: [],
      backgroundActivity: { activeStreams: 2, lastActivityAt: "2026-06-10T00:00:00Z" },
    })
    const { subscribe } = makeBus()
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useLiveSession(id, { subscribe }),
      { initialProps: { id: "s1" as string | null } },
    )
    await act(async () => { await Promise.resolve() })
    expect(result.current.backgroundActivity).toEqual({
      activeStreams: 2,
      lastActivityAt: "2026-06-10T00:00:00Z",
    })

    // Switching away must not leak the previous session's indicator.
    getSession.mockResolvedValue({ status: "idle", messages: [] })
    rerender({ id: "s2" })
    await act(async () => { await Promise.resolve() })
    expect(result.current.backgroundActivity).toBeNull()
  })

  it("updates backgroundActivity on session:background and clears on null", async () => {
    getSession.mockResolvedValue({ status: "idle", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await act(async () => { await Promise.resolve() })
    expect(result.current.backgroundActivity).toBeNull()

    act(() => {
      emit("session:background", {
        sessionId: "s1",
        backgroundActivity: { activeStreams: 3, lastActivityAt: "2026-06-10T01:00:00Z" },
      })
    })
    expect(result.current.backgroundActivity?.activeStreams).toBe(3)

    // The cleared case is an explicit event with backgroundActivity: null.
    act(() => {
      emit("session:background", { sessionId: "s1", backgroundActivity: null })
    })
    expect(result.current.backgroundActivity).toBeNull()
  })

  it("ignores session:background for a different session", async () => {
    getSession.mockResolvedValue({ status: "idle", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await act(async () => { await Promise.resolve() })

    act(() => {
      emit("session:background", {
        sessionId: "OTHER",
        backgroundActivity: { activeStreams: 9, lastActivityAt: "2026-06-10T01:00:00Z" },
      })
    })
    expect(result.current.backgroundActivity).toBeNull()
  })

  it("reconciles messages from the server on session:external-turn", async () => {
    getSession.mockResolvedValue({
      status: "idle",
      messages: [{ id: "m1", role: "user", content: "hi" }],
    })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await act(async () => { await Promise.resolve() })
    expect(result.current.messages.map((m) => m.content)).toEqual(["hi"])

    // The gateway persisted a CLI-typed turn — the event must trigger a refetch.
    getSession.mockResolvedValue({
      status: "idle",
      messages: [
        { id: "m1", role: "user", content: "hi" },
        { id: "m2", role: "user", content: "typed in CLI" },
        { id: "m3", role: "assistant", content: "answered in CLI" },
      ],
    })
    await act(async () => {
      emit("session:external-turn", { sessionId: "s1" })
      await Promise.resolve()
    })
    expect(getSession).toHaveBeenCalledTimes(2)
    expect(result.current.messages.map((m) => m.content)).toEqual([
      "hi",
      "typed in CLI",
      "answered in CLI",
    ])
  })

  it("ignores session:external-turn for a different session", async () => {
    getSession.mockResolvedValue({ status: "idle", messages: [] })
    const { subscribe, emit } = makeBus()
    renderHook(() => useLiveSession("s1", { subscribe }))
    await act(async () => { await Promise.resolve() })
    expect(getSession).toHaveBeenCalledTimes(1)

    await act(async () => {
      emit("session:external-turn", { sessionId: "OTHER" })
      await Promise.resolve()
    })
    expect(getSession).toHaveBeenCalledTimes(1)
  })

  it("failSend clears loading and appends the error bubble", async () => {
    getSession.mockResolvedValue({ status: "idle", messages: [] })
    const { subscribe } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await act(async () => { await Promise.resolve() })

    act(() => {
      result.current.beginSend({ id: "u1", role: "user", content: "x", timestamp: 1 })
    })
    expect(result.current.loading).toBe(true)

    act(() => { result.current.failSend("Error: nope") })
    expect(result.current.loading).toBe(false)
    expect(result.current.messages.at(-1)?.content).toBe("Error: nope")
  })
})
