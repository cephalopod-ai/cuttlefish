import { describe, it, expect, vi, afterEach } from "vitest";
import {
  sweepHeartbeat,
  trackHeartbeat,
  startWsHeartbeat,
  type HeartbeatSocket,
} from "../ws-heartbeat.js";

interface FakeSocket extends HeartbeatSocket {
  terminated: number;
  pinged: number;
  pingThrows: boolean;
}

function makeSocket(overrides: Partial<FakeSocket> = {}): FakeSocket {
  const sock: FakeSocket = {
    isAlive: true,
    readyState: 1,
    terminated: 0,
    pinged: 0,
    pingThrows: false,
    ping() {
      if (this.pingThrows) throw new Error("socket mid-teardown");
      this.pinged++;
    },
    terminate() {
      this.terminated++;
    },
    ...overrides,
  };
  return sock;
}

/** A socket that also supports the `pong` event wiring used by trackHeartbeat. */
function makeTrackableSocket() {
  let pongCb: (() => void) | null = null;
  const sock = makeSocket();
  const trackable = sock as FakeSocket & {
    on(event: "pong", cb: () => void): void;
    emitPong(): void;
  };
  trackable.on = (_event: "pong", cb: () => void) => {
    pongCb = cb;
  };
  trackable.emitPong = () => {
    pongCb?.();
  };
  return trackable;
}

describe("sweepHeartbeat", () => {
  it("terminates a socket marked dead (isAlive===false)", () => {
    const dead = makeSocket({ isAlive: false });
    const result = sweepHeartbeat([dead]);

    expect(dead.terminated).toBe(1);
    expect(dead.pinged).toBe(0);
    expect(result).toEqual({ terminated: 1, pinged: 0 });
  });

  it("pings a live socket and marks it provisionally dead", () => {
    const live = makeSocket({ isAlive: true });
    const result = sweepHeartbeat([live]);

    expect(live.terminated).toBe(0);
    expect(live.pinged).toBe(1);
    expect(live.isAlive).toBe(false);
    expect(result).toEqual({ terminated: 0, pinged: 1 });
  });

  it("returns correct counts over a mixed set", () => {
    const sockets = [
      makeSocket({ isAlive: true }),
      makeSocket({ isAlive: false }),
      makeSocket({ isAlive: true }),
      makeSocket({ isAlive: false }),
      makeSocket({ isAlive: true }),
    ];

    const result = sweepHeartbeat(sockets);

    expect(result).toEqual({ terminated: 2, pinged: 3 });
  });

  it("counts a throwing ping as not-pinged without crashing the sweep", () => {
    const bad = makeSocket({ isAlive: true, pingThrows: true });
    const good = makeSocket({ isAlive: true });

    const result = sweepHeartbeat([bad, good]);

    expect(result).toEqual({ terminated: 0, pinged: 1 });
    // Both sockets were still marked provisionally dead.
    expect(bad.isAlive).toBe(false);
    expect(good.isAlive).toBe(false);
    expect(good.pinged).toBe(1);
  });
});

describe("trackHeartbeat", () => {
  it("sets isAlive=true and a pong flips it back after a sweep marks it dead", () => {
    const sock = makeTrackableSocket();
    sock.isAlive = undefined;

    trackHeartbeat(sock);
    expect(sock.isAlive).toBe(true);

    // A sweep marks it provisionally dead...
    sweepHeartbeat([sock]);
    expect(sock.isAlive).toBe(false);

    // ...and the pong handler installed by trackHeartbeat revives it.
    sock.emitPong();
    expect(sock.isAlive).toBe(true);

    // Next sweep should therefore ping (not terminate) it.
    const result = sweepHeartbeat([sock]);
    expect(result).toEqual({ terminated: 0, pinged: 1 });
  });
});

describe("startWsHeartbeat", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("triggers sweeps on the interval and stops when the stop fn is called", () => {
    vi.useFakeTimers();

    const a = makeSocket({ isAlive: true });
    const b = makeSocket({ isAlive: false });
    const server = { clients: new Set([a, b]) as unknown as Set<never> };

    const onSweep = vi.fn();
    const stop = startWsHeartbeat([server as { clients: Set<never> }], {
      intervalMs: 1000,
      onSweep,
    });

    // No sweep yet.
    expect(onSweep).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(onSweep).toHaveBeenCalledTimes(1);
    expect(onSweep).toHaveBeenLastCalledWith({ terminated: 1, pinged: 1 });
    expect(b.terminated).toBe(1);
    expect(a.pinged).toBe(1);

    // Second sweep: `a` was marked dead by the prior sweep, so it terminates now.
    vi.advanceTimersByTime(1000);
    expect(onSweep).toHaveBeenCalledTimes(2);
    expect(a.terminated).toBe(1);

    // Stop clears the timer — no further sweeps.
    stop();
    vi.advanceTimersByTime(5000);
    expect(onSweep).toHaveBeenCalledTimes(2);
  });
});
