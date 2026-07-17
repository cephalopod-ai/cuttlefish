import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-transfer-sec-"));
process.env.CUTTLEFISH_HOME = tmpHome;

type Transfer = typeof import("../files/transfer.js");

let transfer: Transfer;

beforeAll(async () => {
  transfer = await import("../files/transfer.js");
});

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeContext(overrides: Record<string, unknown> = {}): any {
  return {
    getConfig: () => ({ gateway: {} }),
    ...overrides,
  };
}

describe("resolveFileSpec (CF2-202)", () => {
  it("refuses to transfer a blocked secret path", () => {
    const secretDir = path.join(tmpHome, "secrets");
    fs.mkdirSync(secretDir, { recursive: true });
    const secret = path.join(secretDir, "api.txt");
    fs.writeFileSync(secret, "TOKEN=should-not-leak");

    expect(() => transfer.resolveFileSpec({ file: secret }, fakeContext())).toThrow();
  });

  it("refuses to transfer SSH private keys", () => {
    const sshKey = path.join(os.homedir(), ".ssh", "id_rsa");
    expect(() => transfer.resolveFileSpec({ file: sshKey }, fakeContext())).toThrow();
  });

  it("refuses a path outside a configured fileReadRoots allowlist", () => {
    const outside = path.join(tmpHome, "notes.txt");
    fs.writeFileSync(outside, "hello");
    const rootedContext = fakeContext({
      getConfig: () => ({ gateway: { fileReadRoots: [path.join(tmpHome, "allowed-only")] } }),
    });
    expect(() => transfer.resolveFileSpec({ file: outside }, rootedContext)).toThrow(/fileReadRoots/);
  });

  it("allows a normal file inside the configured roots", () => {
    const allowedDir = path.join(tmpHome, "allowed-only");
    fs.mkdirSync(allowedDir, { recursive: true });
    const file = path.join(allowedDir, "report.txt");
    fs.writeFileSync(file, "hello");
    const rootedContext = fakeContext({
      getConfig: () => ({ gateway: { fileReadRoots: [allowedDir] } }),
    });
    const result = transfer.resolveFileSpec({ file }, rootedContext);
    expect(result.buffer.toString()).toBe("hello");
    expect(result.filename).toBe("report.txt");
  });

  it("allows a normal file when no fileReadRoots is configured", () => {
    const file = path.join(tmpHome, "plain.txt");
    fs.writeFileSync(file, "plain content");
    const result = transfer.resolveFileSpec({ file }, fakeContext());
    expect(result.buffer.toString()).toBe("plain content");
  });

  it("refuses a host path outside Cuttlefish-managed storage when no roots are configured", () => {
    const outside = path.join(os.tmpdir(), `cuttlefish-transfer-host-${Date.now()}.txt`);
    fs.writeFileSync(outside, "plain content");
    expect(() => transfer.resolveFileSpec({ file: outside }, fakeContext())).toThrow(/fileReadRoots/);
  });
});

describe("remote transfer response bounds", () => {
  it("sets a transfer timeout and rejects an oversized remote response", async () => {
    const file = path.join(tmpHome, "bounded-transfer.txt");
    fs.writeFileSync(file, "payload");
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("x".repeat(1024 * 1024 + 1), { status: 200 }),
    ));
    const output: { status?: number; body?: string } = {};
    const response = {
      writeHead(status: number) { output.status = status; return response; },
      end(body?: string) { output.body = body; return response; },
    } as unknown as ServerResponse;
    const request = Readable.from([Buffer.from(JSON.stringify({
      destination: "fixture",
      file,
    }))]) as unknown as IncomingMessage;
    const context = fakeContext({
      getConfig: () => ({
        gateway: {},
        remotes: { fixture: { url: "https://remote.example" } },
      }),
      emit: vi.fn(),
    });

    await transfer.handleTransfer(request, response, context);

    expect(timeoutSpy).toHaveBeenCalledWith(transfer.REMOTE_TRANSFER_TIMEOUT_MS);
    expect(output.status).toBe(200);
    const payload = JSON.parse(output.body!);
    expect(payload.summary).toEqual({ ok: 0, failed: 1, total: 1 });
    expect(payload.results[0].error).toMatch(/exceeded 1048576 bytes/);
  });
});
