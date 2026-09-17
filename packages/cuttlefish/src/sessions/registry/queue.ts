import { randomUUID } from 'node:crypto';
import { isQueueDispatchAuthority, type QueueDispatchAuthority } from '@cuttlefish/contracts';
import { initDb } from './core.js';
import { getSession, patchSessionTransportMeta, updateSession } from './sessions.js';
import { queueDispatchAuthority } from '../execution-boundary.js';

export interface QueueItem {
  id: string;
  sessionId: string;
  sessionKey: string;
  prompt: string;
  status: "pending" | "running" | "cancelled" | "completed" | "denied" | "uncertain";
  dispatchAuthority: QueueDispatchAuthority | null;
  dispatchAuthorityInvalid: boolean;
  position: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

const SELECT_QUEUE = 'SELECT id, session_id as sessionId, session_key as sessionKey, prompt, dispatch_authority as dispatchAuthority, status, position, created_at as createdAt, started_at as startedAt, completed_at as completedAt FROM queue_items';

function queueRow(row: Record<string, unknown>): QueueItem {
  let authority: unknown = null;
  try { authority = typeof row.dispatchAuthority === 'string' ? JSON.parse(row.dispatchAuthority) : null; } catch { /* Corrupt state is explicitly gated at dispatch. */ }
  return { ...row, dispatchAuthority: isQueueDispatchAuthority(authority) ? authority : null,
    dispatchAuthorityInvalid: row.dispatchAuthority != null && !isQueueDispatchAuthority(authority) } as unknown as QueueItem;
}

export function enqueueQueueItem(sessionId: string, sessionKey: string, prompt: string, authority?: QueueDispatchAuthority | null, operationId?: string): string {
  const db = initDb();
  const id = operationId ?? randomUUID();
  // Read-then-insert must be one atomic unit: two concurrent enqueues for the
  // same session_key could otherwise read the same MAX(position) and produce
  // duplicate position values (DAT-SESS-007). Position ties are additionally
  // self-mitigated by the created_at secondary sort in the read paths below,
  // but the transaction removes the race rather than just tolerating it.
  const insert = db.transaction(() => {
    const session = getSession(sessionId);
    if (!session) throw new Error('Queue target session is unavailable');
    const dispatchAuthority = authority === undefined ? queueDispatchAuthority(session, prompt) : authority;
    if (dispatchAuthority !== null && !isQueueDispatchAuthority(dispatchAuthority)) throw new Error('Invalid queue dispatch authority');
    const existing = getQueueItem(id);
    if (existing) {
      if (existing.sessionId !== sessionId || existing.sessionKey !== sessionKey || existing.prompt !== prompt
        || JSON.stringify(existing.dispatchAuthority) !== JSON.stringify(dispatchAuthority)) throw new Error('Queue operation identity reused with changed payload');
      return;
    }
    const position = (db.prepare(
      "SELECT COALESCE(MAX(position), 0) + 1 as pos FROM queue_items WHERE session_key = ? AND status IN ('pending', 'running')"
    ).get(sessionKey) as { pos: number }).pos;
    db.prepare(
      "INSERT INTO queue_items (id, session_id, session_key, prompt, dispatch_authority, status, position, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)"
    ).run(id, sessionId, sessionKey, prompt, dispatchAuthority ? JSON.stringify(dispatchAuthority) : null, position, new Date().toISOString());
  });
  insert();
  return id;
}

/**
 * Atomically claim a pending queue item for dispatch (FSR-CF-007). The
 * status flip only takes effect `WHERE status = 'pending'`, so this is a
 * compare-and-swap claim rather than a blind write: at most one caller can
 * ever win the claim on a given item, which is what makes it safe to call
 * this durably *before* the engine dispatch side-effect runs (mirrors the
 * claim-lease idiom in external-outbox.ts's claimPendingExternalOutboxItems
 * and the atomic-claim idiom in webhook-replay.ts's claimConnectorWebhookReplay).
 * Returns true only if this call performed the claim.
 *
 * A crash after the claim has an uncertain outcome. Recovery quarantines that
 * operation instead of silently repeating a possibly consequential engine call.
 */
export function markQueueItemRunning(itemId: string): boolean {
  const db = initDb();
  const result = db.prepare(
    "UPDATE queue_items SET status = 'running', started_at = ? WHERE id = ? AND status = 'pending'"
  ).run(new Date().toISOString(), itemId);
  return result.changes > 0;
}

export function markQueueItemCompleted(itemId: string): void {
  const db = initDb();
  db.prepare("UPDATE queue_items SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'running'")
    .run(new Date().toISOString(), itemId);
}

export function getQueueItem(itemId: string): QueueItem | undefined {
  const db = initDb();
  const row = db.prepare(`${SELECT_QUEUE} WHERE id = ?`).get(itemId) as Record<string, unknown> | undefined;
  return row ? queueRow(row) : undefined;
}

export function markQueueItemDenied(itemId: string): void {
  initDb().prepare("UPDATE queue_items SET status = 'denied', completed_at = ? WHERE id = ? AND status IN ('pending', 'running')").run(new Date().toISOString(), itemId);
}

/** A wait discovered after claim is still undispatched work, safe to retain. */
export function retainQueueItemPending(itemId: string): void {
  initDb().prepare("UPDATE queue_items SET status = 'pending', started_at = NULL WHERE id = ? AND status = 'running'").run(itemId);
}

export function cancelQueueItem(itemId: string): boolean {
  const db = initDb();
  const result = db.prepare(
    "UPDATE queue_items SET status = 'cancelled' WHERE id = ? AND status = 'pending'"
  ).run(itemId);
  return result.changes > 0;
}

export function cancelQueueItemForSession(itemId: string, sessionId: string, sessionKey: string): boolean {
  const db = initDb();
  const result = db.prepare(
    "UPDATE queue_items SET status = 'cancelled' WHERE id = ? AND status = 'pending' AND session_id = ? AND session_key = ?"
  ).run(itemId, sessionId, sessionKey);
  return result.changes > 0;
}

export function getQueueItems(sessionKey: string): QueueItem[] {
  const db = initDb();
  return db.prepare(
    `${SELECT_QUEUE} WHERE session_key = ? AND status IN ('pending', 'running') ORDER BY position ASC, created_at ASC`
  ).all(sessionKey).map((row) => queueRow(row as Record<string, unknown>));
}

export function listPendingQueueItems(sessionKey: string): QueueItem[] {
  const db = initDb();
  return db.prepare(
    `${SELECT_QUEUE} WHERE session_key = ? AND status = 'pending' ORDER BY position ASC, created_at ASC`
  ).all(sessionKey).map((row) => queueRow(row as Record<string, unknown>));
}

export function hasPendingQueueItemBefore(sessionKey: string, itemId: string): boolean {
  const items = listPendingQueueItems(sessionKey);
  const index = items.findIndex((item) => item.id === itemId);
  return index > 0;
}

export function cancelAllPendingQueueItems(sessionKey: string): number {
  const db = initDb();
  const result = db.prepare(
    "UPDATE queue_items SET status = 'cancelled' WHERE session_key = ? AND status = 'pending'"
  ).run(sessionKey);
  return result.changes;
}

export function pauseQueueKey(sessionKey: string): void {
  const db = initDb();
  db.prepare(
    "INSERT OR REPLACE INTO queue_pauses (session_key, paused_at) VALUES (?, ?)"
  ).run(sessionKey, new Date().toISOString());
}

export function resumeQueueKey(sessionKey: string): void {
  const db = initDb();
  db.prepare("DELETE FROM queue_pauses WHERE session_key = ?").run(sessionKey);
}

export function listPausedQueueKeys(): string[] {
  const db = initDb();
  return db.prepare("SELECT session_key as sessionKey FROM queue_pauses ORDER BY paused_at ASC")
    .all()
    .map((row) => (row as { sessionKey: string }).sessionKey);
}

/**
 * Boot-time recovery for items orphaned by a crash: any item still 'running'
 * from a previous process is quarantined as 'uncertain'. A committed claim
 * cannot prove whether the external CLI performed an effect. Only 'running' is touched —
 * 'pending', 'cancelled', and 'completed' rows are left exactly as they are,
 * so recovery never re-arms an item that already settled.
 */
export function recoverStaleQueueItems(): number {
  const db = initDb();
  return db.transaction(() => {
    const rows = db.prepare("SELECT DISTINCT session_id AS id FROM queue_items WHERE status = 'running'").all() as Array<{ id: string }>;
    const result = db.prepare("UPDATE queue_items SET status = 'uncertain' WHERE status = 'running'").run();
    for (const row of rows) {
      patchSessionTransportMeta(row.id, (meta) => ({ ...meta, dispatchRecovery: { state: 'uncertain' },
        ...(meta.operatorDelegation && typeof meta.operatorDelegation === 'object' && !Array.isArray(meta.operatorDelegation)
          ? { operatorDelegation: { ...meta.operatorDelegation, state: 'revoked' } } : {}) }));
      updateSession(row.id, { status: 'waiting', lastError: 'Uncertain engine dispatch after gateway restart; reconcile effects before resuming the queue' });
    }
    return result.changes;
  })();
}

export function listAllPendingQueueItems(): QueueItem[] {
  const db = initDb();
  return db.prepare(
    `${SELECT_QUEUE} WHERE status = 'pending' ORDER BY created_at ASC, position ASC`
  ).all().map((row) => queueRow(row as Record<string, unknown>));
}
