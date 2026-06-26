/**
 * Cuttlefish Talk — orchestrator engine resolution with seamless fallback.
 *
 * The /talk voice orchestrator must NOT hardcode `engine:"claude"`: the operator
 * may run Codex/Antigravity/Pi instead, or have Claude uninstalled. This module
 * is the single, PURE place that decides which engine the talk session should use.
 *
 * Resolution order (first match wins):
 *   (a) config.talk.engine — the explicit talk override — IF set AND available.
 *   (b) config.engines.default — IF available.
 *   (c) the first available engine among `candidates` (in the given order).
 *   (d) NONE available → a clear sentinel ({ engine: null, reason: "none" }) so the
 *       caller can surface an actionable "no engine installed" message rather than
 *       letting a session spawn fail with a raw `engine "claude" not available`.
 *
 * It is intentionally pure: availability is injected via `isAvailable` (in
 * production this wraps resolve-bin's isInstalled), so the resolver imports
 * cleanly and is testable without spawning or probing real binaries.
 */

export type TalkEngineReason = "configured" | "default" | "first-available" | "none";

export interface TalkEngineResolution {
  /** The chosen engine, or `null` when nothing is installed. */
  engine: string | null;
  /** True when the top preference (configured, else default) was unavailable and
   *  we fell back to a lower-priority engine. Always false for the `none` case. */
  fallback: boolean;
  /** Which rule produced the choice — useful for logging/surfacing to the UI. */
  reason: TalkEngineReason;
  /** Every candidate that is currently available (order preserved). */
  available: string[];
}

export interface ResolveTalkEngineInput {
  /** config.talk.engine — the explicit talk override (may be undefined/empty). */
  configured?: string;
  /** config.engines.default — always present in a valid config. */
  defaultEngine: string;
  /** Engines to consider, in priority order (e.g. the known/configured engines). */
  candidates: readonly string[];
  /** Whether an engine's binary is installed/resolvable. Injected for testability. */
  isAvailable: (engine: string) => boolean;
}

export function resolveTalkEngine(input: ResolveTalkEngineInput): TalkEngineResolution {
  const { configured, defaultEngine, candidates, isAvailable } = input;
  const available = candidates.filter((e) => isAvailable(e));

  // (a) explicit talk override, if set and available.
  if (configured && configured.trim() && isAvailable(configured)) {
    return { engine: configured, fallback: false, reason: "configured", available };
  }

  // (b) gateway default, if available.
  if (isAvailable(defaultEngine)) {
    // A fallback only "occurred" if there was a (different) configured preference
    // that we couldn't honor.
    const fellBack = Boolean(configured && configured.trim() && configured !== defaultEngine);
    return { engine: defaultEngine, fallback: fellBack, reason: "default", available };
  }

  // (c) first available candidate.
  if (available.length > 0) {
    return { engine: available[0], fallback: true, reason: "first-available", available };
  }

  // (d) nothing installed — actionable sentinel.
  return { engine: null, fallback: false, reason: "none", available };
}
