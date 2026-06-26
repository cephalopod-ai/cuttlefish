import { describe, it, expect, afterEach } from "vitest";
import { HookRegistry } from "../hook-registry.js";

describe("HookRegistry", () => {
  // Centralized teardown — every `new HookRegistry()` in a test gets pushed
  // here and disposed in afterEach so the sweep timer never leaks across tests.
  const registries: HookRegistry[] = [];
  const make = (ttlMs?: number, sweepIntervalMs?: number): HookRegistry => {
    const r = ttlMs === undefined
      ? new HookRegistry()
      : sweepIntervalMs === undefined
        ? new HookRegistry(ttlMs)
        : new HookRegistry(ttlMs, sweepIntervalMs);
    registries.push(r);
    return r;
  };
  afterEach(() => {
    while (registries.length > 0) registries.pop()!.dispose();
  });

  it("delivers a hook that arrives AFTER registration", () => {
    const reg = make();
    const seen: string[] = [];
    reg.register("s1", (h) => seen.push(h.hook_event_name));
    reg.deliver("s1", { hook_event_name: "SessionStart" } as any);
    expect(seen).toEqual(["SessionStart"]);
  });

  it("buffers a hook that arrives BEFORE registration and drains on register", () => {
    const reg = make();
    const seen: string[] = [];
    reg.deliver("s2", { hook_event_name: "SessionStart" } as any);
    expect(seen).toEqual([]);
    reg.register("s2", (h) => seen.push(h.hook_event_name));
    expect(seen).toEqual(["SessionStart"]);
  });

  it("unregister stops delivery and clears buffer", () => {
    const reg = make();
    const seen: string[] = [];
    reg.register("s3", (h) => seen.push(h.hook_event_name));
    reg.unregister("s3");
    reg.deliver("s3", { hook_event_name: "Stop" } as any);
    expect(seen).toEqual([]);
  });

  it("drops buffered hooks past TTL", async () => {
    const reg = make(20); // 20ms TTL
    reg.deliver("s4", { hook_event_name: "SessionStart" } as any);
    await new Promise((r) => setTimeout(r, 40));
    const seen: string[] = [];
    reg.register("s4", (h) => seen.push(h.hook_event_name));
    expect(seen).toEqual([]);
  });

  it("periodic sweep evicts stale entries but keeps fresh ones", async () => {
    const reg = make(50, 10); // 50ms TTL, 10ms sweep
    // t=0: deliver a stale entry that should age past TTL by t=80ms.
    reg.deliver("s5_old", { hook_event_name: "SessionStart" } as any);
    // Access internal buffer for assertion — keep registry visibility minimal.
    const buf = (reg as unknown as { buffer: Map<string, unknown[]> }).buffer;
    expect(buf.has("s5_old")).toBe(true);

    // At t=70ms, just before the t=80ms check, deliver a fresh entry. With a
    // 50ms TTL it must still be buffered at t=80ms — proves the sweep is
    // age-aware, not "wipe everything on tick".
    await new Promise((r) => setTimeout(r, 70));
    reg.deliver("s5_fresh", { hook_event_name: "SessionStart" } as any);

    await new Promise((r) => setTimeout(r, 10)); // now t≈80ms — at least one sweep has run
    expect(buf.has("s5_old")).toBe(false);
    expect(buf.has("s5_fresh")).toBe(true);
  });
});
