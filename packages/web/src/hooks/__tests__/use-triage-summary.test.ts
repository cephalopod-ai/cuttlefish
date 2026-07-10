import { describe, it, expect, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { useTriageSummary } from "../use-triage-summary"

const approvalsMock = vi.fn()
const commandCenterMock = vi.fn()
const cronJobsMock = vi.fn()
const engineLimitsMock = vi.fn()

vi.mock("../use-approvals", () => ({ useApprovals: () => approvalsMock() }))
vi.mock("../use-command-center", () => ({ useCommandCenter: () => commandCenterMock() }))
vi.mock("../use-cron", () => ({ useCronJobs: () => cronJobsMock() }))
vi.mock("../use-engine-limits", () => ({ useEngineLimits: () => engineLimitsMock() }))

function setAll(overrides: {
  approvals?: unknown[]
  blocked?: number
  cronJobs?: { scheduleValid?: boolean }[]
  limits?: { engines: Record<string, { windows?: { usedPercent?: number }[] }> }
  loading?: boolean
}) {
  const loading = overrides.loading ?? false
  approvalsMock.mockReturnValue({ data: overrides.approvals ?? [], isLoading: loading })
  commandCenterMock.mockReturnValue({
    data: { ticketCounts: { blocked: overrides.blocked ?? 0 } },
    isLoading: loading,
  })
  cronJobsMock.mockReturnValue({ data: overrides.cronJobs ?? [], isLoading: loading })
  engineLimitsMock.mockReturnValue({
    data: overrides.limits ?? { generatedAt: "", default: "", engines: {} },
    isLoading: loading,
  })
}

describe("useTriageSummary", () => {
  it("is all zero when nothing needs attention", () => {
    setAll({})
    const { result } = renderHook(() => useTriageSummary())
    expect(result.current).toMatchObject({
      pendingApprovals: 0,
      blockedTickets: 0,
      brokenCronJobs: 0,
      atRiskLimits: 0,
      total: 0,
    })
  })

  it("sums every source into total", () => {
    setAll({
      approvals: [{ id: "a1" }, { id: "a2" }],
      blocked: 3,
      cronJobs: [{ scheduleValid: false }],
      limits: { engines: { claude: { windows: [{ usedPercent: 90 }] } } },
    })
    const { result } = renderHook(() => useTriageSummary())
    expect(result.current).toMatchObject({
      pendingApprovals: 2,
      blockedTickets: 3,
      brokenCronJobs: 1,
      atRiskLimits: 1,
      total: 7,
    })
  })

  it("reports isLoading true while any source is still loading", () => {
    setAll({ loading: true })
    const { result } = renderHook(() => useTriageSummary())
    expect(result.current.isLoading).toBe(true)
  })
})
