import { describe, it, expect } from "vitest";
import { resolveTalkEngine } from "../engine-resolver.js";

/** Build an availability predicate from a set of "installed" engine names. */
function availableSet(...installed: string[]): (engine: string) => boolean {
  const set = new Set(installed);
  return (engine: string) => set.has(engine);
}

const CANDIDATES = ["claude", "codex", "antigravity", "grok", "pi"] as const;

describe("resolveTalkEngine", () => {
  it("uses config.talk.engine when set AND available (no fallback)", () => {
    const r = resolveTalkEngine({
      configured: "codex",
      defaultEngine: "claude",
      candidates: CANDIDATES,
      isAvailable: availableSet("claude", "codex"),
    });
    expect(r.engine).toBe("codex");
    expect(r.fallback).toBe(false);
    expect(r.reason).toBe("configured");
    expect(r.available).toEqual(["claude", "codex"]);
  });

  it("falls back to config.engines.default when the configured engine is unavailable", () => {
    const r = resolveTalkEngine({
      configured: "antigravity",
      defaultEngine: "claude",
      candidates: CANDIDATES,
      isAvailable: availableSet("claude", "codex"),
    });
    expect(r.engine).toBe("claude");
    expect(r.fallback).toBe(true);
    expect(r.reason).toBe("default");
  });

  it("uses config.engines.default when nothing is configured (no fallback)", () => {
    const r = resolveTalkEngine({
      defaultEngine: "claude",
      candidates: CANDIDATES,
      isAvailable: availableSet("claude"),
    });
    expect(r.engine).toBe("claude");
    expect(r.fallback).toBe(false);
    expect(r.reason).toBe("default");
  });

  it("falls back to the first available candidate when the default is unavailable", () => {
    const r = resolveTalkEngine({
      defaultEngine: "claude",
      candidates: CANDIDATES,
      isAvailable: availableSet("antigravity", "codex"),
    });
    // candidate order is honored → codex comes before antigravity in CANDIDATES
    expect(r.engine).toBe("codex");
    expect(r.fallback).toBe(true);
    expect(r.reason).toBe("first-available");
    expect(r.available).toEqual(["codex", "antigravity"]);
  });

  it("falls back to first available when BOTH configured and default are unavailable", () => {
    const r = resolveTalkEngine({
      configured: "pi",
      defaultEngine: "claude",
      candidates: CANDIDATES,
      isAvailable: availableSet("antigravity"),
    });
    expect(r.engine).toBe("antigravity");
    expect(r.fallback).toBe(true);
    expect(r.reason).toBe("first-available");
  });

  it("returns a clear sentinel (engine:null) when NO engine is available", () => {
    const r = resolveTalkEngine({
      configured: "claude",
      defaultEngine: "claude",
      candidates: CANDIDATES,
      isAvailable: availableSet(), // nothing installed
    });
    expect(r.engine).toBeNull();
    expect(r.reason).toBe("none");
    expect(r.available).toEqual([]);
    expect(r.fallback).toBe(false);
  });
});
