import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Point the DB at a throwaway dir BEFORE importing the registry (SESSIONS_DB is
// resolved from CUTTLEFISH_HOME at module load).
const { home: tmp } = withStaticTempCuttlefishHome("cuttlefish-delq-");

type Reg = typeof import("../registry.js");
let reg: Reg;

beforeAll(async () => {
  reg = await import("../registry.js");
  reg.initDb();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function queueRowCount(sessionId: string): number {
  const db = reg.initDb();
  const row = db
    .prepare("SELECT COUNT(*) as count FROM queue_items WHERE session_id = ?")
    .get(sessionId) as { count: number };
  return row.count;
}

function messageRowCount(sessionId: string): number {
  const db = reg.initDb();
  const row = db
    .prepare("SELECT COUNT(*) as count FROM messages WHERE session_id = ?")
    .get(sessionId) as { count: number };
  return row.count;
}

function sessionExists(sessionId: string): boolean {
  return Boolean(reg.getSession(sessionId));
}

describe("deleteSession/deleteSessions queue_items cleanup", () => {
  it("deleteSession removes the session's queue_items rows", () => {
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:delq-1" });
    reg.enqueueQueueItem(session.id, session.sessionKey, "queued prompt");
    expect(queueRowCount(session.id)).toBe(1);

    expect(reg.deleteSession(session.id)).toBe(true);
    expect(queueRowCount(session.id)).toBe(0);
  });

  it("deleteSessions removes queue_items for every deleted session", () => {
    const a = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:delq-2" });
    const b = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:delq-3" });
    reg.enqueueQueueItem(a.id, a.sessionKey, "a-1");
    reg.enqueueQueueItem(b.id, b.sessionKey, "b-1");

    expect(reg.deleteSessions([a.id, b.id])).toBe(2);
    expect(queueRowCount(a.id)).toBe(0);
    expect(queueRowCount(b.id)).toBe(0);
  });

  it("deleteSession rolls back if a child-table delete fails mid-transaction", () => {
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:delq-rollback" });
    reg.insertMessage(session.id, "user", "keep me");
    reg.enqueueQueueItem(session.id, session.sessionKey, "queued prompt");

    expect(sessionExists(session.id)).toBe(true);
    expect(messageRowCount(session.id)).toBe(1);
    expect(queueRowCount(session.id)).toBe(1);

    const db = reg.initDb();
    const originalPrepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql === "DELETE FROM queue_items WHERE session_id = ?") {
        throw new Error("injected queue delete failure");
      }
      return originalPrepare(sql);
    });

    expect(() => reg.deleteSession(session.id)).toThrow(/injected queue delete failure/);
    expect(sessionExists(session.id)).toBe(true);
    expect(messageRowCount(session.id)).toBe(1);
    expect(queueRowCount(session.id)).toBe(1);
  });
});
