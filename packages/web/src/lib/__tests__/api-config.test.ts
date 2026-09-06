import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const authFetch = vi.fn()

vi.mock("@/lib/auth", () => ({ authFetch: (...args: unknown[]) => authFetch(...args) }))

const {
  CONFIG_REVISION_HEADER,
  ConfigConflictError,
  getConfigDocument,
  putConfigDocument,
} = await import("../api-config")

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  })
}

beforeEach(() => {
  authFetch.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("getConfigDocument", () => {
  it("returns the config and the revision it was read at", async () => {
    authFetch.mockResolvedValue(jsonResponse({ logging: { level: "info" } }, { headers: { [CONFIG_REVISION_HEADER]: "abc123" } }))

    const doc = await getConfigDocument()
    expect(doc.config).toEqual({ logging: { level: "info" } })
    expect(doc.revision).toBe("abc123")
  })

  it("tolerates a gateway that sends no revision header", async () => {
    authFetch.mockResolvedValue(jsonResponse({}))
    const doc = await getConfigDocument()
    expect(doc.revision).toBeUndefined()
  })

  it("surfaces a read failure as an error", async () => {
    authFetch.mockResolvedValue(jsonResponse({ error: "nope" }, { status: 500 }))
    await expect(getConfigDocument()).rejects.toThrow("nope")
  })
})

describe("putConfigDocument", () => {
  it("sends the revision it was given and returns the one the write produced", async () => {
    authFetch.mockResolvedValue(jsonResponse({ status: "ok", revision: "next" }))

    const result = await putConfigDocument({ logging: { level: "debug" } }, "prev")
    expect(result.revision).toBe("next")

    const [, init] = authFetch.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>)[CONFIG_REVISION_HEADER]).toBe("prev")
  })

  it("omits the header entirely when no revision is held (partial-write opt-out)", async () => {
    authFetch.mockResolvedValue(jsonResponse({ status: "ok" }))

    await putConfigDocument({ logging: { level: "debug" } })
    const [, init] = authFetch.mock.calls[0] as [string, RequestInit]
    expect(Object.keys(init.headers as Record<string, string>)).not.toContain(CONFIG_REVISION_HEADER)
  })

  it("raises a typed conflict carrying the revision to adopt, and fires no retry", async () => {
    authFetch.mockResolvedValue(
      jsonResponse({ error: "config.yaml changed", code: "CONFIG_CONFLICT", revision: "current" }, { status: 409 }),
    )

    await expect(putConfigDocument({}, "stale")).rejects.toBeInstanceOf(ConfigConflictError)
    expect(authFetch).toHaveBeenCalledTimes(1)

    authFetch.mockResolvedValue(
      jsonResponse({ error: "config.yaml changed", code: "CONFIG_CONFLICT", revision: "current" }, { status: 409 }),
    )
    await putConfigDocument({}, "stale").catch((err: unknown) => {
      expect(err).toBeInstanceOf(ConfigConflictError)
      expect((err as InstanceType<typeof ConfigConflictError>).revision).toBe("current")
    })
  })

  it("falls back to the response header when a 409 body carries no revision", async () => {
    authFetch.mockResolvedValue(new Response("not json", { status: 409, headers: { [CONFIG_REVISION_HEADER]: "from-header" } }))

    await putConfigDocument({}, "stale").catch((err: unknown) => {
      expect((err as InstanceType<typeof ConfigConflictError>).revision).toBe("from-header")
    })
  })

  it("keeps an ordinary failure an ordinary error, not a conflict", async () => {
    authFetch.mockResolvedValue(jsonResponse({ error: "Invalid config" }, { status: 400 }))

    await expect(putConfigDocument({}, "rev")).rejects.toThrow("Invalid config")
    await putConfigDocument({}, "rev").catch((err: unknown) => {
      expect(err).not.toBeInstanceOf(ConfigConflictError)
    })
  })
})
