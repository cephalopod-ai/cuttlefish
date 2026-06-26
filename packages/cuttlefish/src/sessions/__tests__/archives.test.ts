import { describe, it, expect, beforeAll, vi } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const { home: tmp } = withStaticTempCuttlefishHome("cuttlefish-archives-");

type Api = typeof import("../../gateway/api.js");
type Reg = typeof import("../registry.js");

let api: Api;
let reg: Reg;

beforeAll(async () => {
  reg = await import("../registry.js");
  api = await import("../../gateway/api.js");
  reg.initDb();
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
    get body() {
      const raw = Buffer.concat(chunks).toString("utf-8");
      try { return JSON.parse(raw); } catch { return raw; }
    },
  };
}

function makeReq(method: string, urlPath: string, body?: unknown) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(chunks) as unknown as Parameters<Api["handleApiRequest"]>[0];
  Object.assign(req, {
    method,
    url: urlPath,
    headers: { host: "localhost", "content-type": "application/json" },
  });
  return req;
}

function makeCtx(events: Array<{ event: string; payload: unknown }> = []) {
  const clearQueue = vi.fn();
  return {
    getConfig: () => ({ gateway: {}, engines: {} }),
    connectors: new Map(),
    startTime: Date.now(),
    emit: (event: string, payload: unknown) => events.push({ event, payload }),
    sessionManager: {
      getEngine: () => undefined,
      getQueue: () => ({
        clearQueue,
        getPendingCount: () => 0,
        getTransportState: () => "idle",
      }),
    },
  } as unknown as import("../../gateway/api.js").ApiContext;
}

describe("project archives registry", () => {
  it("persists session snapshots with transcripts and lists summaries newest first", () => {
    const first = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:archive-a",
      employee: "gepetto",
      model: "opus",
      prompt: "Build a chair",
      parentSessionId: "parent-1",
    });
    reg.insertMessage(first.id, "user", "Build a chair");
    reg.insertMessage(first.id, "assistant", "Here is a plan", [
      { type: "file", url: "/api/files/plan", name: "plan.md" },
    ]);
    reg.insertPartialMessage(first.id, "assistant", "ran ls", 1, "Bash");

    const second = reg.createSession({
      engine: "codex",
      source: "cron",
      sourceRef: "cron:daily",
      title: "Daily run",
    });
    reg.insertMessage(second.id, "assistant", "Cron complete");

    const snapshots = reg.snapshotSessions([first.id, "missing", second.id]);
    expect(snapshots.map((s) => s.id)).toEqual([first.id, second.id]);
    expect(snapshots[0].messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    expect(snapshots[0].messages[1].media?.[0].name).toBe("plan.md");
    expect(snapshots[0].messages[2].toolCall).toBe("Bash");

    const archive = reg.createArchive({
      kind: "room",
      sourceRef: "woodshop",
      label: "Woodshop build",
      note: "Completed prototype",
      sessions: snapshots,
    });

    const summaries = reg.listArchives();
    expect(summaries[0]).toMatchObject({
      id: archive.id,
      label: "Woodshop build",
      kind: "room",
      sourceRef: "woodshop",
      sessionCount: 2,
    });
    expect("sessions" in summaries[0]).toBe(false);

    const detail = reg.getArchive(archive.id);
    expect(detail?.sessions).toHaveLength(2);
    expect(detail?.sessions[0].messages[0].content).toBe("Build a chair");
    expect(detail?.sessions[1].title).toBe("Daily run");

    expect(reg.deleteArchive(archive.id)).toBe(true);
    expect(reg.getArchive(archive.id)).toBeUndefined();
  });
});

