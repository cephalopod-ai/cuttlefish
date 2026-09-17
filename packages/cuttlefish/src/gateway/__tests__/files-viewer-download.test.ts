import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

const { home } = withStaticTempCuttlefishHome("cuttlefish-viewer-download-");
let files: typeof import("../files.js");
beforeAll(async () => { files = await import("../files.js"); });

async function read(filename: string, download = true) {
  const out: { status?: number; headers?: Record<string, unknown>; body?: Buffer } = {};
  const req = { url: `/api/files/read?path=${encodeURIComponent(filename)}${download ? "&download=1" : ""}`, headers: { host: "localhost" } } as IncomingMessage;
  const res = {
    writeHead(status: number, headers?: Record<string, unknown>) { out.status = status; out.headers = headers; },
    end(body?: string | Buffer) { out.body = Buffer.isBuffer(body) ? body : Buffer.from(body ?? ""); },
  } as unknown as ServerResponse;
  await files.handleFilesRequest(req, res, "/api/files/read", "GET", { getConfig: () => ({}) } as unknown as import("../api/context.js").ApiContext);
  return out;
}

function fixture(filename: string, content: string | Buffer) {
  const target = path.join(home, "files", filename);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

describe("file viewer download representation", () => {
  it("downloads exact binary bytes instead of classification JSON", async () => {
    const bytes = Buffer.from([0x50, 0x4b, 3, 4, 0, 1, 2]);
    const out = await read(fixture("owned α #1.zip", bytes));
    expect(out.status).toBe(200);
    expect(out.body).toEqual(bytes);
    expect(out.headers).toMatchObject({ "Content-Type": "application/zip", "Content-Length": bytes.length, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
    expect(out.headers?.["Content-Disposition"]).toContain("attachment;");
    expect(out.headers?.["Content-Disposition"]).toContain(encodeURIComponent("owned α #1.zip"));
  });

  it("retains the existing text redaction when downloading a readable text file", async () => {
    const target = fixture("config-note.txt", "Owned α🙂\nAuthorization: Bearer sk-test-download-secret-value\n");
    const preview = await read(target, false);
    const expected = JSON.parse(preview.body!.toString()).content;
    expect(expected).not.toContain("sk-test-download-secret-value");
    const download = await read(target);
    expect(download.body!.toString()).toBe(expected);
    expect(download.headers?.["Content-Length"]).toBe(Buffer.byteLength(expected));
  });

  it("preserves JSON classification for ordinary preview requests", async () => {
    const out = await read(fixture("preview.zip", Buffer.from([0x50, 0x4b, 0])), false);
    expect(out.headers?.["Content-Type"]).toBe("application/json");
    expect(JSON.parse(out.body!.toString())).toMatchObject({ binary: true, mime: "application/zip", size: 3 });
  });

  it("preserves sensitive-file denial in download mode", async () => {
    const target = path.join(home, "config.yaml");
    fs.writeFileSync(target, "engines: {}\n");
    const out = await read(target);
    expect(out.status).toBe(403);
    expect(out.headers?.["Content-Type"]).toBe("application/json");
  });

  it("preserves the read-size cap in download mode", async () => {
    const out = await read(fixture("large.zip", Buffer.alloc(5 * 1024 * 1024 + 1)));
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body!.toString())).toMatchObject({ tooLarge: true });
    expect(out.headers?.["Content-Disposition"]).toBeUndefined();
  });
});
