/**
 * Cuttlefish Talk — per-channel visual identity (pure, testable).
 *
 * Every COO child the orchestrator patches to is a "channel". Each channel gets
 * a stable colour signature derived deterministically from a key (the child's
 * label when known — e.g. "content-lead" — else its session id), so the same COO
 * always wears the same hue: the main orb borrows it while patched, and the
 * satellite orb is painted with it.
 *
 * Only a HUE is derived (0..360). It is mapped into a non-amber arc so every
 * channel reads as clearly distinct from AURA's own neutral amber identity.
 * No colour-space math here — the avatar turns the hue into pixels; this module
 * is just the deterministic key → hue mapping, kept pure so it can be tested.
 */

export interface ChannelIdentity {
  /** Channel hue in degrees, 0..360. */
  hue: number
}

/** AURA's amber sits ~30–60°; channels live outside this band so they stand apart. */
const ARC_START = 90 // greens begin here
const ARC_SPAN = 260 // …through cyan, blue, violet, magenta (ends ~350°)

/** Stable unsigned 32-bit djb2 hash — deterministic across runs/devices. */
function hashString(str: string): number {
  let h = 5381
  for (let i = 0; i < str.length; i++) {
    h = (((h << 5) + h) + str.charCodeAt(i)) >>> 0
  }
  return h >>> 0
}

/** Deterministic channel hue (degrees) for a key, in the non-amber arc. */
export function channelHue(key: string): number {
  return ARC_START + (hashString(key) % ARC_SPAN)
}

/** Full visual identity for a channel key. */
export function channelIdentity(key: string): ChannelIdentity {
  return { hue: channelHue(key) }
}
