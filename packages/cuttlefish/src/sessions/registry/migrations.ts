import type Database from 'better-sqlite3';
import { logger } from '../../shared/logger.js';
import { CREATE_MESSAGES_INDEX, CREATE_MESSAGES_TIMESTAMP_INDEX } from './schema.js';

export function migrateMessagesSchema(database: Database.Database): void {
  const cols = database.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has('media')) {
    database.exec('ALTER TABLE messages ADD COLUMN media TEXT');
  }
  if (!colNames.has('partial')) {
    database.exec('ALTER TABLE messages ADD COLUMN partial INTEGER');
  }
  if (!colNames.has('seq')) {
    database.exec('ALTER TABLE messages ADD COLUMN seq INTEGER');
  }
  if (!colNames.has('tool_call')) {
    database.exec('ALTER TABLE messages ADD COLUMN tool_call TEXT');
  }
  if (!colNames.has('blocks')) {
    database.exec('ALTER TABLE messages ADD COLUMN blocks TEXT');
  }

  // Add the FOREIGN KEY (session_id -> sessions.id, ON DELETE CASCADE) on upgraded
  // homes whose messages table predates it (DAT-SESS-001). Mirrors the
  // approvals-table rebuild below/in migrateApprovalsSchema: SQLite cannot
  // ALTER-ADD a constraint, so the table is rebuilt with FKs OFF. Runs BEFORE
  // migrateFtsSchema (see core.ts initDb ordering) so the DROP TABLE here can't
  // clobber live FTS triggers/backfill state — any pre-existing messages_fts_*
  // triggers on the old table are auto-dropped by SQLite's DROP TABLE, and
  // migrateFtsSchema's `CREATE TRIGGER IF NOT EXISTS` then recreates them fresh
  // against the rebuilt table. The row copy explicitly preserves `rowid` because
  // messages_fts is an external-content FTS5 index keyed by messages.rowid.
  //
  // Skipped when the sessions table doesn't exist yet — e.g. a standalone legacy
  // fixture (in tests) that only exercises the column migration above and never
  // goes through installBaseSchema, so there is no FK target to validate against.
  const sessionsCols = database.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  if (sessionsCols.length === 0) return;

  const hasForeignKey = (database.prepare('PRAGMA foreign_key_list(messages)').all() as unknown[]).length > 0;
  if (hasForeignKey) return;

  // Pre-flight: remove any orphaned messages (no matching session) so the
  // rebuild and subsequent FK enforcement can't fail on pre-existing dangling rows.
  const orphaned = database.prepare('DELETE FROM messages WHERE session_id NOT IN (SELECT id FROM sessions)').run();
  if (orphaned.changes > 0) {
    logger.warn(`registry: removed ${orphaned.changes} orphaned message row(s) with no matching session during FK migration`);
  }

  const columnList = (database.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>)
    .map((c) => c.name)
    .join(', ');

  const fkWasOn = (database.pragma('foreign_keys', { simple: true }) as number) === 1;
  database.pragma('foreign_keys = OFF');
  try {
    // BEGIN IMMEDIATE/COMMIT wraps the rebuild atomically: better-sqlite3's
    // exec() does not implicitly transaction-wrap a multi-statement script, so
    // without an explicit transaction a crash between DROP TABLE and RENAME
    // TABLE would leave the database with no `messages` table at all, and the
    // next boot's PRAGMA table_info(messages) probe above would come back
    // empty and mis-diagnose it as a fresh install. Toggling `foreign_keys`
    // must stay outside this transaction (better-sqlite3 throws otherwise),
    // which is why it's done via separate pragma() calls before/after. If a
    // statement inside the transaction throws (not a crash, an in-process
    // error), roll back explicitly so the connection isn't left with a
    // dangling open transaction.
    try {
      database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE messages_new (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          media TEXT,
          partial INTEGER,
          seq INTEGER,
          tool_call TEXT,
          blocks TEXT,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        INSERT INTO messages_new (rowid, ${columnList})
          SELECT rowid, ${columnList} FROM messages;
        DROP TABLE messages;
        ALTER TABLE messages_new RENAME TO messages;
        COMMIT;
      `);
    } catch (err) {
      if (database.inTransaction) database.exec('ROLLBACK');
      throw err;
    }
    // DROP TABLE above also dropped the indexes bound to the old messages table;
    // recreate them so query performance doesn't regress until the next boot.
    database.exec(CREATE_MESSAGES_INDEX);
    database.exec(CREATE_MESSAGES_TIMESTAMP_INDEX);
  } finally {
    if (fkWasOn) database.pragma('foreign_keys = ON');
  }
}

export function migrateQueueItemsSchema(database: Database.Database): void {
  const cols = database.prepare('PRAGMA table_info(queue_items)').all() as Array<{ name: string }>;
  // Fresh DB: queue_items is created (with its FK) by installPostMigrationSchema.
  // If this runs before that (shouldn't happen in initDb's ordering, but guard
  // defensively like migrateApprovalsSchema does for approvals), there's nothing
  // to upgrade yet.
  if (cols.length === 0) return;

  // Skipped when the sessions table doesn't exist yet — no FK target to validate
  // against (mirrors the same guard in migrateMessagesSchema).
  const sessionsCols = database.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  if (sessionsCols.length === 0) return;

  // Add the FOREIGN KEY (session_id -> sessions.id, ON DELETE CASCADE) on upgraded
  // homes whose queue_items table predates it (DAT-SESS-001). Mirrors
  // migrateApprovalsSchema's rebuild pattern exactly.
  const hasForeignKey = (database.prepare('PRAGMA foreign_key_list(queue_items)').all() as unknown[]).length > 0;
  if (hasForeignKey) return;

  // Pre-flight: remove any orphaned queue_items (no matching session) so the
  // rebuild and subsequent FK enforcement can't fail on pre-existing dangling rows.
  const orphaned = database.prepare('DELETE FROM queue_items WHERE session_id NOT IN (SELECT id FROM sessions)').run();
  if (orphaned.changes > 0) {
    logger.warn(`registry: removed ${orphaned.changes} orphaned queue_items row(s) with no matching session during FK migration`);
  }

  const columnList = (database.prepare('PRAGMA table_info(queue_items)').all() as Array<{ name: string }>)
    .map((c) => c.name)
    .join(', ');

  const fkWasOn = (database.pragma('foreign_keys', { simple: true }) as number) === 1;
  database.pragma('foreign_keys = OFF');
  try {
    // See the matching comment in migrateMessagesSchema: exec() doesn't
    // implicitly transaction-wrap a multi-statement script, so the rebuild is
    // wrapped explicitly and rolled back if any statement throws.
    try {
      database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE queue_items_new (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          session_key TEXT NOT NULL,
          prompt TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          position INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        INSERT INTO queue_items_new (${columnList})
          SELECT ${columnList} FROM queue_items;
        DROP TABLE queue_items;
        ALTER TABLE queue_items_new RENAME TO queue_items;
        COMMIT;
      `);
    } catch (err) {
      if (database.inTransaction) database.exec('ROLLBACK');
      throw err;
    }
    // DROP TABLE above also dropped idx_queue_session; recreate it.
    database.exec('CREATE INDEX IF NOT EXISTS idx_queue_session ON queue_items (session_key, status, position)');
  } finally {
    if (fkWasOn) database.pragma('foreign_keys = ON');
  }
}

