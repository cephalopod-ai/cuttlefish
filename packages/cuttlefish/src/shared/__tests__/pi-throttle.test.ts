import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetPiThrottleForTests,
  acquirePiMessageSlot,
  DEFAULT_PI_MESSAGES_PER_MINUTE,
  getPiThrottleSnapshot,
} from "../pi-throttle.js";

function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms; },
    get t() { return t; },
  };
}

describe("Pi local throttle", () => {
  beforeEach(() => __resetPiThrottleForTests());

  it("defaults to the conservative 10 messages/minute cap", () => {
    expect(DEFAULT_PI_MESSAGES_PER_MINUTE).toBe(10);
  });

  it("spaces Pi starts evenly at one every six seconds", async () => {
    const c = fakeClock();
    const first = await acquirePiMessageSlot({ now: c.now, sleep: c.sleep });
    const second = await acquirePiMessageSlot({ now: c.now, sleep: c.sleep });

    expect(first.waitedMs).toBe(0);
    expect(first.startedAtMs).toBe(0);
    expect(second.waitedMs).toBe(6000);
    expect(second.startedAtMs).toBe(6000);
    expect(c.t).toBe(6000);
  });

  it("does not allow more than ten starts inside one rolling minute", async () => {
    const c = fakeClock();
    const starts: number[] = [];
    for (let i = 0; i < 11; i++) {
      const slot = await acquirePiMessageSlot({ now: c.now, sleep: c.sleep });
      starts.push(slot.startedAtMs);
    }

    expect(starts.slice(0, 10)).toEqual([0, 6000, 12000, 18000, 24000, 30000, 36000, 42000, 48000, 54000]);
    expect(starts[10]).toBe(60000);
  });

  it("reports throttle usage for limits/status views", async () => {
    const c = fakeClock(1000);
    await acquirePiMessageSlot({ now: c.now, sleep: c.sleep });
    const snap = getPiThrottleSnapshot({ now: c.t });

    expect(snap.limit).toBe(10);
    expect(snap.usedInWindow).toBe(1);
    expect(snap.remainingInWindow).toBe(9);
    expect(snap.usedPercent).toBe(10);
    expect(snap.nextAvailableAtMs).toBe(7000);
    expect(snap.resetsAtMs).toBe(61000);
  });
});
