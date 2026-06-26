import { beforeAll, describe, expect, it } from "vitest";
import { Readable, Writable } from "node:stream";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

const { home: _tmp } = withStaticTempCuttlefishHome("cuttlefish-files-facade-");

type Files = typeof import("../files.js");
type Reg = typeof import("../../sessions/registry.js");

let files: Files;
let reg: Reg;

beforeAll(async () => {
  reg = await import("../../sessions/registry.js");
  files = await import("../files.js");
  reg.initDb();
});

function jsonReq(method: string, pathname: string, body: unknown): import("node:http").IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as import("node:http").IncomingMessage;
  (req as unknown as { method: string }).method = method;
  (req as unknown as { url: string }).url = pathname;
  (req as unknown as { headers: Record<string, string> }).headers = {
    host: "localhost",
    "content-type": "application/json",
  };
  return req;
}

function getReq(pathname: string, headers: Record<string, string> = {}): import("node:http").IncomingMessage {
  return {
    method: "GET",
    url: pathname,
    headers: { host: "localhost", ...headers },
  } as unknown as import("node:http").IncomingMessage;
}

function deleteReq(pathname: string): import("node:http").IncomingMessage {
  return {
    method: "DELETE",
    url: pathname,
    headers: { host: "localhost" },
  } as unknown as import("node:http").IncomingMessage;
}

function captureRes() {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  const out: { status?: number; headers?: Record<string, unknown>; body?: Buffer; done: Promise<void> } = { done };
  const chunks: Buffer[] = [];
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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
      if (body !== undefined) {
        chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
      }
      out.body = chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0);
      endWritable(body, ...args);
      resolveDone();
      return res;
    },
  }) as unknown as import("node:http").ServerResponse;
  writable.on("finish", () => {
    out.body = chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0);
    resolveDone();
  });
  return { res, out };
}

const ctx = {
  emit: () => {},
  getConfig: () => ({}),
} as unknown as import("../api.js").ApiContext;

describe("files facade seam", () => {
  it("preserves upload -> meta/list -> download/cache -> delete behavior through handleFilesRequest", async () => {
    const upload = captureRes();
    await files.handleFilesRequest(
      jsonReq("POST", "/api/files", {
        filename: "report.txt",
        content: Buffer.from("hello seam").toString("base64"),
      }),
      upload.res,
      "/api/files",
      "POST",
      ctx,
    );
    await upload.out.done;

    expect(upload.out.status).toBe(201);
    const meta = JSON.parse((upload.out.body ?? Buffer.alloc(0)).toString("utf-8")) as {
      id: string;
      filename: string;
      size: number;
    };
    expect(meta.filename).toBe("report.txt");
    expect(meta.size).toBe(Buffer.byteLength("hello seam"));

    const listed = captureRes();
    await files.handleFilesRequest(getReq("/api/files"), listed.res, "/api/files", "GET", ctx);
    await listed.out.done;
    expect(listed.out.status).toBe(200);
    expect(JSON.parse((listed.out.body ?? Buffer.alloc(0)).toString("utf-8"))).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: meta.id, filename: "report.txt" })]),
    );

    const metaRes = captureRes();
    await files.handleFilesRequest(getReq(`/api/files/${meta.id}/meta`), metaRes.res, `/api/files/${meta.id}/meta`, "GET", ctx);
    await metaRes.out.done;
    expect(metaRes.out.status).toBe(200);
    expect(JSON.parse((metaRes.out.body ?? Buffer.alloc(0)).toString("utf-8"))).toEqual(
      expect.objectContaining({ id: meta.id, filename: "report.txt" }),
    );

    const download = captureRes();
    await files.handleFilesRequest(getReq(`/api/files/${meta.id}`), download.res, `/api/files/${meta.id}`, "GET", ctx);
    await download.out.done;
    expect(download.out.status).toBe(200);
    expect(download.out.body?.toString("utf-8")).toContain("hello seam");
    expect(download.out.headers?.["ETag"]).toBe(files.fileEtag(meta.id, meta.size));

    const conditional = captureRes();
    await files.handleFilesRequest(
      getReq(`/api/files/${meta.id}`, { "if-none-match": String(download.out.headers?.["ETag"]) }),
      conditional.res,
      `/api/files/${meta.id}`,
      "GET",
      ctx,
    );
    expect(conditional.out.status).toBe(304);

    const deleted = captureRes();
    await files.handleFilesRequest(deleteReq(`/api/files/${meta.id}`), deleted.res, `/api/files/${meta.id}`, "DELETE", ctx);
    await deleted.out.done;
    expect(deleted.out.status).toBe(200);
    expect(JSON.parse((deleted.out.body ?? Buffer.alloc(0)).toString("utf-8"))).toEqual({ status: "deleted" });

    const missing = captureRes();
    await files.handleFilesRequest(getReq(`/api/files/${meta.id}`), missing.res, `/api/files/${meta.id}`, "GET", ctx);
    await missing.out.done;
    expect(missing.out.status).toBe(404);
  });
});