export function migrateSessionsSchema(database: Database.Database): void {
  const cols = database.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  const missingColumns: Array<[string, string, string?]> = [
    ['title', 'TEXT'],
    ['parent_session_id', 'TEXT'],
    ['connector', 'TEXT'],
    ['session_key', 'TEXT'],
    ['reply_context', 'TEXT'],
    ['message_id', 'TEXT'],
    ['transport_meta', 'TEXT'],
    ['employee', 'TEXT'],
    ['group_key', 'TEXT'],
    ['model', 'TEXT'],
    ['engine_session_id', 'TEXT'],
    ['last_error', 'TEXT'],
    ['total_cost', 'REAL', '0'],
    ['total_turns', 'INTEGER', '0'],
    ['effort_level', 'TEXT'],
    ['last_context_tokens', 'INTEGER'],
    ['user_id', 'TEXT'],
    ['prompt_excerpt', 'TEXT'],
    ['cwd', 'TEXT'],
  ];

  for (const [name, type, defaultVal] of missingColumns) {
    if (!colNames.has(name)) {
      const defaultClause = defaultVal !== undefined ? ` DEFAULT ${defaultVal}` : '';
      database.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}${defaultClause}`);
    }
  }

  const refreshedCols = database.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  const refreshedNames = new Set(refreshedCols.map((c) => c.name));
  if (refreshedNames.has('session_key')) {
    database.exec(`UPDATE sessions SET session_key = COALESCE(session_key, source_ref) WHERE session_key IS NULL OR session_key = ''`);
  }
  if (refreshedNames.has('connector')) {
    database.exec(`UPDATE sessions SET connector = COALESCE(connector, source) WHERE connector IS NULL OR connector = ''`);
  }
  if (refreshedNames.has('group_key')) {
    database.exec(`
      UPDATE sessions
         SET group_key = CASE
           WHEN source = 'cron' OR source_ref LIKE 'cron:%' THEN '__cron__'
           WHEN employee IS NULL OR employee = '' THEN '__direct__'
           ELSE employee
         END
       WHERE group_key IS NULL OR group_key = ''
    `);
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_group_activity ON sessions (group_key, last_activity DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_cwd_activity ON sessions (cwd, last_activity DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_status_activity ON sessions (status, last_activity DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_source_activity ON sessions (source, last_activity DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_engine_activity ON sessions (engine, last_activity DESC);
  `);
}

