import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { readSingleFileMultipart, collectTagFields, firstField } from "../files/multipart.js";

const BOUNDARY = "----cuttlefishtestboundary";

interface Part {
  name: string;
  value: string | Buffer;
  filename?: string;
}

function multipartBody(parts: Part[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition = part.filename
      ? `form-data; name="${part.name}"; filename="${part.filename}"`
      : `form-data; name="${part.name}"`;
    const headers =
      `--${BOUNDARY}\r\n` +
      `Content-Disposition: ${disposition}\r\n` +
      (part.filename ? "Content-Type: application/octet-stream\r\n" : "") +
      "\r\n";
    chunks.push(Buffer.from(headers), Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value), Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

/** A request carrying `body`, optionally lying about (or omitting) Content-Length. */
function request(body: Buffer, opts: { contentLength?: number | null } = {}): IncomingMessage {
  const stream = Readable.from([body]) as unknown as IncomingMessage;
  const declared = opts.contentLength === undefined ? body.length : opts.contentLength;
  stream.headers = {
    "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
    ...(declared === null ? {} : { "content-length": String(declared) }),
  };
  return stream;
}

const MB = 1024 * 1024;

describe("readSingleFileMultipart — every limit refuses instead of truncating (UPS-A2)", () => {
  it("reads one file part and its fields", async () => {
    const body = multipartBody([
      { name: "file", value: "hello bytes", filename: "note.txt" },
      { name: "caption", value: "a caption" },
      { name: "tag", value: "one" },
      { name: "tags", value: "two, three" },
    ]);

    const outcome = await readSingleFileMultipart(request(body), { maxFileBytes: 1 * MB });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.filename).toBe("note.txt");
    expect(outcome.buffer.toString()).toBe("hello bytes");
    expect(firstField(outcome.fields, "caption")).toBe("a caption");
    expect(collectTagFields(outcome.fields)).toEqual(["one", "two", "three"]);
  });

  it("refuses a second file part rather than letting it displace the first", async () => {
    const body = multipartBody([
      { name: "file", value: "first", filename: "first.txt" },
      { name: "file", value: "second", filename: "second.txt" },
    ]);

    const outcome = await readSingleFileMultipart(request(body), { maxFileBytes: 1 * MB });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(400);
    expect(outcome.reason).toMatch(/one file part/i);
  });

  it("refuses an oversized file part instead of returning a truncated buffer", async () => {
    const body = multipartBody([{ name: "file", value: "x".repeat(512), filename: "big.txt" }]);

    const outcome = await readSingleFileMultipart(request(body), { maxFileBytes: 64 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(413);
  });

  it("refuses on the declared Content-Length before reading the body", async () => {
    const body = multipartBody([{ name: "file", value: "small", filename: "s.txt" }]);
    // Declares far more than the ceiling allows; the body itself is tiny.
    const outcome = await readSingleFileMultipart(
      request(body, { contentLength: 100 * MB }),
      { maxFileBytes: 64, overheadBytes: 128 },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(413);
  });

  it("bounds a body that declares no Content-Length at all", async () => {
    // Every individual part is inside its own limit — the file is 1 KiB against
    // a 4 KiB file cap, each field is 1 KiB against the 64 KiB field cap, and
    // there are only six of them. Just the *total* exceeds the request ceiling,
    // so nothing but the streaming counter can refuse this.
    const parts: Part[] = [{ name: "file", value: "y".repeat(1024), filename: "y.txt" }];
    for (let i = 0; i < 6; i++) parts.push({ name: `f${i}`, value: "z".repeat(1024) });

    const outcome = await readSingleFileMultipart(
      request(multipartBody(parts), { contentLength: null }),
      { maxFileBytes: 4096, overheadBytes: 16 },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(413);
  });

  it("refuses more fields than the ceiling allows", async () => {
    const parts: Part[] = [{ name: "file", value: "ok", filename: "ok.txt" }];
    for (let i = 0; i < 10; i++) parts.push({ name: `f${i}`, value: "v" });

    const outcome = await readSingleFileMultipart(request(multipartBody(parts)), {
      maxFileBytes: 1 * MB,
      maxFields: 3,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(400);
    expect(outcome.reason).toMatch(/fields/i);
  });

  it("refuses an oversized field value rather than storing a truncated one", async () => {
    const body = multipartBody([
      { name: "file", value: "ok", filename: "ok.txt" },
      { name: "notes", value: "n".repeat(4096) },
    ]);

    const outcome = await readSingleFileMultipart(request(body), {
      maxFileBytes: 1 * MB,
      maxFieldBytes: 128,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(413);
    expect(outcome.reason).toMatch(/notes/);
  });

  it("refuses more parts than the ceiling allows", async () => {
    const parts: Part[] = [{ name: "file", value: "ok", filename: "ok.txt" }];
    for (let i = 0; i < 10; i++) parts.push({ name: `p${i}`, value: "v" });

    const outcome = await readSingleFileMultipart(request(multipartBody(parts)), {
      maxFileBytes: 1 * MB,
      maxParts: 3,
      maxFields: 64,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(400);
    expect(outcome.reason).toMatch(/parts/i);
  });

  it("settles rather than hanging when the client disconnects mid-body", async () => {
    // A truncated body: headers and a boundary, but no terminator.
    const truncated = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="x.txt"\r\n\r\npartial`,
    );
    const stream = Readable.from([truncated]) as unknown as IncomingMessage;
    stream.headers = { "content-type": `multipart/form-data; boundary=${BOUNDARY}` };
    // Node marks a request complete only once its body has fully arrived.
    Object.defineProperty(stream, "complete", { value: false, configurable: true });

    const outcome = await readSingleFileMultipart(stream, { maxFileBytes: 1 * MB });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(400);
  });

  it("refuses a body with no file part", async () => {
    const outcome = await readSingleFileMultipart(request(multipartBody([{ name: "caption", value: "only a field" }])), {
      maxFileBytes: 1 * MB,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("No file provided");
  });

  it("honours an explicit file field-name pin when a caller asks for one", async () => {
    const body = multipartBody([{ name: "payload", value: "bytes", filename: "p.txt" }]);
    const outcome = await readSingleFileMultipart(request(body), {
      maxFileBytes: 1 * MB,
      fileFieldName: "file",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toMatch(/must be named "file"/);
  });

  it("keeps accepting any field name when no pin is set (existing callers)", async () => {
    const body = multipartBody([{ name: "payload", value: "bytes", filename: "p.txt" }]);
    const outcome = await readSingleFileMultipart(request(body), { maxFileBytes: 1 * MB });
    expect(outcome.ok).toBe(true);
  });
});

describe("collectTagFields", () => {
  it("returns undefined when no tag fields were posted", () => {
    expect(collectTagFields(new Map())).toBeUndefined();
  });

  it("drops empty entries left by trailing commas", () => {
    expect(collectTagFields(new Map([["tags", ["a, ,b,"]]]))).toEqual(["a", "b"]);
  });
});
