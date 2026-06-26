import { describe, it, expect } from "vitest";
import { PtyStreamManager, createPtyHandle, setCapped, SCROLLBACK_CAP_BYTES, STREAM_MAP_CAP } from "../pty-stream.js";

/** Minimal fake IPty: lets the test drive onData and inspect handlers. */
function makeFakePty() {
  let dataCb: ((d: string) => void) | undefined;
  let errorCb: ((e: Error) => void) | undefined;
  const proc: any = {
    pid: 4242,
    _exitCode: null as number | null,
    _killedWith: undefined as string | undefined,
    onData: (cb: (d: string) => void) => { dataCb = cb; },
    onExit: () => {},
    on: (event: string, cb: (e: Error) => void) => { if (event === "error") errorCb = cb; },
    kill: (sig?: string) => { proc._killedWith = sig ?? "SIGTERM"; },
    emitData: (d: string) => dataCb?.(d),
    emitError: (e: Error) => errorCb?.(e),
  };
  return proc;
}

function makeManager(hasWarm: (id: string) => boolean = () => true) {
  return new PtyStreamManager("Test PTY", hasWarm);
}

describe("PtyStreamManager", () => {
  it("buffers PTY output and replays it via getScrollback", () => {
    const m = makeManager();
    const proc = makeFakePty();
    m.attach("s1", proc);
    proc.emitData("hello ");
    proc.emitData("world");
    expect(m.getScrollback("s1").toString("utf-8")).toBe("hello world");
  });

  it("caps the scrollback ring at SCROLLBACK_CAP_BYTES (evicts oldest chunks)", () => {
    const m = makeManager();
    const proc = makeFakePty();
    m.attach("s1", proc);
    const chunk = "x".repeat(64 * 1024);
    for (let i = 0; i < 8; i++) proc.emitData(chunk); // 512KB total > 256KB cap
    const sb = m.getScrollback("s1");
    expect(sb.length).toBeLessThanOrEqual(SCROLLBACK_CAP_BYTES);
    expect(sb.length).toBeGreaterThan(0);
  });

  it("slices down a single oversized chunk to the cap", () => {
    const m = makeManager();
    const proc = makeFakePty();
    m.attach("s1", proc);
    proc.emitData("y".repeat(SCROLLBACK_CAP_BYTES + 100));
    expect(m.getScrollback("s1").length).toBe(SCROLLBACK_CAP_BYTES);
  });

  it("delivers live output to subscribers and stops after unsubscribe", () => {
    const m = makeManager();
    const proc = makeFakePty();
    m.attach("s1", proc);
    const seen: string[] = [];
    const unsub = m.subscribe("s1", (d) => seen.push(d.toString("utf-8")));
    proc.emitData("a");
    unsub();
    proc.emitData("b");
    expect(seen).toEqual(["a"]);
  });

  it("calls the onData hook on every data event", () => {
    const m = makeManager();
    const proc = makeFakePty();
    let hits = 0;
    m.attach("s1", proc, () => { hits += 1; });
    proc.emitData("a");
    proc.emitData("b");
    expect(hits).toBe(2);
  });

  it("does NOT emit reset on the FIRST PTY but does on a respawn with subscribers", () => {
    const m = makeManager();
    const resets: string[] = [];
    m.subscribe("s1", () => {}, (e) => resets.push(e.type));
    const p1 = makeFakePty();
    m.attach("s1", p1); // first PTY — no reset even though a subscriber is attached
    expect(resets).toEqual([]);
    const p2 = makeFakePty();
    m.attach("s1", p2); // respawn — subscribers get a reset
    expect(resets).toEqual(["reset"]);
  });

  it("onPtyExit clears scrollback and drops the entry when no subscribers remain", () => {
    const m = makeManager();
    const proc = makeFakePty();
    m.attach("s1", proc);
    proc.emitData("stale farewell");
    m.onPtyExit("s1");
    expect(m.getScrollback("s1").length).toBe(0);
    // Entry was dropped: a fresh attach behaves like the first PTY again (no reset).
    const resets: string[] = [];
    m.subscribe("s1", () => {}, (e) => resets.push(e.type));
    m.attach("s1", makeFakePty());
    expect(resets).toEqual([]);
  });

  it("onPtyExit keeps the entry (cleared) while subscribers are attached", () => {
    const m = makeManager();
    const proc = makeFakePty();
    const resets: string[] = [];
    m.subscribe("s1", () => {}, (e) => resets.push(e.type));
    m.attach("s1", proc);
    proc.emitData("data");
    m.onPtyExit("s1");
    expect(m.getScrollback("s1").length).toBe(0);
    // hasSeenPty survives → the next PTY is a respawn and notifies the subscriber.
    m.attach("s1", makeFakePty());
    expect(resets).toEqual(["reset"]);
  });

  it("unsubscribing the last subscriber drops the entry when no warm PTY exists", () => {
    let warm = true;
    const m = makeManager(() => warm);
    const proc = makeFakePty();
    m.attach("s1", proc);
    proc.emitData("kept");
    const unsub = m.subscribe("s1", () => {});
    warm = false; // PTY reaped while the WS was still attached
    unsub();
    expect(m.getScrollback("s1").length).toBe(0); // entry gone
  });

  it("caps the streams map at STREAM_MAP_CAP (evicts the longest-idle session's scrollback)", () => {
    const m = makeManager();
    for (let i = 0; i < STREAM_MAP_CAP + 2; i++) {
      const proc = makeFakePty();
      m.attach(`s${i}`, proc);
      proc.emitData(`data-${i}`);
    }
    // The two oldest entries were evicted; the newest survive with scrollback intact.
    expect(m.getScrollback("s0").length).toBe(0);
    expect(m.getScrollback("s1").length).toBe(0);
    expect(m.getScrollback("s2").toString("utf-8")).toBe("data-2");
    expect(m.getScrollback(`s${STREAM_MAP_CAP + 1}`).toString("utf-8")).toBe(`data-${STREAM_MAP_CAP + 1}`);
  });

  it("attach/subscribe refresh recency so recently-touched sessions are not evicted", () => {
    const m = makeManager();
    const p0 = makeFakePty();
    m.attach("keep", p0);
    p0.emitData("kept");
    for (let i = 0; i < STREAM_MAP_CAP - 1; i++) m.attach(`s${i}`, makeFakePty());
    m.subscribe("keep", () => {}); // touch → "keep" is now most recent
    m.attach("overflow", makeFakePty()); // evicts s0, not "keep"
    expect(m.getScrollback("keep").toString("utf-8")).toBe("kept");
    expect(m.getScrollback("s0").length).toBe(0);
  });

  it("absorbs node-pty socket errors without throwing", () => {
    const m = makeManager();
    const proc = makeFakePty();
    m.attach("s1", proc);
    expect(() => proc.emitError(new Error("EIO"))).not.toThrow();
  });
});

describe("createPtyHandle", () => {
  it("exposes pid/killed/kill and stashes the proc on _proc", () => {
    const proc = makeFakePty();
    const handle = createPtyHandle(proc);
    expect(handle.pid).toBe(4242);
    expect(handle.killed).toBe(false);
    proc._exitCode = 0;
    expect(handle.killed).toBe(true);
    handle.kill("SIGTERM");
    expect(proc._killedWith).toBe("SIGTERM");
    expect((handle as any)._proc).toBe(proc);
  });
});

describe("setCapped", () => {
  it("evicts the oldest-touched entry beyond the cap", () => {
    const map = new Map<string, number>();
    setCapped(map, "a", 1, 2);
    setCapped(map, "b", 2, 2);
    setCapped(map, "c", 3, 2);
    expect([...map.keys()]).toEqual(["b", "c"]);
  });

  it("re-setting an existing key refreshes its recency", () => {
    const map = new Map<string, number>();
    setCapped(map, "a", 1, 2);
    setCapped(map, "b", 2, 2);
    setCapped(map, "a", 10, 2); // touch a → b is now oldest
    setCapped(map, "c", 3, 2);
    expect([...map.keys()]).toEqual(["a", "c"]);
    expect(map.get("a")).toBe(10);
  });
});
