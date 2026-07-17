import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MAIN_AGENT_SENTINEL, SsePtyProxy, type SseDataEvent } from "../sse-pty-proxy.js";

const proxies: SsePtyProxy[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  for (const proxy of proxies.splice(0)) proxy.stop();
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))));
});

function listen(server: http.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function request(port: number, body: string, headers: http.OutgoingHttpHeaders = {}): Promise<{
  status: number;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/v1/messages",
      method: "POST",
      headers,
      agent: false,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("SsePtyProxy byte limits", () => {
  it("rejects a streamed request over the cap without contacting upstream", async () => {
    let attempts = 0;
    const upstreamPort = await listen(http.createServer((_req, res) => {
      attempts += 1;
      res.end("unexpected");
    }));
    const proxy = new SsePtyProxy("limit-test", () => {}, {
      requestFn: http.request,
      upstream: { hostname: "127.0.0.1", port: upstreamPort },
      primaryAgent: false,
      maxRequestBodyBytes: 8,
    });
    proxies.push(proxy);
    const port = await proxy.start();

    const result = await request(port, "123456789", { "transfer-encoding": "chunked" });

    expect(result).toEqual({ status: 413, body: "Payload too large" });
    expect(attempts).toBe(0);
    expect(proxy.activeStreams).toBe(0);
  });

  it("stops parsing an oversized SSE frame but forwards every byte unchanged", async () => {
    const oversized = `data: ${JSON.stringify({ type: "oversized", text: "x".repeat(128) })}\n\n`;
    const following = `data: ${JSON.stringify({ type: "must-not-emit" })}\n\n`;
    const upstreamBody = oversized + following;
    const upstreamPort = await listen(http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(upstreamBody);
    }));
    const events: SseDataEvent[] = [];
    const proxy = new SsePtyProxy("limit-test", (event) => events.push(event), {
      requestFn: http.request,
      upstream: { hostname: "127.0.0.1", port: upstreamPort },
      primaryAgent: false,
      maxSseFrameBytes: 64,
    });
    proxies.push(proxy);
    const port = await proxy.start();
    const requestBody = JSON.stringify({
      tools: [{ name: "tool" }],
      system: MAIN_AGENT_SENTINEL,
    });

    const result = await request(port, requestBody);

    expect(result.status).toBe(200);
    expect(result.body).toBe(upstreamBody);
    expect(events).toEqual([]);
  });
});
