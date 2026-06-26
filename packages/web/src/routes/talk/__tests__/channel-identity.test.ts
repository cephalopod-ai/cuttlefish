/**
 * Cuttlefish Talk — channel identity tests.
 *
 * The hue mapping must be deterministic (same COO → same colour every session),
 * stay out of AURA's amber band, and spread distinct COOs across the wheel.
 */
import { describe, it, expect } from "vitest"
import { channelHue, channelIdentity } from "../channel-identity"

const KEYS = ["content-lead", "demo-lead", "studio-lead", "acme-lead", "ventures-lead"]

describe("channel-identity", () => {
  it("is deterministic for a given key", () => {
    for (const k of KEYS) {
      expect(channelHue(k)).toBe(channelHue(k))
    }
    expect(channelIdentity("content-lead").hue).toBe(channelIdentity("content-lead").hue)
  })

  it("keeps every hue in the non-amber arc [90, 350)", () => {
    for (const k of [...KEYS, "a", "", "Z9-x", "a-very-long-channel-label-here"]) {
      const h = channelHue(k)
      expect(h).toBeGreaterThanOrEqual(90)
      expect(h).toBeLessThan(350)
      // Explicitly outside AURA's amber band (~25–70°).
      expect(h < 25 || h > 70).toBe(true)
    }
  })

  it("gives different keys (mostly) different hues", () => {
    const hues = KEYS.map(channelHue)
    const unique = new Set(hues)
    // No catastrophic collapse — at least most of the known COOs are distinct.
    expect(unique.size).toBeGreaterThanOrEqual(KEYS.length - 1)
  })

  it("distinguishes keys that differ by one character", () => {
    expect(channelHue("coo-a")).not.toBe(channelHue("coo-b"))
  })
})
