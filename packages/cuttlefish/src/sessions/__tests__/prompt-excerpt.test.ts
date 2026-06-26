import { describe, it, expect, beforeAll } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

// Point the DB at a throwaway dir BEFORE importing the registry (SESSIONS_DB is
// resolved from CUTTLEFISH_HOME at module load).
const { home: tmp } = withStaticTempCuttlefishHome("cuttlefish-prompt-excerpt-");

type Reg = typeof import("../registry.js");
let reg: Reg;

beforeAll(async () => {
  reg = await import("../registry.js");
  reg.initDb();
});

describe("promptExcerptOf", () => {
  it("flattens whitespace (newlines + runs of spaces) to single spaces", () => {
    expect(reg.promptExcerptOf("Audit the funnel\n\nand   split the fixes")).toBe(
      "Audit the funnel and split the fixes",
    );
  });

  it("truncates long prompts to ≤140 chars ending with an ellipsis", () => {
    const out = reg.promptExcerptOf("x".repeat(400))!;
    expect(out.length).toBeLessThanOrEqual(140);
    expect(out.endsWith("…")).toBe(true);
  });

  it("keeps short prompts intact", () => {
    expect(reg.promptExcerptOf("Ship it")).toBe("Ship it");
  });

  it("returns undefined for empty / whitespace-only / missing prompts", () => {
    expect(reg.promptExcerptOf("")).toBeUndefined();
    expect(reg.promptExcerptOf("   \n\t ")).toBeUndefined();
    expect(reg.promptExcerptOf(undefined)).toBeUndefined();
  });
});

describe("registry promptExcerpt round-trip", () => {
  it("createSession persists the excerpt and reads it back", () => {
    const s = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:excerpt-1",
      prompt: "Audit the funnel\n\nand   split the fixes",
    });
    expect(s.promptExcerpt).toBe("Audit the funnel and split the fixes");
    expect(reg.getSession(s.id)?.promptExcerpt).toBe("Audit the funnel and split the fixes");
  });

  it("defaults promptExcerpt to null when no prompt is given", () => {
    const s = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:excerpt-2",
    });
    expect(s.promptExcerpt).toBeNull();
    expect(reg.getSession(s.id)?.promptExcerpt).toBeNull();
  });
});

describe("migrateSessionsSchema prompt_excerpt migration", () => {
  it("additively adds prompt_excerpt, leaves existing rows NULL (no backfill), and is idempotent", () => {
    const db = new Database(":memory:");
    // Legacy schema WITHOUT the prompt_excerpt column.
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

    const hasCol = () =>
      (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).some(
        (c) => c.name === "prompt_excerpt",
      );

    expect(hasCol()).toBe(false);

    reg.migrateSessionsSchema(db);
    expect(hasCol()).toBe(true);
    expect(
      (db.prepare("SELECT prompt_excerpt FROM sessions WHERE id = ?").get("old-1") as {
        prompt_excerpt: string | null;
      }).prompt_excerpt,
    ).toBeNull();

    // Re-running must not throw and must not duplicate the column.
    expect(() => reg.migrateSessionsSchema(db)).not.toThrow();
    const cols = (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).filter(
      (c) => c.name === "prompt_excerpt",
    );
    expect(cols.length).toBe(1);
  });
});
