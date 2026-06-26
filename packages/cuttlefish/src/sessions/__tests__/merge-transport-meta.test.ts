import { describe, it, expect, vi } from "vitest";

/**
 * Regression test for mergeTransportMeta() in ../manager.ts.
 *
 * The rate-limit onRetrySuccess path used to write `transportMeta:
 * msg.transportMeta ?? null` — a raw overwrite that destroyed internal
 * bookkeeping (engineSessions, engineOverride), so a session that fell back to
 * another engine during a rate limit could never revert. Every update path now
 * goes through mergeTransportMeta; this locks in its semantics.
 */

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { mergeTransportMeta } from "../manager.js";

describe("mergeTransportMeta", () => {
  it("keeps existing meta when incoming is undefined (no wipe)", () => {
    const existing = { channelName: "general", engineSessions: { claude: "c-1" } } as any;
    expect(mergeTransportMeta(existing, undefined)).toEqual(existing);
  });

  it("merges incoming transport keys over existing ones", () => {
    const merged = mergeTransportMeta(
      { channelName: "old", threadTs: "1" } as any,
      { channelName: "new" } as any,
    ) as Record<string, unknown>;
    expect(merged.channelName).toBe("new");
    expect(merged.threadTs).toBe("1");
  });

  it("preserves internal bookkeeping keys against incoming overwrites", () => {
    const existing = {
      engineOverride: { originalEngine: "claude", until: "2099-01-01T00:00:00Z" },
      engineSessions: { claude: "c-1", codex: "x-1" },
      claudeSyncSince: "2026-06-10T00:00:00Z",
    } as any;
    const incoming = {
      engineOverride: null,
      engineSessions: {},
      claudeSyncSince: "stomped",
      channelName: "general",
    } as any;

    const merged = mergeTransportMeta(existing, incoming) as Record<string, unknown>;
    expect(merged.engineOverride).toEqual(existing.engineOverride);
    expect(merged.engineSessions).toEqual(existing.engineSessions);
    expect(merged.claudeSyncSince).toBe("2026-06-10T00:00:00Z");
    expect(merged.channelName).toBe("general");
  });

  it("handles both sides empty", () => {
    expect(mergeTransportMeta(null, undefined)).toEqual({});
  });
});
