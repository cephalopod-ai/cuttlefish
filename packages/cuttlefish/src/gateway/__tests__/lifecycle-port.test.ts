import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { waitForPortListening, waitForPortFree } from "../lifecycle.js";

/**
 * Pick a free ephemeral port by briefly binding one and reading it back.
 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

describe("waitForPortListening", () => {
  const servers: net.Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
    );
  });

  it("returns true once a server accepts connections on the port", async () => {
    const port = await freePort();
    const srv = net.createServer((sock) => sock.end());
    servers.push(srv);
    await new Promise<void>((resolve) => srv.listen(port, "127.0.0.1", resolve));

    const listening = await waitForPortListening(port, "127.0.0.1", 3_000);
    expect(listening).toBe(true);
  });

  it("returns false on timeout when nothing is listening", async () => {
    const port = await freePort();
    const listening = await waitForPortListening(port, "127.0.0.1", 600);
    expect(listening).toBe(false);
  });

  it("becomes true after a server starts mid-wait (verifies the daemon-bind handoff)", async () => {
    const port = await freePort();
    const srv = net.createServer((sock) => sock.end());
    servers.push(srv);
    // Start listening shortly after the wait begins — mirrors restart-entry
    // spawning the daemon and then polling until it binds.
    setTimeout(() => srv.listen(port, "127.0.0.1"), 300);

    const listening = await waitForPortListening(port, "127.0.0.1", 3_000);
    expect(listening).toBe(true);
  });
});

describe("waitForPortFree", () => {
  it("returns true when the port is already free", async () => {
    // freePort() releases the port before resolving.
    const port = await freePort();
    const free = await waitForPortFree(port, 3_000);
    expect(free).toBe(true);
  });
});
