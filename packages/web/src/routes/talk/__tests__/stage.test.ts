import { afterEach, describe, expect, it, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"
import {
  deriveStage,
  heroOrbSize,
  shouldDelayStageChange,
  useStageMode,
  DOCKED_ORB_SIZE,
} from "../stage"
import type { StageInput } from "../stage"

describe("deriveStage", () => {
  it("is hero when idle with no rows and no pinned cards", () => {
    expect(deriveStage({ state: "idle", hasRows: false, pinnedCount: 0 })).toBe("hero")
  })
  it("is hero while listening with no rows", () => {
    expect(deriveStage({ state: "listening", hasRows: false, pinnedCount: 0 })).toBe("hero")
  })
  it("is conversing on the FIRST thinking beat even with zero rows", () => {
    expect(deriveStage({ state: "thinking", hasRows: false, pinnedCount: 0 })).toBe("conversing")
  })
  it("is conversing while speaking", () => {
    expect(deriveStage({ state: "speaking", hasRows: false, pinnedCount: 0 })).toBe("conversing")
  })
  it("is conversing when rows exist even at idle", () => {
    expect(deriveStage({ state: "idle", hasRows: true, pinnedCount: 0 })).toBe("conversing")
  })
  it("is content whenever an unresolved pinned card exists (outranks everything)", () => {
    expect(deriveStage({ state: "idle", hasRows: false, pinnedCount: 1 })).toBe("content")
    expect(deriveStage({ state: "speaking", hasRows: true, pinnedCount: 2 })).toBe("content")
  })
})

describe("shouldDelayStageChange", () => {
  it("delays only downgrades to hero (anti-churn)", () => {
    expect(shouldDelayStageChange("conversing", "hero")).toBe(true)
    expect(shouldDelayStageChange("content", "hero")).toBe(true)
  })
  it("applies every other transition immediately", () => {
    expect(shouldDelayStageChange("hero", "conversing")).toBe(false)
    expect(shouldDelayStageChange("conversing", "content")).toBe(false)
    expect(shouldDelayStageChange("content", "conversing")).toBe(false)
    expect(shouldDelayStageChange("hero", "hero")).toBe(false)
  })
})

describe("orb sizing", () => {
  it("docked size is 56", () => {
    expect(DOCKED_ORB_SIZE).toBe(56)
  })
  it("hero size is half the stage's min dimension, clamped to [140, 300]", () => {
    expect(heroOrbSize(800, 600)).toBe(300)
    expect(heroOrbSize(400, 500)).toBe(200)
    expect(heroOrbSize(200, 180)).toBe(140)
  })
  it("tolerates a zero/unmeasured rect", () => {
    expect(heroOrbSize(0, 0)).toBe(140)
  })
})

describe("useStageMode", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("immediate upgrade: idle → thinking yields conversing without advancing timers", () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(
      (props: StageInput) => useStageMode(props),
      { initialProps: { state: "idle", hasRows: false, pinnedCount: 0 } as StageInput },
    )
    expect(result.current).toBe("hero")
    rerender({ state: "thinking", hasRows: false, pinnedCount: 0 })
    expect(result.current).toBe("conversing")
  })

  it("downgrade hold: remains conversing while timer is pending; resolves to hero after 600ms", () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(
      (props: StageInput) => useStageMode(props),
      { initialProps: { state: "speaking", hasRows: false, pinnedCount: 0 } as StageInput },
    )
    expect(result.current).toBe("conversing")
    rerender({ state: "idle", hasRows: false, pinnedCount: 0 })
    expect(result.current).toBe("conversing")
    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(result.current).toBe("hero")
  })

  it("flicker cancel: re-upgrading before hold expires keeps conversing even after 600ms", () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(
      (props: StageInput) => useStageMode(props),
      { initialProps: { state: "speaking", hasRows: false, pinnedCount: 0 } as StageInput },
    )
    expect(result.current).toBe("conversing")
    rerender({ state: "idle", hasRows: false, pinnedCount: 0 })
    expect(result.current).toBe("conversing")
    rerender({ state: "speaking", hasRows: false, pinnedCount: 0 })
    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(result.current).toBe("conversing")
  })
})
