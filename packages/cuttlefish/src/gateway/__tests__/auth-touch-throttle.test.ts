import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage } from "node:http";

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  createAuthSession,
  resetAuthTouchThrottleForTests,
  touchAuthSession,
  AUTH_COOKIE,
  AUTH_DEVICE_COOKIE,
} from "../auth.js";
import { logger } from "../../shared/logger.js";

let home: string;

function request(cookies: Record<string, string> = {}): Pick<IncomingMessage, "headers" | "socket"> {
  const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
  return {
    headers: { ...(cookie ? { cookie } : {}), "user-agent": "test-agent" },
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as Pick<IncomingMessage, "headers" | "socket">;
}

function devicesFileMtime(): number {
  return fs.statSync(path.join(home, "auth-devices.json")).mtimeMs;
}

function devicesFileBody(): { devices: Array<{ id: string; lastSeenAt: string }> } {
  return JSON.parse(fs.readFileSync(path.join(home, "auth-devices.json"), "utf-8"));
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-auth-touch-"));
  resetAuthTouchThrottleForTests();
  vi.mocked(logger.warn).mockClear();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  resetAuthTouchThrottleForTests();
});

describe("touchAuthSession write throttle (UPS-A4)", () => {
  it("writes the device file at most once a minute per device", () => {
    const { secret, device } = createAuthSession(home, request(), { kind: "local" });
    const cookies = { [AUTH_COOKIE]: secret, [AUTH_DEVICE_COOKIE]: device.id };
    const t0 = Date.parse("2026-09-05T12:00:00.000Z");

    // First touch writes.
    expect(touchAuthSession(home, request(cookies), t0)).not.toBeNull();
    const afterFirst = devicesFileBody().devices[0].lastSeenAt;

    // A burst of polling within the window must not write again.
    for (let i = 1; i <= 50; i++) {
      expect(touchAuthSession(home, request(cookies), t0 + i * 1000)).not.toBeNull();
    }
    expect(devicesFileBody().devices[0].lastSeenAt).toBe(afterFirst);

    // Past the window, the stamp lands.
    touchAuthSession(home, request(cookies), t0 + 61_000);
    expect(devicesFileBody().devices[0].lastSeenAt).not.toBe(afterFirst);
  });

  it("throttles per device, not globally", () => {
    const a = createAuthSession(home, request(), { kind: "local" });
    const b = createAuthSession(home, request(), { kind: "remote" });
    const t0 = Date.parse("2026-09-05T12:00:00.000Z");

    touchAuthSession(home, request({ [AUTH_COOKIE]: a.secret, [AUTH_DEVICE_COOKIE]: a.device.id }), t0);
    const afterA = devicesFileMtime();

    // A different device inside the same window still gets its first write.
    const touched = touchAuthSession(home, request({ [AUTH_COOKIE]: b.secret, [AUTH_DEVICE_COOKIE]: b.device.id }), t0 + 1000);
    expect(touched?.id).toBe(b.device.id);
    const stamped = devicesFileBody().devices.find((d) => d.id === b.device.id)!;
    expect(Date.parse(stamped.lastSeenAt)).toBe(t0 + 1000);
    expect(devicesFileMtime()).toBeGreaterThanOrEqual(afterA);
  });

  it("still refuses an unknown or forged cookie pair", () => {
    const { device } = createAuthSession(home, request(), { kind: "local" });
    expect(touchAuthSession(home, request({ [AUTH_COOKIE]: "wrong", [AUTH_DEVICE_COOKIE]: device.id }))).toBeNull();
    expect(touchAuthSession(home, request())).toBeNull();
  });

  it("keeps serving the request when the stamp cannot be written", () => {
    const { secret, device } = createAuthSession(home, request(), { kind: "local" });
    const cookies = { [AUTH_COOKIE]: secret, [AUTH_DEVICE_COOKIE]: device.id };

    const enospc = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => { throw enospc; });
    try {
      // A full disk must not throw out of request handling.
      expect(() => touchAuthSession(home, request(cookies), Date.now())).not.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(expect.stringContaining("ENOSPC"));
  });

  it("does not swallow an unexpected write failure", () => {
    const { secret, device } = createAuthSession(home, request(), { kind: "local" });
    const cookies = { [AUTH_COOKIE]: secret, [AUTH_DEVICE_COOKIE]: device.id };

    const weird = Object.assign(new Error("something else"), { code: "EIO" });
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => { throw weird; });
    try {
      expect(() => touchAuthSession(home, request(cookies), Date.now())).toThrow("something else");
    } finally {
      spy.mockRestore();
    }
  });

  it("retries the write on the next request after a failed one", () => {
    const { secret, device } = createAuthSession(home, request(), { kind: "local" });
    const cookies = { [AUTH_COOKIE]: secret, [AUTH_DEVICE_COOKIE]: device.id };
    const t0 = Date.parse("2026-09-05T12:00:00.000Z");

    const enospc = Object.assign(new Error("full"), { code: "ENOSPC" });
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => { throw enospc; });
    touchAuthSession(home, request(cookies), t0);
    spy.mockRestore();

    // The failure did not arm the throttle, so the very next touch writes.
    touchAuthSession(home, request(cookies), t0 + 1000);
    expect(Date.parse(devicesFileBody().devices[0].lastSeenAt)).toBe(t0 + 1000);
  });
});
