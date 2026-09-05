import fs from "node:fs";
import Database from "better-sqlite3";
import { assertSchemaVersionNotNewer } from "./store-schema.js";
import { loadSnapshotFromDb } from "./store-snapshot.js";
import type { SchedulerSnapshot } from "./types.js";

/** Observe committed state, including WAL entries, without running boot or recovery. */
export function readOrchestrationSnapshot(dbPath: string): SchedulerSnapshot | undefined {
  if (dbPath === ":memory:" || !fs.existsSync(dbPath)) return undefined;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.transaction(() => {
      assertSchemaVersionNotNewer(db);
      return loadSnapshotFromDb(db);
    })();
  } finally {
    db.close();
  }
}
