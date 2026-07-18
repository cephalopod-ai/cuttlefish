import { describe, it, expect, beforeAll } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

// DAT-SESS-001: messages, queue_items now carry a declared
// FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE, mirroring
// the approvals-table rebuild in migrateApprovalsSchema. These tests cover:
// (1) a fresh DB gets the FK from the base schema, (2) an existing DB with
// pre-FK messages/queue_items tables is migrated in place with data preserved,
// (3) deleting a session row directly (bypassing deleteSession) cascades at the
// DB level, (4) pre-existing orphaned rows are removed rather than crashing the
// migration.

// Point the DB at a throwaway dir BEFORE importing the registry (SESSIONS_DB is
// resolved from CUTTLEFISH_HOME at module load).
const { home: tmp } = withStaticTempCuttlefishHome("cuttlefish-sess-fk-");

type Reg = typeof import("../registry.js");
let reg: Reg;

beforeAll(async () => {
  reg = await import("../registry.js");
  reg.initDb();
});

function foreignKeyList(db: Database.Database, table: string): Array<{ table: string; from: string; to: string; on_delete: string }> {
  return db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
}

describe("messages/queue_items session_id FOREIGN KEY (DAT-SESS-001)", () => {
  it("a fresh DB declares the FK on messages and queue_items from the base schema", () => {
    const db = reg.initDb();

    const messagesFk = foreignKeyList(db, "messages");
    expect(messagesFk).toHaveLength(1);
    expect(messagesFk[0]).toMatchObject({ table: "sessions", from: "session_id", to: "id", on_delete: "CASCADE" });

    const queueFk = foreignKeyList(db, "queue_items");
    expect(queueFk).toHaveLength(1);
    expect(queueFk[0]).toMatchObject({ table: "sessions", from: "session_id", to: "id", on_delete: "CASCADE" });
  });

  function buildLegacyDb(): { db: Database.Database; dbPath: string } {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-legacy-fk-")), "legacy.db");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        engine TEXT NOT NULL,
        source TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        status TEXT DEFAULT 'idle',
        created_at TEXT NOT NULL,
        last_activity TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
      CREATE TABLE queue_items (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );
    `);
    return { db, dbPath };
  }

  it("migrates an existing DB with pre-FK messages/queue_items tables in place, preserving data", () => {
    const { db, dbPath } = buildLegacyDb();
    db.prepare(
      "INSERT INTO sessions (id, engine, source, source_ref, status, created_at, last_activity) VALUES ('leg-s1','claude','web','web:leg-s1','idle','t','t')",
    ).run();
    db.prepare(
      "INSERT INTO messages (id, session_id, role, content, timestamp) VALUES ('leg-m1','leg-s1','user','keep me',1000)",
    ).run();
    db.prepare(
      "INSERT INTO queue_items (id, session_id, session_key, prompt, status, position, created_at) VALUES ('leg-q1','leg-s1','web:leg-s1','keep this prompt','pending',1,'t')",
    ).run();

    // Pre-migration: no FK declared yet.
    expect(foreignKeyList(db, "messages")).toHaveLength(0);
    expect(foreignKeyList(db, "queue_items")).toHaveLength(0);

    reg.migrateMessagesSchema(db);
    reg.migrateQueueItemsSchema(db);

    expect(foreignKeyList(db, "messages")).toHaveLength(1);
    expect(foreignKeyList(db, "queue_items")).toHaveLength(1);

    const msg = db.prepare("SELECT session_id, content FROM messages WHERE id = 'leg-m1'").get() as
      | { session_id: string; content: string }
      | undefined;
    expect(msg).toEqual({ session_id: "leg-s1", content: "keep me" });

    const queueItem = db.prepare("SELECT session_id, prompt FROM queue_items WHERE id = 'leg-q1'").get() as
      | { session_id: string; prompt: string }
      | undefined;
    expect(queueItem).toEqual({ session_id: "leg-s1", prompt: "keep this prompt" });

    // Running the migration again is a no-op (idempotent).
    expect(() => {
      reg.migrateMessagesSchema(db);
      reg.migrateQueueItemsSchema(db);
    }).not.toThrow();
    expect(foreignKeyList(db, "messages")).toHaveLength(1);
    expect(foreignKeyList(db, "queue_items")).toHaveLength(1);

    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("migration removes pre-existing orphaned rows (no matching session) instead of crashing", () => {
    const { db, dbPath } = buildLegacyDb();
    db.prepare(
      "INSERT INTO sessions (id, engine, source, source_ref, status, created_at, last_activity) VALUES ('leg-s2','claude','web','web:leg-s2','idle','t','t')",
    ).run();
    // Valid row, references an existing session.
    db.prepare(
      "INSERT INTO messages (id, session_id, role, content, timestamp) VALUES ('leg-m-ok','leg-s2','user','valid',1)",
    ).run();
    db.prepare(
      "INSERT INTO queue_items (id, session_id, session_key, prompt, status, position, created_at) VALUES ('leg-q-ok','leg-s2','web:leg-s2','valid prompt','pending',1,'t')",
    ).run();
    // Orphaned rows, referencing a session that does not exist.
    db.prepare(
      "INSERT INTO messages (id, session_id, role, content, timestamp) VALUES ('leg-m-orphan','no-such-session','user','dangling',2)",
    ).run();
    db.prepare(
      "INSERT INTO queue_items (id, session_id, session_key, prompt, status, position, created_at) VALUES ('leg-q-orphan','no-such-session','web:no-such-session','dangling prompt','pending',1,'t')",
    ).run();

    expect(() => {
      reg.migrateMessagesSchema(db);
      reg.migrateQueueItemsSchema(db);
    }).not.toThrow();

    expect(foreignKeyList(db, "messages")).toHaveLength(1);
    expect(foreignKeyList(db, "queue_items")).toHaveLength(1);

    // Orphans removed.
    expect(db.prepare("SELECT COUNT(*) c FROM messages WHERE id = 'leg-m-orphan'").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM queue_items WHERE id = 'leg-q-orphan'").get()).toEqual({ c: 0 });
    // Valid rows preserved.
    expect(db.prepare("SELECT COUNT(*) c FROM messages WHERE id = 'leg-m-ok'").get()).toEqual({ c: 1 });
    expect(db.prepare("SELECT COUNT(*) c FROM queue_items WHERE id = 'leg-q-ok'").get()).toEqual({ c: 1 });

    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("cascades messages/queue_items deletion when a session row is deleted directly (ON DELETE CASCADE)", () => {
    const db = reg.initDb();
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);

    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:fk-cascade" });
    reg.insertMessage(session.id, "user", "will be cascaded");
    reg.enqueueQueueItem(session.id, session.sessionKey, "will be cascaded too");

    expect((db.prepare("SELECT COUNT(*) c FROM messages WHERE session_id = ?").get(session.id) as { c: number }).c).toBe(1);
    expect((db.prepare("SELECT COUNT(*) c FROM queue_items WHERE session_id = ?").get(session.id) as { c: number }).c).toBe(1);

    // Delete the session row directly (bypassing deleteSession's explicit
    // application-level cleanup) — the FK cascade must remove messages/queue_items.
    db.prepare("DELETE FROM sessions WHERE id = ?").run(session.id);

    expect((db.prepare("SELECT COUNT(*) c FROM messages WHERE session_id = ?").get(session.id) as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) c FROM queue_items WHERE session_id = ?").get(session.id) as { c: number }).c).toBe(0);
  });

  it("rolls back cleanly (no dangling transaction, original table intact) if the rebuild fails partway", () => {
    // Regression for the adversarial cross-wave review: the rebuild's
    // CREATE/INSERT/DROP/RENAME previously ran as a bare multi-statement
    // exec() with no explicit transaction, so a failure partway (or a crash)
    // could leave the database with no `messages` table at all. Force a
    // failure by pre-creating a colliding `messages_new` table so the
    // rebuild's own CREATE TABLE statement throws.
    const { db, dbPath } = buildLegacyDb();
    db.prepare(
      "INSERT INTO sessions (id, engine, source, source_ref, status, created_at, last_activity) VALUES ('leg-s3','claude','web','web:leg-s3','idle','t','t')",
    ).run();
    db.prepare(
      "INSERT INTO messages (id, session_id, role, content, timestamp) VALUES ('leg-m3','leg-s3','user','must survive',1)",
    ).run();
    // Sabotage: pre-create the table the migration is about to CREATE.
    db.exec("CREATE TABLE messages_new (bogus INTEGER)");

    expect(() => reg.migrateMessagesSchema(db)).toThrow();

    // The connection must not be left mid-transaction.
    expect(db.inTransaction).toBe(false);
    // The original messages table (and its data) must still be intact and
    // queryable — not dropped, not half-renamed.
    expect(foreignKeyList(db, "messages")).toHaveLength(0);
    const msg = db.prepare("SELECT session_id, content FROM messages WHERE id = 'leg-m3'").get() as
      | { session_id: string; content: string }
      | undefined;
    expect(msg).toEqual({ session_id: "leg-s3", content: "must survive" });
    // The connection must still be usable for an unrelated statement.
    expect(() => db.prepare("SELECT 1").get()).not.toThrow();

    db.exec("DROP TABLE messages_new");
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("rejects inserting a message/queue_item for a non-existent session", () => {
    const db = reg.initDb();
    expect(() =>
      db
        .prepare("INSERT INTO messages (id, session_id, role, content, timestamp) VALUES ('orphan-insert','no-such-session','user','x',1)")
        .run(),
    ).toThrow(/FOREIGN KEY/i);
    expect(() =>
      db
        .prepare(
          "INSERT INTO queue_items (id, session_id, session_key, prompt, status, position, created_at) VALUES ('orphan-q-insert','no-such-session','k','x','pending',1,'t')",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/i);
  });
});