describe("project archives API", () => {
  it("GET /api/archives returns newest-first summaries", async () => {
    const first = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:list-a",
      title: "Archive list A",
    });
    const second = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:list-b",
      title: "Archive list B",
    });
    const older = reg.createArchive({ kind: "chat", label: "Older archive", sessions: reg.snapshotSessions([first.id]) });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = reg.createArchive({ kind: "chat", label: "Newer archive", sessions: reg.snapshotSessions([second.id]) });

    const cap = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/archives"), cap.res, makeCtx());

    expect(cap.status).toBe(200);
    expect(cap.body).toEqual([
      expect.objectContaining({ id: newer.id, label: "Newer archive" }),
      expect.objectContaining({ id: older.id, label: "Older archive" }),
    ]);
  });

  it("POST /api/archives snapshots then deletes live sessions", async () => {
    const session = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:archive-route",
      title: "Route archive",
    });
    reg.insertMessage(session.id, "user", "archive this route");
    reg.enqueueQueueItem(session.id, session.sessionKey, "queued prompt");

    const events: Array<{ event: string; payload: unknown }> = [];
    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("POST", "/api/archives", {
        kind: "chat",
        sessionIds: [session.id],
        label: "Saved chat",
        note: "Route coverage",
      }),
      cap.res,
      makeCtx(events),
    );

    expect(cap.status).toBe(200);
    expect(cap.body).toMatchObject({ kind: "chat", label: "Saved chat", sessionCount: 1 });
    expect(reg.getSession(session.id)).toBeUndefined();

    const detail = reg.getArchive((cap.body as { id: string }).id);
    expect(detail?.sessions[0].messages[0].content).toBe("archive this route");
    expect(events.map((e) => e.event)).toContain("archive:created");
    expect(events.map((e) => e.event)).toContain("session:deleted");

    const missing = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/sessions/${session.id}`), missing.res, makeCtx());
    expect(missing.status).toBe(404);
  });

  it("rolls back archive creation if live-session deletion fails", async () => {
    const session = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:archive-rollback",
      title: "Archive rollback",
    });
    reg.insertMessage(session.id, "user", "keep this session live");
    reg.enqueueQueueItem(session.id, session.sessionKey, "queued prompt");

    const beforeCount = reg.listArchives().length;
    const db = reg.initDb();
    const originalPrepare = db.prepare.bind(db);
    const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("DELETE FROM sessions WHERE id IN")) {
        throw new Error("injected archive delete failure");
      }
      return originalPrepare(sql);
    });

    try {
      const cap = makeRes();
      await api.handleApiRequest(
        makeReq("POST", "/api/archives", {
          kind: "chat",
          sessionIds: [session.id],
          label: "Should roll back",
        }),
        cap.res,
        makeCtx(),
      );

      expect(cap.status).toBe(500);
      expect(reg.getSession(session.id)?.id).toBe(session.id);
      expect(reg.getMessages(session.id)).toHaveLength(1);
      expect(reg.getQueueItems(session.sessionKey)).toHaveLength(1);
      expect(reg.listArchives()).toHaveLength(beforeCount);
    } finally {
      prepareSpy.mockRestore();
    }
  });

  it("validates archive creation requests", async () => {
    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("POST", "/api/archives", { kind: "room", sessionIds: [] }),
      cap.res,
      makeCtx(),
    );
    expect(cap.status).toBe(400);
  });

  it("DELETE /api/archives/:id removes an archive and returns 404 when missing", async () => {
    const session = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:archive-delete",
      title: "Archive delete",
    });
    const archive = reg.createArchive({ kind: "chat", label: "Delete me", sessions: reg.snapshotSessions([session.id]) });

    const cap = makeRes();
    await api.handleApiRequest(makeReq("DELETE", `/api/archives/${archive.id}`), cap.res, makeCtx());
    expect(cap.status).toBe(200);
    expect(cap.body).toEqual({ status: "deleted" });
    expect(reg.getArchive(archive.id)).toBeUndefined();

    const missing = makeRes();
    await api.handleApiRequest(makeReq("DELETE", `/api/archives/${archive.id}`), missing.res, makeCtx());
    expect(missing.status).toBe(404);
  });
});
