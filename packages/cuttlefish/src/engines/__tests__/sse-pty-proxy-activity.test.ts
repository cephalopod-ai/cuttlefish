import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { AddressInfo } from "node:net";
import { SsePtyProxy, type UpstreamActivityInfo } from "../sse-pty-proxy.js";

// In-flight upstream tracking: the proxy counts EVERY upstream request (main
// agent, sub-agents, background tasks alike) and reports each change through
// onUpstreamActivity. The count must return to 0 on ALL terminal paths —
// response end, upstream error (incl. after the one-shot retry), and a client
// that hangs up mid-stream.

interface Upstream {
  port: number;
  attempts: () => number;
  close: () => Promise<void>;
}

function startUpstream(onAttempt: (n: number, req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<Upstream> {
  let n = 0;
  const server = http.createServer((req, res) => {
    n += 1;
    req.resume();
    onAttempt(n, req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        attempts: () => n,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function callProxy(port: number, body = '{"hello":"world"}'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: "/v1/messages", method: "POST", agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf-8") }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** Poll until `fn` returns true (or fail after ~2s). */
async function until(fn: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error("condition not reached within 2s");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("SsePtyProxy in-flight upstream tracking", () => {
  const proxies: SsePtyProxy[] = [];
  const upstreams: Upstream[] = [];
  const newProxy = (u: Upstream, onActivity: (info: UpstreamActivityInfo) => void) => {
    const p = new SsePtyProxy("test", () => {}, {
      requestFn: http.request,
      upstream: { hostname: "127.0.0.1", port: u.port },
      primaryAgent: false,
      onUpstreamActivity: onActivity,
    });
    proxies.push(p);
    return p;
  };

  afterEach(async () => {
    for (const p of proxies.splice(0)) p.stop();
    for (const u of upstreams.splice(0)) await u.close();
  });

  it("counts up at request start and back to 0 on response end", async () => {
    const counts: number[] = [];
    const upstream = await startUpstream((_n, _req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("ok");
    });
    upstreams.push(upstream);
    const proxy = newProxy(upstream, (i) => counts.push(i.activeStreams));
    const port = await proxy.start();

    const before = Date.now();
    const out = await callProxy(port);

    expect(out.status).toBe(200);
    expect(counts).toEqual([1, 0]);
    expect(proxy.activeStreams).toBe(0);
    expect(proxy.lastUpstreamActivityAt).toBeGreaterThanOrEqual(before);
  });

  it("returns to 0 on an upstream HTTP error response too", async () => {
    const counts: number[] = [];
    const upstream = await startUpstream((_n, _req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end('{"error":"boom"}');
    });
    upstreams.push(upstream);
    const proxy = newProxy(upstream, (i) => counts.push(i.activeStreams));
    const port = await proxy.start();

    await callProxy(port);
    expect(counts).toEqual([1, 0]);
  });

  it("the one-shot retry is the SAME logical stream — never double-counted, 0 only at the true end", async () => {
    const counts: number[] = [];
    const upstream = await startUpstream((n, _req, res) => {
      if (n === 1) res.socket?.destroy(); // first attempt: stale-socket reset → retriable
      else { res.writeHead(200, { "content-type": "application/json" }); res.end("ok"); }
    });
    upstreams.push(upstream);
    const proxy = newProxy(upstream, (i) => counts.push(i.activeStreams));
    const port = await proxy.start();

    const out = await callProxy(port);
    expect(out.status).toBe(200);
    expect(upstream.attempts()).toBe(2);
    expect(counts).toEqual([1, 0]); // no dip to 0 between attempts, no climb to 2
  });

  it("returns to 0 when BOTH attempts fail (terminal upstream error → 502)", async () => {
    const counts: number[] = [];
    const upstream = await startUpstream((_n, _req, res) => res.socket?.destroy());
    upstreams.push(upstream);
    const proxy = newProxy(upstream, (i) => counts.push(i.activeStreams));
    const port = await proxy.start();

    const out = await callProxy(port);
    expect(out.status).toBe(502);
    expect(counts).toEqual([1, 0]);
  });

  it("returns to 0 when the CLIENT hangs up mid-stream (abort path)", async () => {
    const counts: number[] = [];
    // Upstream starts an SSE response and never ends it.
    const upstream = await startUpstream((_n, _req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: {}\n\n");
      // intentionally never res.end()
    });
    upstreams.push(upstream);
    const proxy = newProxy(upstream, (i) => counts.push(i.activeStreams));
    const port = await proxy.start();

    await new Promise<void>((resolve) => {
      const req = http.request(
        { hostname: "127.0.0.1", port, path: "/v1/messages", method: "POST", agent: false },
        (res) => {
          // First byte received — hang up mid-stream.
          res.once("data", () => { req.destroy(); resolve(); });
        },
      );
      req.on("error", () => resolve());
      req.end("{}");
    });

    await until(() => proxy.activeStreams === 0);
    expect(counts[0]).toBe(1);
    expect(counts[counts.length - 1]).toBe(0);
  });

  it("tracks concurrent requests independently (sub-agent fan-out)", async () => {
    const seen: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const upstream = await startUpstream((_n, _req, res) => {
      void gate.then(() => { res.writeHead(200); res.end("ok"); });
    });
    upstreams.push(upstream);
    const proxy = newProxy(upstream, (i) => seen.push(i.activeStreams));
    const port = await proxy.start();

    const a = callProxy(port);
    const b = callProxy(port);
    await until(() => proxy.activeStreams === 2);
    release();
    await Promise.all([a, b]);

    expect(Math.max(...seen)).toBe(2);
    expect(proxy.activeStreams).toBe(0);
    expect(seen[seen.length - 1]).toBe(0);
  });
});
