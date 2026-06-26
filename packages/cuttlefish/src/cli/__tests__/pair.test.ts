import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatPairedDevices,
  formatPairingInstructions,
  requestPairedDevices,
  requestPairingCode,
  requestUnpairDevice,
} from "../pair.js";

describe("pair CLI helpers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("requests a pairing code from the local gateway auth endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        status: "ok",
        code: "ABCD-EFGH-JKLM",
        expiresAt: "2026-06-24T10:00:00.000Z",
        ttlSeconds: 300,
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );

    const result = await requestPairingCode({
      port: 8888,
      host: "100.95.1.62",
      token: "gateway-token",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.code).toBe("ABCD-EFGH-JKLM");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://100.95.1.62:8888/api/auth/pairing-codes",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer gateway-token",
        }),
      }),
    );
  });

  it("prints simple pairing instructions without leaking the gateway token", () => {
    const text = formatPairingInstructions({
      code: "ABCD-EFGH-JKLM",
      expiresAt: "2026-06-24T10:00:00.000Z",
      ttlSeconds: 300,
    }, 8888);

    expect(text).toContain("ABCD-EFGH-JKLM");
    expect(text).toContain("Open Cuttlefish on the other device");
    expect(text).toContain("Settings > Pairing");
    expect(text).toContain("5 minutes");
    expect(text).not.toContain("gateway-token");
  });

  it("lists paired devices from the local gateway auth endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        devices: [
          { id: "device-1", name: "This Mac", current: true, lastSeenAt: "2026-06-24T10:00:00.000Z" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );

    const devices = await requestPairedDevices({
      port: 8888,
      host: "::1",
      token: "gateway-token",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(devices).toEqual([
      expect.objectContaining({ id: "device-1", name: "This Mac", current: true }),
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://[::1]:8888/api/auth/devices",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          authorization: "Bearer gateway-token",
        }),
      }),
    );
  });

  it("unpairs a device through the shared device delete endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok", current: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await requestUnpairDevice({
      port: 8888,
      token: "gateway-token",
      deviceId: "device-2",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8888/api/auth/devices/device-2",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          authorization: "Bearer gateway-token",
        }),
      }),
    );
  });

  it("prints unpair instructions without leaking the gateway token", () => {
    const text = formatPairedDevices([
      { id: "device-1", name: "This Mac", current: true, lastSeenAt: "2026-06-24T10:00:00.000Z" },
      { id: "-device-2", name: "iPhone browser", current: false, lastSeenAt: "2026-06-24T10:05:00.000Z" },
    ]);

    expect(text).toContain("Paired browsers");
    expect(text).toContain("This Mac");
    expect(text).toContain("iPhone browser");
    expect(text).toContain("cuttlefish unpair -- -device-2");
    expect(text).not.toContain("gateway-token");
  });
});
