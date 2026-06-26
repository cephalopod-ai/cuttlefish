import { describe, it, expect, beforeAll } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";

const { home: tmp } = withStaticTempCuttlefishHome("cuttlefish-cache-");

type Files = typeof import("../files.js");
type Reg = typeof import("../../sessions/registry.js");
type Paths = typeof import("../../shared/paths.js");

let files: Files;
let reg: Reg;
let paths: Paths;

beforeAll(async () => {
  paths = await import("../../shared/paths.js");
  reg = await import("../../sessions/registry.js");
  files = await import("../files.js");
  reg.initDb();
});

describe("file cache helpers", () => {
  it("fileEtag is a strong tag from id + size", () => {
    expect(files.fileEtag("abc", 123)).toBe('"abc-123"');
  });

  it("isFileNotModified matches on If-None-Match (incl. weak prefix, lists, and *)", () => {
    const etag = '"abc-123"';
    expect(files.isFileNotModified({ "if-none-match": etag }, etag, 0)).toBe(true);
    expect(files.isFileNotModified({ "if-none-match": `W/${etag}` }, etag, 0)).toBe(true);
    expect(files.isFileNotModified({ "if-none-match": `"x-1", ${etag}` }, etag, 0)).toBe(true);
    expect(files.isFileNotModified({ "if-none-match": "*" }, etag, 0)).toBe(true);
    expect(files.isFileNotModified({ "if-none-match": '"other-9"' }, etag, 0)).toBe(false);
  });

  it("isFileNotModified honors If-Modified-Since at second precision", () => {
    const mtime = Date.parse("2026-05-30T12:00:00.000Z");
    expect(files.isFileNotModified({ "if-modified-since": "Sat, 30 May 2026 12:00:00 GMT" }, '"e"', mtime)).toBe(true);
    expect(files.isFileNotModified({ "if-modified-since": "Sat, 30 May 2026 11:59:59 GMT" }, '"e"', mtime)).toBe(false);
  });
});

// ── HTTP-level: GET returns 200 + cache headers, conditional GET returns 304 ──

function fakeReq(headers: Record<string, string>) {
  return { headers } as unknown as import("node:http").IncomingMessage;
}
function fakeRes() {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const out: { status?: number; headers?: Record<string, unknown>; ended?: boolean; body?: unknown; done: Promise<void> } = { done };
  const writable = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const endWritable = writable.end.bind(writable) as (...args: unknown[]) => void;
  const res = Object.assign(writable, {
    writeHead(status: number, headers?: Record<string, unknown>) {
      out.status = status;
      out.headers = headers;
      return res;
    },
    end(body?: unknown, ...args: unknown[]) {
      out.ended = true;
      out.body = body;
      endWritable(body, ...args);
      resolveDone();
      return res;
    },
  }) as unknown as import("node:http").ServerResponse;
  return { res, out };
}
const ctx = { emit: () => {} } as unknown as import("../api.js").ApiContext;

describe("GET /api/files/:id caching", () => {
  let id: string;
  let etag: string;

  beforeAll(() => {
    id = "cachefile";
    const dir = path.join(paths.FILES_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    const bytes = Buffer.from("cacheable-bytes");
    fs.writeFileSync(path.join(dir, "pic.png"), bytes);
    reg.insertFile({ id, filename: "pic.png", size: bytes.length, mimetype: "image/png", path: null });
    etag = files.fileEtag(id, bytes.length);
  });

  it("first GET returns 200 with immutable Cache-Control, ETag, Last-Modified + download header", async () => {
    const { res, out } = fakeRes();
    await files.handleFilesRequest(fakeReq({}), res, `/api/files/${id}`, "GET", ctx);
    await out.done;
    expect(out.status).toBe(200);
    expect(out.headers!["Cache-Control"]).toBe("public, max-age=31536000, immutable");
    expect(out.headers!["ETag"]).toBe(etag);
    expect(out.headers!["Last-Modified"]).toBeTruthy();
    // caching is orthogonal — the download disposition is still set
    expect(String(out.headers!["Content-Disposition"])).toContain("attachment");
  });

  it("conditional GET with matching If-None-Match returns 304 and no body", async () => {
    const { res, out } = fakeRes();
    await files.handleFilesRequest(fakeReq({ "if-none-match": etag }), res, `/api/files/${id}`, "GET", ctx);
    expect(out.status).toBe(304);
    expect(out.headers!["ETag"]).toBe(etag);
    expect(out.headers!["Cache-Control"]).toBe("public, max-age=31536000, immutable");
    expect(out.body).toBeUndefined(); // res.end() called with no payload
  });
});
