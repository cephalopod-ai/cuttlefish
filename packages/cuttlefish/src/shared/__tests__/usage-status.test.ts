import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Point CUTTLEFISH_HOME at a throwaway dir before importing (paths are resolved at load).
const { home: tmp } = withStaticTempCuttlefishHome("cuttlefish-usage-");

type Mod = typeof import("../usage-status.js");
let M: Mod;

// Minimal config: defaults → lowPercent 15, fallback 180m (3h), maxWait 360m (6h).
const cfg = {} as any;
const cfgTuned = { sessions: { usageLowPercent: 20, usageFallbackWindowMins: 180, usageMaxWaitMins: 360 } } as any;

const NOW = new Date("2026-06-21T12:00:00.000Z").getTime();
const inHours = (h: number) => Math.floor((NOW + h * 3600_000) / 1000); // epoch seconds

beforeAll(async () => { M = await import("../usage-status.js"); });
beforeEach(() => {
  fs.rmSync(path.join(tmp, "tmp", "usage"), { recursive: true, force: true });
  fs.rmSync(path.join(tmp, "tmp", "claude-usage.json"), { force: true });
  fs.rmSync(path.join(tmp, "usage"), { recursive: true, force: true });
});

describe("statusFromInputs (actual-usage snapshot)", () => {
  const low = 15;
  it("ok when remaining is healthy", () => {
    const s = M.statusFromInputs("codex", { lowPercent: low, snapshot: { available: true, windows: [{ usedPercent: 40 }] } });
    expect(s).toMatchObject({ state: "ok", remainingPercent: 60, source: "live" });
  });
  it("low when remaining <= threshold → drives a switch", () => {
    const s = M.statusFromInputs("codex", { lowPercent: low, snapshot: { available: true, windows: [{ usedPercent: 90, resetsAt: inHours(2) }] } });
    expect(s).toMatchObject({ state: "low", remainingPercent: 10, resetsAt: inHours(2) });
  });
  it("exhausted at 100% used, carrying the window reset", () => {
    const s = M.statusFromInputs("claude", { lowPercent: low, snapshot: { available: true, windows: [{ usedPercent: 100, resetsAt: inHours(3) }] } });
    expect(s).toMatchObject({ state: "exhausted", resetsAt: inHours(3), source: "live" });
  });
  it("uses the WORST window (binding constraint)", () => {
    const s = M.statusFromInputs("codex", { lowPercent: low, snapshot: { available: true, windows: [{ usedPercent: 10 }, { usedPercent: 96, resetsAt: inHours(5) }] } });
    expect(s).toMatchObject({ state: "low", remainingPercent: 4, resetsAt: inHours(5) });
  });
  it("falls back to the recorded reset when no live snapshot", () => {
    const s = M.statusFromInputs("antigravity", { lowPercent: low, recordedReset: inHours(1) });
    expect(s).toMatchObject({ state: "exhausted", resetsAt: inHours(1), source: "recorded" });
  });
  it("unknown when neither snapshot nor recorded reset", () => {
    expect(M.statusFromInputs("pi", { lowPercent: low }).state).toBe("unknown");
  });
});

describe("recordEngineRateLimit / getRecordedReset", () => {
  it("uses the provider reset when given", () => {
    M.recordEngineRateLimit("antigravity", inHours(2));
    expect(M.getRecordedReset("antigravity", 180, NOW)).toBe(inHours(2));
  });
  it("falls back to lastRateLimitAt + 3h window when no reset given", () => {
    M.recordEngineRateLimit("antigravity"); // recorded "now" (real now)
    const realNow = Date.now();
    const reset = M.getRecordedReset("antigravity", 180, realNow);
    expect(reset).toBeDefined();
    // ~3h out (allow a few seconds of slack)
    expect(Math.abs(reset! * 1000 - (realNow + 180 * 60_000))).toBeLessThan(10_000);
  });
  it("returns undefined once the reset has passed (limit cleared)", () => {
    M.recordEngineRateLimit("codex", Math.floor((NOW - 3600_000) / 1000)); // reset 1h in the past
    expect(M.getRecordedReset("codex", 180, NOW)).toBeUndefined();
  });
});

