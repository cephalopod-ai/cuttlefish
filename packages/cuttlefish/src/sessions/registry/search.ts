import { initDb } from './core.js';
import { isFtsAvailable, scheduleFtsBackfill } from './fts.js';

export interface MessageSearchResult {
  sessionId: string;
  snippet: string;
  role: string;
  timestamp: number;
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
  if (!isFtsAvailable()) return [];
  scheduleFtsBackfill(db);
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
