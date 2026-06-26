import { describe, it, expect, beforeAll } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

// Point the DB at a throwaway dir BEFORE importing the registry (SESSIONS_DB is
// resolved from CUTTLEFISH_HOME at module load).
const { home: tmp } = withStaticTempCuttlefishHome("cuttlefish-sso-");

type Reg = typeof import("../registry.js");
let reg: Reg;
let resolveUserHeader: typeof import("../../gateway/api.js")["resolveUserHeader"];

beforeAll(async () => {
  reg = await import("../registry.js");
  reg.initDb();
  ({ resolveUserHeader } = await import("../../gateway/api.js"));
});

describe("resolveUserHeader", () => {
  it("returns the trimmed value for a string config when the header is present", () => {
    const headers = { "x-auth-request-email": "  alice@example.com  " };
    expect(resolveUserHeader(headers, "X-Auth-Request-Email")).toBe("alice@example.com");
  });

  it("returns the first present header for a string[] config", () => {
    const headers = { "x-forwarded-user": "bob@example.com" };
    expect(
      resolveUserHeader(headers, ["X-Auth-Request-Email", "X-Forwarded-User"]),
    ).toBe("bob@example.com");
  });

  it("returns undefined when the configured header is absent", () => {
    expect(resolveUserHeader({}, "X-Auth-Request-Email")).toBeUndefined();
  });

  it("returns undefined when the config is unset (single-user no-op)", () => {
    const headers = { "x-auth-request-email": "alice@example.com" };
    expect(resolveUserHeader(headers, undefined)).toBeUndefined();
  });

  it("handles array-valued headers by taking the first element", () => {
    const headers = { "x-auth-request-email": ["carol@example.com", "dup@example.com"] };
    expect(resolveUserHeader(headers, "X-Auth-Request-Email")).toBe("carol@example.com");
  });
});

describe("registry userId round-trip", () => {
  it("persists userId and reads it back", () => {
    const s = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:sso-1",
      userId: "alice@example.com",
      prompt: "hi",
    });
    expect(s.userId).toBe("alice@example.com");
    expect(reg.getSession(s.id)?.userId).toBe("alice@example.com");
  });

  it("defaults userId to null when omitted", () => {
    const s = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:sso-2",
      prompt: "hi",
    });
    expect(s.userId).toBeNull();
    expect(reg.getSession(s.id)?.userId).toBeNull();
  });
});

describe("migrateSessionsSchema user_id migration", () => {
  it("additively adds user_id, preserves existing rows as NULL, and is idempotent", () => {
    const db = new Database(":memory:");
    // Legacy schema WITHOUT the user_id column.
    db.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      engine TEXT NOT NULL,
      source TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      status TEXT DEFAULT 'idle',
      created_at TEXT NOT NULL,
      last_activity TEXT NOT NULL
    )`);
    db.prepare(
      `INSERT INTO sessions (id, engine, source, source_ref, status, created_at, last_activity)
       VALUES ('old-1','claude','web','web:old','idle','t','t')`,
    ).run();

    const hasUserId = () =>
      (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).some(
        (c) => c.name === "user_id",
      );

    expect(hasUserId()).toBe(false);

    reg.migrateSessionsSchema(db);
    expect(hasUserId()).toBe(true);
    expect(
      (db.prepare("SELECT user_id FROM sessions WHERE id = ?").get("old-1") as { user_id: string | null }).user_id,
    ).toBeNull();

    // Re-running must not throw, must not duplicate the column, must not change data.
    expect(() => reg.migrateSessionsSchema(db)).not.toThrow();
    const userIdCols = (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).filter(
      (c) => c.name === "user_id",
    );
    expect(userIdCols.length).toBe(1);
    expect(
      (db.prepare("SELECT user_id FROM sessions WHERE id = ?").get("old-1") as { user_id: string | null }).user_id,
    ).toBeNull();
  });
});
