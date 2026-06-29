import { describe, it, expect } from "vitest"
import { parseLogLine } from "../log-browser"

describe("parseLogLine", () => {
  it("parses the gateway ISO format (with fractional seconds + Z)", () => {
    // shared/logger.ts writes `${new Date().toISOString()} [LEVEL] message`.
    const entry = parseLogLine("2026-06-29T22:04:13.123Z [WARN] headroom filter failed closed", 0)
    expect(entry.timestamp).toBe("2026-06-29T22:04:13")
    expect(entry.level).toBe("warn")
    expect(entry.message).toBe("headroom filter failed closed")
  })

  it("parses ISO without fractional seconds and maps ERROR -> error", () => {
    const entry = parseLogLine("2026-06-29T22:04:13Z [ERROR] boom", 1)
    expect(entry.timestamp).toBe("2026-06-29T22:04:13")
    expect(entry.level).toBe("error")
    expect(entry.message).toBe("boom")
  })

  it("still parses the plain space-separated format", () => {
    const entry = parseLogLine("2026-03-07 12:00:00 [INFO] hello world", 2)
    expect(entry.timestamp).toBe("2026-03-07 12:00:00")
    expect(entry.level).toBe("info")
    expect(entry.message).toBe("hello world")
  })

  it("falls back to an info entry for unrecognized lines", () => {
    const entry = parseLogLine("a plain line with no prefix", 3)
    expect(entry.timestamp).toBe("")
    expect(entry.level).toBe("info")
    expect(entry.message).toBe("a plain line with no prefix")
  })
})
