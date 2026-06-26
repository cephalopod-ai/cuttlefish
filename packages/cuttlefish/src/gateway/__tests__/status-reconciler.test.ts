import { describe, it, expect, beforeAll, beforeEach, vi, afterEach } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Point the DB at a throwaway dir BEFORE importing the registry (SESSIONS_DB is
// resolved from CUTTLEFISH_HOME at module load).
const { home: tmp } = withStaticTempCuttlefishHome("cuttlefish-reconciler-");

type Reg = typeof import("../../sessions/registry.js");
type Rec = typeof import("../status-reconciler.js");
let reg: Reg;
let rec: Rec;
let db: import("better-sqlite3").Database;

function insert(id: string, status: string, lastActivity: string, engine = "claude") {
  db.prepare(
    `INSERT INTO sessions (id, engine, source, source_ref, status, created_at, last_activity)
     VALUES (?, ?, 'web', ?, ?, ?, ?)`,
  ).run(id, engine, `web:${id}`, status, lastActivity, lastActivity);
}

const NOW = new Date("2026-06-10T12:00:00.000Z").getTime();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function fakeEngine(turnRunning: boolean) {
  return { name: "claude", run: async () => ({ sessionId: "", result: "" }), isTurnRunning: () => turnRunning } as any;
}

beforeAll(async () => {
  reg = await import("../../sessions/registry.js");
  rec = await import("../status-reconciler.js");
  db = reg.initDb();
});

beforeEach(() => {
  db.prepare("DELETE FROM sessions").run();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("status reconciler sweepOnce", () => {
  it("resets a stale running session whose engine reports no turn", () => {
    insert("stuck-1", "running", iso(120_000));
    const events: any[] = [];
    const fixed = rec.sweepOnce({
      engines: new Map([["claude", fakeEngine(false)]]),
      emit: (event, payload) => events.push({ event, payload }),
      now: () => NOW,
    });
    expect(fixed).toBe(1);
    expect(reg.getSession("stuck-1")?.status).toBe("idle");
    expect(events).toEqual([
      { event: "session:completed", payload: expect.objectContaining({ sessionId: "stuck-1" }) },
    ]);
  });

  it("leaves a running session with a FRESH heartbeat alone", () => {
    insert("live-1", "running", iso(10_000)); // heartbeat 10s ago — turn in flight
    const fixed = rec.sweepOnce({ engines: new Map([["claude", fakeEngine(false)]]), emit: () => {}, now: () => NOW });
    expect(fixed).toBe(0);
    expect(reg.getSession("live-1")?.status).toBe("running");
  });

  it("leaves a stale running session alone when the engine still reports a turn", () => {
    insert("working-1", "running", iso(120_000));
    const fixed = rec.sweepOnce({ engines: new Map([["claude", fakeEngine(true)]]), emit: () => {}, now: () => NOW });
    expect(fixed).toBe(0);
    expect(reg.getSession("working-1")?.status).toBe("running");
  });

  it("ignores idle sessions and unknown engines", () => {
    insert("idle-1", "idle", iso(999_000));
    insert("ghost-1", "running", iso(120_000), "no-such-engine");
    const fixed = rec.sweepOnce({ engines: new Map(), emit: () => {}, now: () => NOW });
    // Unknown engine → no live turn possible → unstick it too.
    expect(fixed).toBe(1);
    expect(reg.getSession("idle-1")?.status).toBe("idle");
    expect(reg.getSession("ghost-1")?.status).toBe("idle");
  });

  it("leaves a stale 'waiting' session untouched (rate-limit wait)", () => {
    insert("waiting-1", "waiting", iso(999_000));
    const fixed = rec.sweepOnce({ engines: new Map([["claude", fakeEngine(false)]]), emit: () => {}, now: () => NOW });
    expect(fixed).toBe(0);
    expect(reg.getSession("waiting-1")?.status).toBe("waiting");
  });

  it("isAlive fallback: headless engine without isTurnRunning", () => {
    insert("headless-live", "running", iso(120_000), "codex");
    insert("headless-dead", "running", iso(120_000), "codex");
    const aliveEngine = { name: "codex", run: async () => ({ sessionId: "", result: "" }), isAlive: (id: string) => id === "headless-live" } as any;
    const fixed = rec.sweepOnce({ engines: new Map([["codex", aliveEngine]]), emit: () => {}, now: () => NOW });
    expect(fixed).toBe(1);
    expect(reg.getSession("headless-live")?.status).toBe("running");
    expect(reg.getSession("headless-dead")?.status).toBe("idle");
  });

  it("isTurnRunning wins over isAlive (warm-but-idle PTY must be unstuck)", () => {
    insert("warm-idle", "running", iso(120_000));
    const warmIdle = { name: "claude", run: async () => ({ sessionId: "", result: "" }), isTurnRunning: () => false, isAlive: () => true } as any;
    const fixed = rec.sweepOnce({ engines: new Map([["claude", warmIdle]]), emit: () => {}, now: () => NOW });
    expect(fixed).toBe(1);
    expect(reg.getSession("warm-idle")?.status).toBe("idle");
  });

  it("two-sweep confirmation: first sweep marks, second sweep fixes, recovery clears the mark", () => {
    insert("boundary-1", "running", iso(120_000));
    const pendingStuck = new Set<string>();
    const deps = { engines: new Map([["claude", fakeEngine(false)]]), emit: () => {}, now: () => NOW, pendingStuck };
    expect(rec.sweepOnce(deps)).toBe(0); // first observation — candidate only
    expect(reg.getSession("boundary-1")?.status).toBe("running");
    expect(rec.sweepOnce(deps)).toBe(1); // second consecutive observation — fixed
    expect(reg.getSession("boundary-1")?.status).toBe("idle");

    // A candidate that recovers (fresh heartbeat) is cleared, not fixed later.
    insert("boundary-2", "running", iso(120_000));
    expect(rec.sweepOnce(deps)).toBe(0); // marked
    db.prepare("UPDATE sessions SET last_activity = ? WHERE id = ?").run(iso(1_000), "boundary-2");
    expect(rec.sweepOnce(deps)).toBe(0); // fresh — mark cleared
    db.prepare("UPDATE sessions SET last_activity = ? WHERE id = ?").run(iso(120_000), "boundary-2");
    expect(rec.sweepOnce(deps)).toBe(0); // stale again — needs re-confirmation
    expect(rec.sweepOnce(deps)).toBe(1); // now fixed
  });

  it("records a stall error and restamps lastActivity on fix", () => {
    insert("stuck-meta", "running", iso(120_000));
    db.prepare("UPDATE sessions SET last_error = 'boom' WHERE id = ?").run("stuck-meta");
    rec.sweepOnce({ engines: new Map(), emit: () => {}, now: () => NOW });
    const s = reg.getSession("stuck-meta");
    // Evidence preserved (not nulled): a stuck reset is a stall, not a clean finish.
    expect(s?.lastError ?? "").toMatch(/^Stalled:/);
    expect(new Date(s!.lastActivity).getTime()).toBe(NOW);
  });

  it("surfaces the stall on the completion event so consumers can act on it", () => {
    insert("stuck-evt", "running", iso(120_000));
    const events: any[] = [];
    rec.sweepOnce({
      engines: new Map([["claude", fakeEngine(false)]]),
      emit: (event, payload) => events.push({ event, payload }),
      now: () => NOW,
    });
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("session:completed");
    expect(events[0].payload).toMatchObject({ sessionId: "stuck-evt", stalled: true });
    expect(events[0].payload.error).toMatch(/^Stalled:/);
  });

  it("runs the periodic backstop on the same reconciler tick", () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const stop = rec.startStatusReconciler({
      engines: new Map(),
      emit: () => {},
      intervalMs: 1_000,
      onAfterSweep: () => calls.push("tick"),
    });
    try {
      vi.advanceTimersByTime(1_000);
      expect(calls).toEqual(["tick"]);
    } finally {
      stop();
    }
  });
});
