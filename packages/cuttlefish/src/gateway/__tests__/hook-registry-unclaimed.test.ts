import { describe, it, expect, afterEach } from "vitest";
import { HookRegistry, type HookPayload } from "../hook-registry.js";

// Unclaimed-Stop fallback: a Stop hook that no turn claims within the short
// grace delay is handed to the gateway's fallback handler (PTY-native turn —
// typed straight into the CLI view). A run() registering in time claims the
// buffered Stop instead, and a consumed Stop must never replay into a later
// turn's resolver.

const DELAY = 25;

describe("HookRegistry — unclaimed-Stop fallback consumer", () => {
  const registries: HookRegistry[] = [];
  const make = (): HookRegistry => {
    const r = new HookRegistry(30_000, 5_000, DELAY);
    registries.push(r);
    return r;
  };
  afterEach(() => {
    while (registries.length > 0) registries.pop()!.dispose();
  });

  const stop = (text: string): HookPayload => ({ hook_event_name: "Stop", last_assistant_message: text });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("hands an unclaimed Stop (with text) to the handler after the delay", async () => {
    const reg = make();
    const handled: Array<{ id: string; text: unknown }> = [];
    reg.setUnclaimedHookHandler((id, h) => handled.push({ id, text: h.last_assistant_message }));

    reg.deliver("s1", stop("pty-native answer"));
    expect(handled).toEqual([]); // not before the delay
    await sleep(DELAY * 3);
    expect(handled).toEqual([{ id: "s1", text: "pty-native answer" }]);
  });

  it("a listener registering within the delay claims the Stop — handler never fires", async () => {
    const reg = make();
    const handled: string[] = [];
    const seen: string[] = [];
    reg.setUnclaimedHookHandler((id) => handled.push(id));

    reg.deliver("s2", stop("claimed in time"));
    reg.register("s2", (h) => seen.push(String(h.last_assistant_message)));
    expect(seen).toEqual(["claimed in time"]); // buffered drain on register
    await sleep(DELAY * 3);
    expect(handled).toEqual([]);
  });

  it("a consumed Stop does NOT replay into a later register()", async () => {
    const reg = make();
    const handled: string[] = [];
    const seen: string[] = [];
    reg.setUnclaimedHookHandler((id) => handled.push(id));

    reg.deliver("s3", stop("consumed"));
    await sleep(DELAY * 3);
    expect(handled).toEqual(["s3"]);

    reg.register("s3", (h) => seen.push(h.hook_event_name));
    expect(seen).toEqual([]); // the consumed Stop is gone from the buffer
  });

  it("non-Stop and empty-text Stops never reach the handler (but stay buffered for a turn)", async () => {
    const reg = make();
    const handled: string[] = [];
    const seen: string[] = [];
    reg.setUnclaimedHookHandler((id) => handled.push(id));

    reg.deliver("s4", { hook_event_name: "SessionStart" });
    reg.deliver("s4", { hook_event_name: "Stop", last_assistant_message: "   " });
    await sleep(DELAY * 3);
    expect(handled).toEqual([]);

    reg.register("s4", (h) => seen.push(h.hook_event_name));
    expect(seen).toEqual(["SessionStart", "Stop"]); // normal buffering untouched
  });

  it("multiple unclaimed Stops within the delay collapse into ONE handler call with the newest", async () => {
    const reg = make();
    const handled: unknown[] = [];
    reg.setUnclaimedHookHandler((_id, h) => handled.push(h.last_assistant_message));

    reg.deliver("s5", stop("first"));
    reg.deliver("s5", stop("second"));
    await sleep(DELAY * 3);
    expect(handled).toEqual(["second"]); // anchor-based sync covers the first turn too
  });

  it("no handler installed → behaves exactly as before (buffer + drain)", async () => {
    const reg = make();
    const seen: string[] = [];
    reg.deliver("s6", stop("plain"));
    await sleep(DELAY * 3);
    reg.register("s6", (h) => seen.push(String(h.last_assistant_message)));
    expect(seen).toEqual(["plain"]);
  });
});