export function migrateFilesSchema(database: Database.Database): void {
  const cols = database.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  const missingColumns: Array<[string, string, string?]> = [
    ['sha256', 'TEXT'],
    ['artifact_kind', 'TEXT', "'input'"],
    ['producing_run_id', 'TEXT'],
    ['source_url', 'TEXT'],
    ['source_path', 'TEXT'],
    ['tags', 'TEXT'],
    ['notes', 'TEXT'],
  ];

  for (const [name, type, defaultVal] of missingColumns) {
    if (!colNames.has(name)) {
      const defaultClause = defaultVal !== undefined ? ` DEFAULT ${defaultVal}` : '';
      database.exec(`ALTER TABLE files ADD COLUMN ${name} ${type}${defaultClause}`);
    }
  }

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_files_kind_created ON files (artifact_kind, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_files_producing_run ON files (producing_run_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_files_sha256 ON files (sha256);
    CREATE INDEX IF NOT EXISTS idx_files_path ON files (path);
    CREATE INDEX IF NOT EXISTS idx_files_source_path ON files (source_path);
  `);
}

export function migrateApprovalsSchema(database: Database.Database): void {
  const cols = database.prepare('PRAGMA table_info(approvals)').all() as Array<{ name: string }>;
  // Fresh DB: the approvals table is created (with its FK) by installPostMigrationSchema,
  // which runs after this migration — nothing to upgrade here.
  if (cols.length === 0) return;
  const colNames = new Set(cols.map((c) => c.name));
  const missingColumns: Array<[string, string]> = [
    ['decision_notes', 'TEXT'],
    ['resulting_action', 'TEXT'],
    ['resolved_by_kind', 'TEXT'],
  ];
  for (const [name, type] of missingColumns) {
    if (!colNames.has(name)) {
      database.exec(`ALTER TABLE approvals ADD COLUMN ${name} ${type}`);
    }
  }

  // Add the FOREIGN KEY (session_id -> sessions.id, ON DELETE CASCADE) on upgraded
  // homes whose approvals table predates it. SQLite cannot ALTER-ADD a constraint,
  // so the table is rebuilt. PRAGMA foreign_keys must be toggled OUTSIDE any
  // transaction (better-sqlite3 throws otherwise), and the rebuild runs with FKs
  // OFF so copying rows can't trip the constraint being added.
  const hasForeignKey = (database.prepare('PRAGMA foreign_key_list(approvals)').all() as unknown[]).length > 0;
  if (!hasForeignKey) {
    // Pre-flight: remove any orphaned approvals (no matching session) so the
    // rebuild and subsequent FK enforcement can't fail on pre-existing dangling rows.
    database.prepare('DELETE FROM approvals WHERE session_id NOT IN (SELECT id FROM sessions)').run();

    const fkWasOn = (database.pragma('foreign_keys', { simple: true }) as number) === 1;
    database.pragma('foreign_keys = OFF');
    try {
      // See the matching comment in migrateMessagesSchema: exec() doesn't
      // implicitly transaction-wrap a multi-statement script, so the rebuild
      // is wrapped explicitly and rolled back if any statement throws — a
      // crash between DROP TABLE and RENAME TABLE would otherwise leave the
      // database with no `approvals` table at all.
      try {
        database.exec(`
          BEGIN IMMEDIATE;
          CREATE TABLE approvals_new (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            type TEXT NOT NULL,
            payload TEXT NOT NULL,
            state TEXT NOT NULL,
            created_at TEXT NOT NULL,
            resolved_at TEXT,
            actor TEXT,
            decision_notes TEXT,
            resulting_action TEXT,
            resolved_by_kind TEXT,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
          );
          INSERT INTO approvals_new
            (id, session_id, type, payload, state, created_at, resolved_at, actor, decision_notes, resulting_action, resolved_by_kind)
            SELECT id, session_id, type, payload, state, created_at, resolved_at, actor, decision_notes, resulting_action, resolved_by_kind
            FROM approvals;
          DROP TABLE approvals;
          ALTER TABLE approvals_new RENAME TO approvals;
          COMMIT;
        `);
      } catch (err) {
        if (database.inTransaction) database.exec('ROLLBACK');
        throw err;
      }
    } finally {
      if (fkWasOn) database.pragma('foreign_keys = ON');
    }
  }
}

export function migrateExternalOutboxSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS external_outbox (
      id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      partition_key TEXT,
      idempotency_key TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      sink_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_attempt_at TEXT,
      claim_expires_at TEXT,
      delivered_at TEXT,
      remote_id TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL
    );
  `);
  const cols = database.prepare('PRAGMA table_info(external_outbox)').all() as Array<{ name: string }>;
  if (!cols.some((column) => column.name === 'claim_expires_at')) {
    database.exec('ALTER TABLE external_outbox ADD COLUMN claim_expires_at TEXT');
  }
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_external_outbox_sink_idempotency
      ON external_outbox (sink_name, idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_external_outbox_pending
      ON external_outbox (status, next_attempt_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_external_outbox_claim_expiry
      ON external_outbox (status, claim_expires_at);
  `);
}
