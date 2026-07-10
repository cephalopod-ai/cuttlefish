import { describe, it, expect } from "vitest"
import { countAtRiskEngines, countBrokenCronJobs } from "./triage"
import type { EngineLimitsResponse, EngineLimitEngineSnapshot } from "@/lib/api"

function engine(overrides: Partial<EngineLimitEngineSnapshot> & { name: string }): EngineLimitEngineSnapshot {
  return {
    available: true,
    status: "live",
    source: "test",
    refreshedAt: "2026-07-10T00:00:00Z",
    models: [],
    ...overrides,
  }
}

describe("countAtRiskEngines", () => {
  it("returns 0 for undefined input", () => {
    expect(countAtRiskEngines(undefined)).toBe(0)
  })

  it("counts an engine at exactly the threshold as at risk", () => {
    const response: EngineLimitsResponse = {
      generatedAt: "2026-07-10T00:00:00Z",
      default: "claude",
      engines: {
        claude: engine({ name: "claude", windows: [{ name: "primary", usedPercent: 80 }] }),
      },
    }
    expect(countAtRiskEngines(response)).toBe(1)
  })

  it("does not count an engine below the threshold", () => {
    const response: EngineLimitsResponse = {
      generatedAt: "2026-07-10T00:00:00Z",
      default: "claude",
      engines: {
        claude: engine({ name: "claude", windows: [{ name: "primary", usedPercent: 79 }] }),
      },
    }
    expect(countAtRiskEngines(response)).toBe(0)
  })

  it("counts an engine at risk via any one of its windows", () => {
    const response: EngineLimitsResponse = {
      generatedAt: "2026-07-10T00:00:00Z",
      default: "claude",
      engines: {
        claude: engine({
          name: "claude",
          windows: [{ name: "primary", usedPercent: 10 }, { name: "secondary", usedPercent: 95 }],
        }),
      },
    }
    expect(countAtRiskEngines(response)).toBe(1)
  })

  it("ignores engines with no windows", () => {
    const response: EngineLimitsResponse = {
      generatedAt: "2026-07-10T00:00:00Z",
      default: "claude",
      engines: { claude: engine({ name: "claude" }) },
    }
    expect(countAtRiskEngines(response)).toBe(0)
  })

  it("sums across multiple at-risk engines", () => {
    const response: EngineLimitsResponse = {
      generatedAt: "2026-07-10T00:00:00Z",
      default: "claude",
      engines: {
        claude: engine({ name: "claude", windows: [{ name: "p", usedPercent: 90 }] }),
        codex: engine({ name: "codex", windows: [{ name: "p", usedPercent: 20 }] }),
        grok: engine({ name: "grok", windows: [{ name: "p", usedPercent: 85 }] }),
      },
    }
    expect(countAtRiskEngines(response)).toBe(2)
  })
})

describe("countBrokenCronJobs", () => {
  it("returns 0 for undefined input", () => {
    expect(countBrokenCronJobs(undefined)).toBe(0)
  })

  it("counts only jobs with scheduleValid === false", () => {
    const jobs = [{ scheduleValid: false }, { scheduleValid: true }, {}]
    expect(countBrokenCronJobs(jobs)).toBe(1)
  })
})
