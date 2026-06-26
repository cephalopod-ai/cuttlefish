import { describe, it, expect, beforeAll } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import type { ServerResponse } from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const { home: tmp } = withStaticTempCuttlefishHome("cuttlefish-work-");

type Api = typeof import("../api.js");
type Approvals = typeof import("../approvals.js");
type Reg = typeof import("../../sessions/registry.js");
let api: Api;
let store: Approvals;
let reg: Reg;

beforeAll(async () => {
  api = await import("../api.js");
  store = await import("../approvals.js");
  reg = await import("../../sessions/registry.js");
  reg.initDb();
  store.__setApprovalsStoreForTest(path.join(tmp, "approvals.json"));
});

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number) { status = s; return this; },
    end(buf?: Buffer | string) { if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)); },
  } as unknown as ServerResponse;
  return {
    res,
    get status() { return status; },
    get body() { try { return JSON.parse(Buffer.concat(chunks).toString("utf-8")); } catch { return null; } },
  };
}
function makeReq(method: string, urlPath: string) {
  return { method, url: urlPath, headers: { host: "localhost" } } as unknown as Parameters<Api["handleApiRequest"]>[0];
}

describe("GET /api/work", () => {
  it("normalizes sessions into work-state counts (approval beats running)", async () => {
    // status-driven states; queue stub returns idle transport (so status rules).
    const running = reg.createSession({ engine: "claude", source: "web", sourceRef: "w:run", prompt: "x" });
    reg.updateSession(running.id, { status: "running" });
    const errored = reg.createSession({ engine: "claude", source: "web", sourceRef: "w:err", prompt: "x" });
    reg.updateSession(errored.id, { status: "error" });
    const waiting = reg.createSession({ engine: "claude", source: "web", sourceRef: "w:wait", prompt: "x" });
    reg.updateSession(waiting.id, { status: "waiting" });
    const idle = reg.createSession({ engine: "claude", source: "web", sourceRef: "w:idle", prompt: "x" });
    reg.updateSession(idle.id, { status: "idle" });
    // A session with a pending approval must classify as waiting_on_human even
    // though its status is "running".
    const gated = reg.createSession({ engine: "claude", source: "web", sourceRef: "w:gate", prompt: "x" });
    reg.updateSession(gated.id, { status: "running" });
    store.createApproval({ sessionId: gated.id, type: "fallback", payload: {} });

    const ctx = {
      getConfig: () => ({ gateway: {}, engines: {} }),
      emit: () => {},
      sessionManager: {
        getQueue: () => ({ getTransportState: (_k: string, s: string) => s, getPendingCount: () => 0 }),
      },
    } as unknown as import("../api.js").ApiContext;

    const cap = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/work"), cap.res, ctx);
    expect(cap.status).toBe(200);
    const body = cap.body as { counts: Record<string, number>; items: unknown[] };
    expect(body.counts.running).toBe(1);          // `running` (gated re-classified)
    expect(body.counts.failed).toBe(1);           // errored
    expect(body.counts.blocked).toBe(1);          // waiting (non-approval)
    expect(body.counts.completed).toBe(1);        // idle
    expect(body.counts.waiting_on_human).toBe(1); // gated (approval beats running)
    expect(body.items.length).toBe(5);
  });
});
