import { beforeEach, describe, expect, it, vi } from "vitest"
import { api } from "../api"

const authFetch = vi.fn()
vi.mock("@/lib/auth", () => ({ authFetch: (...args: unknown[]) => authFetch(...args) }))

const board = { tickets: [] }
const calls = [
  { name: "board read", method: "GET", suffix: "/board", body: undefined, run: (department: string, _ticketId: string) => api.getDepartmentBoard(department) },
  { name: "board save", method: "PUT", suffix: "/board", body: board, run: (department: string, _ticketId: string) => api.updateDepartmentBoard(department, board) },
  { name: "dispatch", method: "POST", suffix: "/dispatch", body: {}, run: (department: string, ticketId: string) => api.dispatchTicket(department, ticketId) },
  { name: "escalation", method: "POST", suffix: "/dispatch", body: { routeToManager: true }, run: (department: string, ticketId: string) => api.escalateToLead(department, ticketId) },
  { name: "ticket session", method: "GET", suffix: "/session", body: undefined, run: (department: string, ticketId: string) => api.getTicketSession(department, ticketId) },
]

beforeEach(() => {
  authFetch.mockReset()
  authFetch.mockResolvedValue(new Response(JSON.stringify({ status: "ok" }), { status: 200 }))
})

describe.each(calls)("department API $name", ({ method, suffix, body, run }) => {
  it.each(["software-delivery", "Research #1", "Research?phase=1", "100% ready", "設計"])("round-trips department %s and the ticket identifier", async (department) => {
    const ticketId = "ticket #1?25%"

    await expect(run(department, ticketId)).resolves.toEqual({ status: "ok" })

    expect(authFetch).toHaveBeenCalledTimes(1)
    const [requested, init] = authFetch.mock.calls[0] as [string, RequestInit | undefined]
    const url = new URL(requested, "http://localhost")
    const segments = url.pathname.split("/").map(decodeURIComponent)
    expect(url.hash).toBe("")
    expect(url.search).toBe("")
    expect(segments.slice(0, 5)).toEqual(["", "api", "org", "departments", department])
    expect(url.pathname.endsWith(suffix)).toBe(true)
    if (suffix !== "/board") expect(segments.slice(5, 7)).toEqual(["tickets", ticketId])
    expect(init?.method ?? "GET").toBe(method)
    expect(init?.body).toBe(body === undefined ? undefined : JSON.stringify(body))
  })
})
