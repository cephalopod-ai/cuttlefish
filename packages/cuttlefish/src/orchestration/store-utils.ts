import Database from "better-sqlite3";

export function setMeta(db: Database.Database, key: string, value: string): void {
  db.prepare(`
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

export function parseDbJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (err) {
    throw new Error(`invalid orchestration DB JSON in ${label}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
