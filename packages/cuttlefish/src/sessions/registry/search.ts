import type Database from 'better-sqlite3';
import { logger } from '../../shared/logger.js';
import { CREATE_FTS, CREATE_META_TABLE } from './schema.js';
import { getMeta, initDb, setMeta } from './core.js';

export interface MessageSearchResult {
  sessionId: string;
  snippet: string;
  role: string;
  timestamp: number;
}

export function migrateFtsSchema(database: Database.Database): void {
  database.exec(CREATE_META_TABLE);
  database.exec(CREATE_FTS);
  if (getMeta(database, 'fts_backfill_done') !== '1' && getMeta(database, 'fts_backfill_max') === null) {
    const row = database.prepare('SELECT MAX(rowid) AS m FROM messages').get() as { m: number | null };
    setMeta(database, 'fts_backfill_max', String(row.m ?? 0));
    setMeta(database, 'fts_backfill_rowid', '0');
  }
}

const FTS_BACKFILL_CHUNK = 1000;

function ftsBackfillStep(database: Database.Database, chunkSize = FTS_BACKFILL_CHUNK): boolean {
  if (getMeta(database, 'fts_backfill_done') === '1') return true;
  const max = Number(getMeta(database, 'fts_backfill_max') ?? '0');
  const progress = Number(getMeta(database, 'fts_backfill_rowid') ?? '0');
  if (progress >= max) {
    setMeta(database, 'fts_backfill_done', '1');
    return true;
  }
  const rows = database
    .prepare(
      `SELECT rowid, content FROM messages
       WHERE role IN ('user','assistant') AND rowid > ? AND rowid <= ?
       ORDER BY rowid ASC LIMIT ?`,
    )
    .all(progress, max, chunkSize) as Array<{ rowid: number; content: string }>;
  if (rows.length === 0) {
    setMeta(database, 'fts_backfill_done', '1');
    return true;
  }
  const insert = database.prepare('INSERT INTO messages_fts(rowid, content) VALUES (?, ?)');
  const txn = database.transaction((items: Array<{ rowid: number; content: string }>) => {
    for (const r of items) insert.run(r.rowid, r.content);
  });
  txn(rows);
  const lastRowid = rows[rows.length - 1].rowid;
  setMeta(database, 'fts_backfill_rowid', String(lastRowid));
  if (lastRowid >= max) {
    setMeta(database, 'fts_backfill_done', '1');
    return true;
  }
  return false;
}

export function backfillFtsSync(database: Database.Database, chunkSize = FTS_BACKFILL_CHUNK): void {
  while (!ftsBackfillStep(database, chunkSize)) {
    /* keep draining chunks */
  }
}

let ftsAvailable = true;

export function disableFtsForProcess(database: Database.Database, reason?: unknown): void {
  const msg = reason instanceof Error ? reason.message : reason != null ? String(reason) : 'explicit disable';
  console.error(`[fts] Boot drain failed (${msg}). Disabling FTS for this process — next boot will retry.`);
  try {
    database.exec(`
      DROP TRIGGER IF EXISTS messages_fts_ai;
      DROP TRIGGER IF EXISTS messages_fts_ad;
      DROP TRIGGER IF EXISTS messages_fts_au;
      DROP TABLE IF EXISTS messages_fts;
    `);
  } catch (dropErr) {
    console.error(`[fts] Failed to drop FTS infrastructure during disable: ${dropErr instanceof Error ? dropErr.message : dropErr}`);
  }
  try {
    database.prepare("DELETE FROM meta WHERE key IN ('fts_backfill_done','fts_backfill_rowid','fts_backfill_max')").run();
  } catch {
    // meta table may not exist in edge cases
  }
  ftsAvailable = false;
}

let ftsBackfillScheduled = false;

function scheduleFtsBackfill(): void {
  if (!ftsAvailable) return;
  const database = initDb();
  if (getMeta(database, 'fts_backfill_done') === '1') return;
  if (ftsBackfillScheduled) return;
  ftsBackfillScheduled = true;
  const pump = (): void => {
    try {
      if (ftsBackfillStep(database)) {
        ftsBackfillScheduled = false;
        return;
      }
      setImmediate(pump);
    } catch (err) {
      logger.warn(`FTS backfill failed: ${err instanceof Error ? err.message : err}`);
      ftsBackfillScheduled = false;
    }
  };
  setImmediate(pump);
}

function sanitizeFtsQuery(query: string): string {
  return query
    .split(/\s+/)
    .map((tok) => tok.replace(/"/g, ''))
    .filter(Boolean)
    .map((tok) => `"${tok}"`)
    .join(' ');
}

export function searchMessages(query: string, limit = 50): MessageSearchResult[] {
  const db = initDb();
  if (!ftsAvailable) return [];
  scheduleFtsBackfill();
  const match = sanitizeFtsQuery(query);
  if (!match) return [];
  const cap = Math.max(1, Math.min(Math.floor(limit) || 50, 200));
  try {
    return db
      .prepare(
        `SELECT m.session_id AS sessionId,
                snippet(messages_fts, 0, '«', '»', '…', 12) AS snippet,
                m.role AS role,
                m.timestamp AS timestamp
         FROM messages_fts
         JOIN messages m ON m.rowid = messages_fts.rowid
         WHERE messages_fts MATCH ?
         ORDER BY m.timestamp DESC
         LIMIT ?`,
      )
      .all(match, cap) as MessageSearchResult[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('no such table')) return [];
    throw err;
  }
}
