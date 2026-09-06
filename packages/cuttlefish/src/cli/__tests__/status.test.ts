import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import fs from "node:fs";
import path from "node:path";

const { home: tmpHome } = withStaticTempCuttlefishHome("cuttlefish-status-test-");

const lifecycle = vi.hoisted(() => ({
  getStatus: vi.fn(() => ({ running: true, pid: 123 })),
}));
const config = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({ gateway: { host: "127.0.0.1", port: 8888 }, engines: { default: "claude" } })),
}));

vi.mock("../../gateway/lifecycle.js", () => lifecycle);
vi.mock("../../shared/config.js", () => config);

const { fetchLiveStatus, resolveStatusEndpoint, runStatus } = await import("../status.js");

function writeGatewayJson(info: Record<string, unknown>): void {
  fs.writeFileSync(path.join(tmpHome, "gateway.json"), JSON.stringify(info));
}

beforeEach(() => {
  vi.clearAllMocks();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.mkdirSync(tmpHome, { recursive: true });
  lifecycle.getStatus.mockReturnValue({ running: true, pid: 123 });
  config.loadConfig.mockReturnValue({ gateway: { host: "127.0.0.1", port: 8888 }, engines: { default: "claude" } });
});

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("resolveStatusEndpoint", () => {
  it("prefers the live gateway record (port, host, token) over config.yaml", () => {
    writeGatewayJson({ port: 8899, host: "127.0.0.1", pid: 123, secret: "s", token: "gateway-token" });
    expect(resolveStatusEndpoint()).toEqual({
      url: "http://127.0.0.1:8899/api/status",
      port: 8899,
      token: "gateway-token",
    });
  });

  it("falls back to config.yaml when no gateway record exists", () => {
    expect(resolveStatusEndpoint()).toEqual({
      url: "http://127.0.0.1:8888/api/status",
      port: 8888,
      token: undefined,
    });
  });

  it("targets loopback when the gateway binds a wildcard host", () => {
    writeGatewayJson({ port: 8888, host: "0.0.0.0", pid: 123, secret: "s", token: "t" });
    config.loadConfig.mockReturnValue({ gateway: { host: "0.0.0.0", port: 8888 }, engines: { default: "claude" } });
    expect(resolveStatusEndpoint()?.url).toBe("http://127.0.0.1:8888/api/status");
  });
});

describe("fetchLiveStatus", () => {
  it("authenticates with the gateway token so the operator-only status route answers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ sessions: { total: 2, running: 1, active: 1 }, uptime: 42 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const data = await fetchLiveStatus(
      { url: "http://127.0.0.1:8888/api/status", port: 8888, token: "gateway-token" },
      fetchMock as unknown as typeof fetch,
    );
    expect(data).toEqual({ sessions: { total: 2, running: 1, active: 1 }, uptime: 42 });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8888/api/status",
      expect.objectContaining({ headers: { authorization: "Bearer gateway-token" } }),
    );
  });

  it("returns null on a non-OK answer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 401 }));
    const data = await fetchLiveStatus(
      { url: "http://127.0.0.1:8888/api/status", port: 8888 },
      fetchMock as unknown as typeof fetch,
    );
    expect(data).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8888/api/status",
      expect.objectContaining({ headers: {} }),
    );
  });
});

describe("runStatus", () => {
  it("prints live port and session details for a running gateway", async () => {
    writeGatewayJson({ port: 8899, host: "127.0.0.1", pid: 123, secret: "s", token: "gateway-token" });
    fs.writeFileSync(path.join(tmpHome, "gateway.pid"), "123");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ sessions: { total: 3, running: 1, active: 1 }, uptime: 7 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line: string) => { lines.push(line); });

    await runStatus();

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://127.0.0.1:8899/api/status",
      expect.objectContaining({ headers: { authorization: "Bearer gateway-token" } }),
    );
    expect(lines).toContain("Gateway: running");
    expect(lines).toContain("  PID: 123");
    expect(lines).toContain("  Port: 8899");
    expect(lines).toContain("  Active sessions: 1 (running: 1, total: 3)");
    expect(lines).toContain("  Server uptime: 7s");
    log.mockRestore();
    fetchSpy.mockRestore();
  });

  it("still reports the port when the gateway does not answer over HTTP", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line: string) => { lines.push(line); });

    await runStatus();

    expect(lines).toContain("Gateway: running");
    expect(lines).toContain("  Port: 8888 (not responding to HTTP)");
    log.mockRestore();
    fetchSpy.mockRestore();
  });
});