describe("Kiro estimated credit ledger", () => {
  const kiroCfg = {
    engines: {
      claude: { bin: "claude", model: "opus" },
      codex: { bin: "codex", model: "gpt-5.5" },
      default: "kiro",
      kiro: { creditBudget: 10, billingAnchorDay: 15 },
    },
  } as any;

  it("accumulates credits inside the active billing window", () => {
    M.recordKiroCreditUsage(kiroCfg, 1.25, NOW);
    M.recordKiroCreditUsage(kiroCfg, 2.75, NOW + 1000);
    expect(M.readKiroCreditLedger(kiroCfg, NOW)).toEqual({
      windowStart: "2026-06-15T00:00:00.000Z",
      consumed: 4,
    });
  });

  it("rolls to zero when the billing anchor advances", () => {
    M.recordKiroCreditUsage(kiroCfg, 9, NOW);
    const nextWindow = new Date("2026-07-15T00:00:01.000Z").getTime();
    expect(M.readKiroCreditLedger(kiroCfg, nextWindow)).toEqual({
      windowStart: "2026-07-15T00:00:00.000Z",
      consumed: 0,
    });
  });

  it("reports estimated remaining percent and reset time", () => {
    M.recordKiroCreditUsage(kiroCfg, 8.5, NOW);
    const status = M.getKiroCreditUsageStatus(kiroCfg, { now: NOW });
    expect(status).toMatchObject({
      engine: "kiro",
      state: "low",
      remainingPercent: 15,
      resetsAt: Math.floor(new Date("2026-07-15T00:00:00.000Z").getTime() / 1000),
      source: "estimate",
      estimated: true,
    });
  });

  it("backs off to recorded exhaustion when a turn clearly ran out of credits", async () => {
    M.recordKiroCreditUsage(kiroCfg, 1, NOW);
    M.recordEngineRateLimit("kiro", Math.floor(new Date("2026-07-15T00:00:00.000Z").getTime() / 1000));
    const status = await M.getEngineUsageStatus("kiro", kiroCfg, { now: NOW });
    expect(status).toMatchObject({
      engine: "kiro",
      state: "exhausted",
      remainingPercent: 90,
      resetsAt: Math.floor(new Date("2026-07-15T00:00:00.000Z").getTime() / 1000),
      source: "recorded",
      estimated: true,
    });
  });
});

describe("planUsageRecovery (deterministic decision)", () => {
  const avail = () => true;
  const st = (engine: string, state: any, remainingPercent?: number, resetsAt?: number) =>
    ({ engine, state, remainingPercent, resetsAt, source: "live" as const });

  it("proceeds when the current engine is healthy", () => {
    const p = M.planUsageRecovery({ fromEngine: "codex", isAvailable: avail, config: cfg, now: NOW,
      statuses: { codex: st("codex", "ok", 80) } });
    expect(p.action).toBe("proceed");
  });

  it("switches to the healthiest available alternate when current is exhausted", () => {
    const p = M.planUsageRecovery({ fromEngine: "claude", isAvailable: avail, config: cfg, now: NOW,
      statuses: {
        claude: st("claude", "exhausted", 0, inHours(3)),
        codex: st("codex", "ok", 70),
        antigravity: st("antigravity", "ok", 40),
      } });
    expect(p).toMatchObject({ action: "switch", toEngine: "codex" }); // 70% beats 40%
  });

  it("switches off a LOW engine to a healthy one (proactive throttle)", () => {
    const p = M.planUsageRecovery({ fromEngine: "codex", isAvailable: avail, config: cfg, now: NOW,
      statuses: { codex: st("codex", "low", 8), claude: st("claude", "ok", 90) } });
    expect(p).toMatchObject({ action: "switch", toEngine: "claude" });
  });

  it("does NOT thrash when current and all alternates are merely low", () => {
    const p = M.planUsageRecovery({ fromEngine: "codex", isAvailable: avail, config: cfg, now: NOW,
      statuses: { codex: st("codex", "low", 8), claude: st("claude", "low", 9) } });
    expect(p.action).toBe("proceed");
  });

  it("skips unavailable engines when choosing a switch target", () => {
    const p = M.planUsageRecovery({ fromEngine: "claude", config: cfg, now: NOW,
      isAvailable: (e) => e !== "codex", // codex not installed
      statuses: { claude: st("claude", "exhausted", 0, inHours(3)), codex: st("codex", "ok", 99), antigravity: st("antigravity", "ok", 30) } });
    expect(p).toMatchObject({ action: "switch", toEngine: "antigravity" });
  });

  it("waits until the EARLIEST reset when everything is exhausted", () => {
    const p = M.planUsageRecovery({ fromEngine: "claude", isAvailable: avail, config: cfg, now: NOW,
      statuses: {
        claude: st("claude", "exhausted", 0, inHours(3)),
        codex: st("codex", "exhausted", 0, inHours(1)),   // earliest
        antigravity: st("antigravity", "exhausted", 0, inHours(5)),
      } });
    expect(p.action).toBe("wait");
    expect(p.waitUntil).toBe(inHours(1) + 10); // earliest + 10s buffer
  });

  it("uses the 3h fallback window when exhausted with no known reset", () => {
    const p = M.planUsageRecovery({ fromEngine: "pi", isAvailable: avail, config: cfg, now: NOW,
      statuses: { pi: st("pi", "exhausted", 0, undefined) } });
    expect(p.action).toBe("wait");
    expect(p.waitMs).toBe(180 * 60_000); // 3h
  });

  it("caps the wait at maxWait (never an unrecoverable infinite wait)", () => {
    const p = M.planUsageRecovery({ fromEngine: "claude", isAvailable: avail, config: cfg, now: NOW,
      statuses: { claude: st("claude", "exhausted", 0, inHours(48)) } }); // reset 2 days out
    expect(p.action).toBe("wait");
    expect(p.waitMs).toBe(360 * 60_000); // capped at 6h
    expect(p.reason).toMatch(/capped/);
  });

  it("honors tuned config knobs (low threshold / fallback window)", () => {
    // 18% remaining is 'low' under usageLowPercent:20
    const s = M.statusFromInputs("codex", { lowPercent: M.usageConfig(cfgTuned).lowPercent, snapshot: { available: true, windows: [{ usedPercent: 82 }] } });
    expect(s.state).toBe("low");
  });
});
