import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

const { home: tmp } = withStaticTempCuttlefishHome("cuttlefish-artifacts-");

type Api = typeof import("../api.js");
type Reg = typeof import("../../sessions/registry.js");
type Routes = typeof import("../api/routes/artifacts.js");

let api: Api;
let reg: Reg;
let routes: Routes;

beforeAll(async () => {
  api = await import("../api.js");
  reg = await import("../../sessions/registry.js");
  routes = await import("../api/routes/artifacts.js");
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

function getReq(pathname: string): import("node:http").IncomingMessage {
  return {
    method: "GET",
    url: pathname,
    headers: { host: "localhost" },
  } as unknown as import("node:http").IncomingMessage;
}

function captureRes() {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  const out: { status?: number; body?: Buffer; done: Promise<void> } = { done };
  const chunks: Buffer[] = [];
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  });
  const endWritable = writable.end.bind(writable) as (...args: unknown[]) => void;
  const res = Object.assign(writable, {
    writeHead(status: number) {
      out.status = status;
      return res;
    },
    end(body?: unknown, ...args: unknown[]) {
      if (body !== undefined) chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
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

function parse(body: Buffer | undefined): any {
  return JSON.parse((body ?? Buffer.alloc(0)).toString("utf-8"));
}

describe("artifact registry routes", () => {
  it("registers an existing generated file with hash, run metadata, tags, and bundle visibility", async () => {
    const produced = path.join(tmp, "runs", "sess-1", "report.txt");
    fs.mkdirSync(path.dirname(produced), { recursive: true });
    fs.writeFileSync(produced, "artifact body");

    const registered = captureRes();
    const registerUrl = new URL("/api/artifacts/register", "http://localhost");
    await routes.handleArtifactRoutes(
      "POST",
      "/api/artifacts/register",
      jsonReq("POST", "/api/artifacts/register", {
        path: produced,
        producingRunId: "sess-1",
        tags: ["report", "final"],
        notes: "human-readable output",
      }),
      registerUrl,
      registered.res,
      ctx,
    );
    await registered.out.done;

    expect(registered.out.status).toBe(201);
    const artifact = parse(registered.out.body);
    expect(artifact).toMatchObject({
      filename: "report.txt",
      artifactKind: "generated",
      producingRunId: "sess-1",
      tags: ["report", "final"],
      existsOnDisk: true,
    });
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);

    const list = captureRes();
    const listUrl = new URL("/api/artifacts?runId=sess-1&tag=report", "http://localhost");
    await routes.handleArtifactRoutes("GET", "/api/artifacts", getReq(listUrl.pathname + listUrl.search), listUrl, list.res, ctx);
    await list.out.done;
    expect(parse(list.out.body).artifacts).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: artifact.id, producingRunId: "sess-1" })]),
    );

    const bundle = captureRes();
    const bundleUrl = new URL("/api/artifacts/bundle?runId=sess-1", "http://localhost");
    await routes.handleArtifactRoutes("GET", "/api/artifacts/bundle", getReq(bundleUrl.pathname + bundleUrl.search), bundleUrl, bundle.res, ctx);
    await bundle.out.done;
    expect(parse(bundle.out.body)).toMatchObject({
      kind: "cuttlefish.runBundleManifest",
      runId: "sess-1",
      artifacts: [expect.objectContaining({ id: artifact.id, downloadUrl: `/api/files/${artifact.id}` })],
    });
  });

  it("rejects a register id that would escape FILES_DIR as a path segment", async () => {
    const source = path.join(tmp, "evil-id-source.txt");
    fs.writeFileSync(source, "x");
    const res = captureRes();
    const url = new URL("/api/artifacts/register", "http://localhost");
    await routes.handleArtifactRoutes(
      "POST",
      "/api/artifacts/register",
      jsonReq("POST", "/api/artifacts/register", { path: source, id: ".." }),
      url,
      res.res,
      ctx,
    );
    await res.out.done;
    expect(res.out.status).toBe(400);
    // The poisoned id must never enter the registry (it feeds FILES_DIR/<id>).
    expect(reg.getFile("..")).toBeFalsy();
  });

  it("validates expected artifact IDs and paths against registry and disk state", async () => {
    const source = path.join(tmp, "validate-output.txt");
    fs.writeFileSync(source, "ok");
    const meta = reg.insertFile({
      id: "validate-artifact",
      filename: "validate-output.txt",
      size: 2,
      mimetype: "text/plain",
      path: source,
      sha256: "abc",
      artifactKind: "generated",
      producingRunId: "sess-validate",
    });

    const validated = captureRes();
    const url = new URL("/api/artifacts/validate", "http://localhost");
    await routes.handleArtifactRoutes(
      "POST",
      "/api/artifacts/validate",
      jsonReq("POST", "/api/artifacts/validate", {
        ids: [meta.id, "missing-id"],
        paths: [source, path.join(tmp, "missing.txt")],
      }),
      url,
      validated.res,
      ctx,
    );
    await validated.out.done;

    const payload = parse(validated.out.body);
    expect(payload.ok).toBe(false);
    expect(payload.ids).toEqual([
      expect.objectContaining({ requested: meta.id, found: true, existsOnDisk: true }),
      expect.objectContaining({ requested: "missing-id", found: false, existsOnDisk: false }),
    ]);
    expect(payload.paths).toEqual([
      expect.objectContaining({ requested: source, found: true, existsOnDisk: true }),
      expect.objectContaining({ found: false, existsOnDisk: false }),
    ]);
  });

  it("exposes artifact metadata through the main API router", async () => {
    const source = path.join(tmp, "api-router.txt");
    fs.writeFileSync(source, "router");
    reg.insertFile({
      id: "router-artifact",
      filename: "api-router.txt",
      size: 6,
      mimetype: "text/plain",
      path: source,
      artifactKind: "manual",
    });

    const res = captureRes();
    await api.handleApiRequest(getReq("/api/artifacts/router-artifact"), res.res, ctx);
    await res.out.done;
    expect(res.out.status).toBe(200);
    expect(parse(res.out.body)).toMatchObject({
      id: "router-artifact",
      artifactKind: "manual",
      existsOnDisk: true,
    });
  });
});
