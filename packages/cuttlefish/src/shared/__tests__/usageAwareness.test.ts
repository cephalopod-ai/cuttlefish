import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

// vi.mock factory is hoisted — cannot reference local variables.
// Use a fixed path that the mock can resolve at hoist time.
vi.mock("../paths.js", () => ({
  CUTTLEFISH_HOME: path.join(import.meta.dirname || __dirname, ".tmp-usage-test"),
}));

import {
  isLikelyNearClaudeUsageLimit,
  recordClaudeRateLimit,
} from "../usageAwareness.js";

const TEMP_DIR = path.join(import.meta.dirname || __dirname, ".tmp-usage-test");
const STATE_PATH = path.join(TEMP_DIR, "tmp", "claude-usage.json");

beforeEach(() => {
  fs.mkdirSync(path.join(TEMP_DIR, "tmp"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
});

describe("isLikelyNearClaudeUsageLimit", () => {
  it("returns false when no state file exists", () => {
    expect(isLikelyNearClaudeUsageLimit()).toBe(false);
  });

  it("returns true when rate limit was hit recently (within 6h)", () => {
    const recentHit = new Date(Date.now() - 30 * 60_000).toISOString(); // 30 min ago
    fs.writeFileSync(STATE_PATH, JSON.stringify({ lastRateLimitAt: recentHit }));
    expect(isLikelyNearClaudeUsageLimit()).toBe(true);
  });

  it("returns false when rate limit was hit more than 6h ago", () => {
    const oldHit = new Date(Date.now() - 7 * 60 * 60_000).toISOString(); // 7h ago
    fs.writeFileSync(STATE_PATH, JSON.stringify({ lastRateLimitAt: oldHit }));
    expect(isLikelyNearClaudeUsageLimit()).toBe(false);
  });

  it("returns false when lastResetsAt has passed, even if lastRateLimitAt is recent", () => {
    const recentHit = new Date(Date.now() - 30 * 60_000).toISOString(); // 30 min ago
    const pastReset = new Date(Date.now() - 10 * 60_000).toISOString(); // 10 min ago
    fs.writeFileSync(
      STATE_PATH,
      JSON.stringify({ lastRateLimitAt: recentHit, lastResetsAt: pastReset }),
    );
    expect(isLikelyNearClaudeUsageLimit()).toBe(false);
  });

  it("returns true when lastResetsAt is in the future", () => {
    const recentHit = new Date(Date.now() - 30 * 60_000).toISOString(); // 30 min ago
    const futureReset = new Date(Date.now() + 60 * 60_000).toISOString(); // 1h from now
    fs.writeFileSync(
      STATE_PATH,
      JSON.stringify({ lastRateLimitAt: recentHit, lastResetsAt: futureReset }),
    );
    expect(isLikelyNearClaudeUsageLimit()).toBe(true);
  });

  it("ignores invalid lastResetsAt and falls back to 6h heuristic", () => {
    const recentHit = new Date(Date.now() - 30 * 60_000).toISOString();
    fs.writeFileSync(
      STATE_PATH,
      JSON.stringify({ lastRateLimitAt: recentHit, lastResetsAt: "not-a-date" }),
    );
    expect(isLikelyNearClaudeUsageLimit()).toBe(true);
  });

  it("works end-to-end with recordClaudeRateLimit", () => {
    const futureResetSeconds = (Date.now() + 2 * 60 * 60_000) / 1000; // 2h from now
    recordClaudeRateLimit(futureResetSeconds);
    expect(isLikelyNearClaudeUsageLimit()).toBe(true);

    // Simulate time passing beyond the reset
    const pastResetTime = new Date(futureResetSeconds * 1000 + 1000);
    expect(isLikelyNearClaudeUsageLimit(pastResetTime)).toBe(false);
  });
});
