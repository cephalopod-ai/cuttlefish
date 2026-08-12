import { beforeEach, describe, expect, it, vi } from "vitest"
import { authFetch, bootstrapLocalAuth, createPairingCode, getAuthState, hasBrowserBootstrapCapability, listPairedDevices, logoutBrowser, pairBrowser, unpairDevice } from "../auth"

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

describe("web auth helpers", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
    localStorage.clear()
    window.history.replaceState({}, "", "/#bootstrap=test-launch-token")
  })

  it("uses cookies and silently bootstraps local auth once before retrying", async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: "Unauthorized" }))
      .mockResolvedValueOnce(jsonResponse(200, {
        authRequired: true,
        authenticated: false,
        canBootstrapLocal: true,
        networkExposed: false,
      }))
      .mockResolvedValueOnce(jsonResponse(200, { status: "ok" }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }))

    const res = await authFetch("/api/sessions")

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([
      "http://localhost:3000/api/sessions",
      "http://localhost:3000/api/auth/state",
      "http://localhost:3000/api/auth/bootstrap",
      "http://localhost:3000/api/sessions",
    ])
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit | undefined)?.credentials).toBe("include")
    }
    expect(fetchMock.mock.calls[2][1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ token: "test-launch-token" }),
    })
    expect(window.location.hash).toBe("")
    expect(localStorage.length).toBe(0)
  })

  it("bootstraps operator auth for a protected local action", async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: "Missing or invalid gateway auth token" }))
      .mockResolvedValueOnce(jsonResponse(200, {
        authRequired: false,
        authenticated: false,
        canBootstrapLocal: true,
        networkExposed: false,
      }))
      .mockResolvedValueOnce(jsonResponse(200, { status: "ok" }))
      .mockResolvedValueOnce(jsonResponse(200, { approval: { state: "rejected" } }))

    const res = await authFetch("/api/approvals/approval-1/reject", { method: "POST" })

    expect(res.status).toBe(200)
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([
      "http://localhost:3000/api/approvals/approval-1/reject",
      "http://localhost:3000/api/auth/state",
      "http://localhost:3000/api/auth/bootstrap",
      "http://localhost:3000/api/approvals/approval-1/reject",
    ])
  })

  it("does not retry remote auth failures without local bootstrap", async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: "Unauthorized" }))
      .mockResolvedValueOnce(jsonResponse(200, {
        authRequired: true,
        authenticated: false,
        canBootstrapLocal: false,
        networkExposed: true,
      }))

    const res = await authFetch("/api/logs")

    expect(res.status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("serializes concurrent bootstrap attempts and consumes a rejected capability", async () => {
    const fetchMock = vi.mocked(fetch)
    let resolveRequest: ((response: Response) => void) | undefined
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      resolveRequest = resolve
    }))

    const first = bootstrapLocalAuth()
    const second = bootstrapLocalAuth()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(hasBrowserBootstrapCapability()).toBe(true)

    resolveRequest?.(jsonResponse(401, { error: "Launch capability expired" }))
    await expect(first).rejects.toThrow("Launch capability expired")
    await expect(second).rejects.toThrow("Launch capability expired")
    expect(hasBrowserBootstrapCapability()).toBe(false)
    await expect(bootstrapLocalAuth()).rejects.toThrow(/pair this browser/i)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("wraps auth state, pairing, pairing-code creation, device list, unpair, and logout endpoints", async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { authRequired: true, authenticated: true }))
      .mockResolvedValueOnce(jsonResponse(200, { status: "ok" }))
      .mockResolvedValueOnce(jsonResponse(200, { code: "ABCD-EFGH-JKLM", expiresAt: "2026-06-24T10:00:00.000Z" }))
      .mockResolvedValueOnce(jsonResponse(200, { devices: [{ id: "device-1", name: "This Mac", current: true }] }))
      .mockResolvedValueOnce(jsonResponse(200, { status: "ok", current: false }))
      .mockResolvedValueOnce(jsonResponse(200, { status: "ok" }))

    await expect(getAuthState()).resolves.toMatchObject({ authenticated: true })
    await expect(pairBrowser("ABCD-EFGH-JKLM")).resolves.toBeUndefined()
    await expect(createPairingCode()).resolves.toMatchObject({ code: "ABCD-EFGH-JKLM" })
    await expect(listPairedDevices()).resolves.toEqual([{ id: "device-1", name: "This Mac", current: true }])
    await expect(unpairDevice("device-1")).resolves.toBeUndefined()
    await expect(logoutBrowser()).resolves.toBeUndefined()

    expect(fetchMock.mock.calls.map((c) => [String(c[0]), (c[1] as RequestInit | undefined)?.method])).toEqual([
      ["http://localhost:3000/api/auth/state", "GET"],
      ["http://localhost:3000/api/auth/pair", "POST"],
      ["http://localhost:3000/api/auth/pairing-codes", "POST"],
      ["http://localhost:3000/api/auth/devices", "GET"],
      ["http://localhost:3000/api/auth/devices/device-1", "DELETE"],
      ["http://localhost:3000/api/auth/logout", "POST"],
    ])
  })
})
