import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gatewayBaseUrl, writeGatewayInfo, readGatewayInfo, staleGatewayPids } from "../gateway-info.js";

describe("gateway-info", () => {
  it("writeGatewayInfo round-trips and generates a secret", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-"));
    const file = path.join(dir, "gateway.json");
    const info = writeGatewayInfo(file, { port: 8888, host: "100.95.1.62", pid: 1234 });
    expect(info.port).toBe(8888);
    expect(info.host).toBe("100.95.1.62");
    expect(info.pid).toBe(1234);
    expect(typeof info.secret).toBe("string");
    expect(info.secret.length).toBeGreaterThanOrEqual(32);
    expect(typeof info.token).toBe("string");
    expect((info.token ?? "").length).toBeGreaterThanOrEqual(32);
    expect(readGatewayInfo(file)).toEqual(info);
  });

  it("readGatewayInfo returns null when the file is missing", () => {
    expect(readGatewayInfo("/nonexistent/gateway.json")).toBe(null);
  });

  it("ignores token-only gateway info when deriving stale pids to reap", () => {
    expect(staleGatewayPids({ token: "tok" } as any, 1234)).toEqual([]);
    expect(staleGatewayPids({ pid: undefined, ptyPids: [111, undefined, 1234, 0, -1] } as any, 1234)).toEqual([111]);
  });

  it("formats gateway URLs for network, wildcard, and IPv6 hosts", () => {
    expect(gatewayBaseUrl({ port: 8888, host: "100.95.1.62" })).toBe("http://100.95.1.62:8888");
    expect(gatewayBaseUrl({ port: 8888, host: "0.0.0.0" })).toBe("http://127.0.0.1:8888");
    expect(gatewayBaseUrl({ port: 8888, host: "::1" })).toBe("http://[::1]:8888");
  });
});
