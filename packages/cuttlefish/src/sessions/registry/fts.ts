import type Database from 'better-sqlite3';
import { logger } from '../../shared/logger.js';
import { getMeta, setMeta } from './meta.js';
import { CREATE_FTS, CREATE_META_TABLE } from './schema.js';

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
    for (const row of items) insert.run(row.rowid, row.content);
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

export function isFtsAvailable(): boolean {
  return ftsAvailable;
}

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

export function scheduleFtsBackfill(database: Database.Database): void {
  if (!ftsAvailable) return;
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
