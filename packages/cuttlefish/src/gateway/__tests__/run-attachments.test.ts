import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

const { home: tmpHome } = withStaticTempCuttlefishHome("cuttlefish-run-attachments-");

type Api = typeof import("../api.js");
type Reg = typeof import("../../sessions/registry.js");
type Attachments = typeof import("../run-attachments.js");

let api: Api;
let reg: Reg;
let attachments: Attachments;

beforeAll(async () => {
  api = await import("../api.js");
  reg = await import("../../sessions/registry.js");
  attachments = await import("../run-attachments.js");
  reg.initDb();
});

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number) {
      status = s;
      return this;
    },
    end(buf?: Buffer | string) {
      if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get body() {
      const raw = Buffer.concat(chunks).toString("utf-8");
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    },
  };
}

function makeReq(method: string, urlPath: string) {
  return {
    method,
    url: urlPath,
    headers: { host: "localhost" },
  } as any;
}

function makeJsonReq(method: string, urlPath: string, body: unknown) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as any;
  Object.assign(req, {
    method,
    url: urlPath,
    headers: {
      host: "localhost",
      "content-type": "application/json",
    },
  });
  return req;
}

function makeCtx() {
  return {
    getConfig: () => ({ gateway: {}, engines: { default: "claude" }, portal: {} }),
    connectors: new Map(),
    startTime: Date.now(),
    emit: () => {},
    sessionManager: {
      getEngine: () => undefined,
      getQueue: () => ({
        getPendingCount: () => 0,
        getTransportState: (_key: string, status: string) => status,
      }),
    },
  } as unknown as import("../api.js").ApiContext;
}

describe("run attachment normalization", () => {
  it("resolves artifact IDs, local files, folders, and URLs into normalized attachments", async () => {
    const filePath = path.join(tmpHome, "spec.pdf");
    const folderPath = path.join(tmpHome, "inputs");
    fs.writeFileSync(filePath, "pdf bytes");
    fs.mkdirSync(folderPath, { recursive: true });

    reg.insertFile({
      id: "artifact-file",
      filename: "spec.pdf",
      size: Buffer.byteLength("pdf bytes"),
      mimetype: "application/pdf",
      path: filePath,
      artifactKind: "generated",
      producingRunId: "run-a",
    });

    const resolved = await attachments.resolveIncomingRunAttachments([
      "artifact-file",
      { path: filePath, intendedUse: "review the source pdf" },
      { path: folderPath, access: "writable", intendedUse: "write outputs here" },
      { url: "https://example.com/report.csv", intendedUse: "reference only" },
    ], makeCtx());

    expect(resolved).toEqual([
      expect.objectContaining({ kind: "artifact", artifactId: "artifact-file", producingRunId: "run-a" }),
      expect.objectContaining({ kind: "file", path: filePath, artifactId: "artifact-file", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ kind: "folder", path: folderPath, access: "writable", sha256: null }),
      expect.objectContaining({ kind: "url", url: "https://example.com/report.csv", intendedUse: "reference only" }),
    ]);

    const dispatch = attachments.buildResolvedRunAttachments(resolved);
    expect(dispatch.engineAttachments).toEqual([filePath]);
    expect(dispatch.promptBlock).toContain("Attached resources:");
    expect(dispatch.promptBlock).toContain("https://example.com/report.csv");
    expect(dispatch.promptBlock).toContain(folderPath);
  });
});

describe("session resource routes", () => {
  it("persists run resources on a session and lists them via /api/sessions/:id/resources", async () => {
    const ctx = makeCtx();
    const sourceFile = path.join(tmpHome, "handoff.txt");
    fs.writeFileSync(sourceFile, "handoff");

    const created = makeRes();
    await api.handleApiRequest(
      makeJsonReq("POST", "/api/sessions", {
        prompt: "Use these resources",
        resources: [
          { path: sourceFile, intendedUse: "read this first" },
          { url: "https://example.com/context", intendedUse: "background context" },
        ],
      }),
      created.res,
      ctx,
    );

    expect(created.status).toBe(201);
    expect(created.body).toEqual(expect.objectContaining({
      attachments: expect.arrayContaining([
        expect.objectContaining({ kind: "file", path: sourceFile, intendedUse: "read this first" }),
        expect.objectContaining({ kind: "url", url: "https://example.com/context", intendedUse: "background context" }),
      ]),
    }));

    const listed = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/sessions/${created.body.id}/resources`), listed.res, ctx);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({
      attachments: expect.arrayContaining([
        expect.objectContaining({ kind: "file", path: sourceFile }),
        expect.objectContaining({ kind: "url", url: "https://example.com/context" }),
      ]),
    });

    const attached = makeRes();
    await api.handleApiRequest(
      makeJsonReq("POST", `/api/sessions/${created.body.id}/resources`, {
        resources: [{ path: tmpHome, access: "writable", intendedUse: "workspace root" }],
      }),
      attached.res,
      ctx,
    );
    expect(attached.status).toBe(201);
    expect(attached.body.attachments).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "folder", path: tmpHome, access: "writable" })]),
    );
  });
});
