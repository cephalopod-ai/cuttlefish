import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import type { ServerResponse } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

async function setup() {
  vi.resetModules();
  const api = await import("../api.js");
  const reg = await import("../../sessions/registry.js");
  reg.initDb();
  return { api, reg };
}

function makeCtx(api: Awaited<ReturnType<typeof setup>>["api"]) {
  return {
    getConfig: () => ({ gateway: {}, engines: {}, portal: {} }),
    connectors: new Map(),
    startTime: Date.now(),
    emit: vi.fn(),
    sessionManager: {
      getEngine: () => undefined,
      getQueue: () => ({
        getPendingCount: () => 0,
        getTransportState: (_key: string, status: string) => status,
        clearQueue: vi.fn(),
      }),
    },
  } as unknown as import("../api.js").ApiContext;
}

let tmpHome: string;
const testHome = withTempCuttlefishHome("cuttlefish-queue-cancel-scope-");

beforeEach(() => {
  tmpHome = testHome.home();
  vi.resetModules();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("DELETE /api/sessions/:id/queue/:itemId", () => {
  it("cannot cancel a pending queue item that belongs to another session", async () => {
    const { api, reg } = await setup();
    const ctx = makeCtx(api);
    const sessionA = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:a", prompt: "a" });
    const sessionB = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:b", prompt: "b" });
    const itemB = reg.enqueueQueueItem(sessionB.id, sessionB.sessionKey, "queued for b");

    const cap = makeRes();
    await api.handleApiRequest(makeReq("DELETE", `/api/sessions/${sessionA.id}/queue/${itemB}`), cap.res, ctx);

    expect(cap.status).toBe(409);
    expect(cap.body).toEqual({ error: "Item not found or already running" });
    expect(reg.getQueueItem(itemB)?.status).toBe("pending");
  }, 15_000);

  it("allows a session route to cancel its own pending queue item", async () => {
    const { api, reg } = await setup();
    const ctx = makeCtx(api);
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:owner", prompt: "owner" });
    const item = reg.enqueueQueueItem(session.id, session.sessionKey, "queued for owner");

    const cap = makeRes();
    await api.handleApiRequest(makeReq("DELETE", `/api/sessions/${session.id}/queue/${item}`), cap.res, ctx);

    expect(cap.status).toBe(200);
    expect(cap.body).toEqual({ status: "cancelled", itemId: item });
    expect(reg.getQueueItem(item)?.status).toBe("cancelled");
  }, 15_000);
});
