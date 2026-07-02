import fs from "node:fs";
import { logger } from "../shared/logger.js";
import { getSession, getMessages, insertMessage, updateMessageContent, updateSession, patchSessionTransportMeta, initDb, type SessionMessage } from "../sessions/registry.js";
import { findTranscriptForSession } from "../engines/claude-interactive.js";
import type { HookPayload } from "./hook-registry.js";

/**
 * External-turn sync: persist turns that happened OUTSIDE a gateway run() —
 * i.e. typed directly into the CLI/xterm PTY view — into the gateway messages
 * DB, so chat mode shows them.
 *
 * Anchor mechanism: `transportMeta.transcriptSyncedThrough` holds the ISO
 * timestamp of the newest transcript entry already persisted by this sync.
 * Each sync reads the Claude transcript tail (entries strictly newer than the
 * anchor), inserts the user+assistant messages in order, and advances the
 * anchor — so a repeated Stop (or a sync racing the on-load safety net) can
 * never double-insert. NOTE: this is deliberately NOT `claudeSyncSince` — that
 * key drives the opposite direction (DB messages → injected into Claude's
 * prompt after a rate-limit engine-override revert) and is consumed/deleted by
 * the next Claude run, so it can't serve as a durable transcript anchor.
 *
 * When the anchor is absent (first external turn for a session), the last DB
 * message's insert time is used instead: every transcript entry of an already-
 * persisted turn predates the DB insert of that turn's final assistant message,
 * so gateway-run history is never re-inserted.
 */
export const TRANSCRIPT_SYNC_META_KEY = "transcriptSyncedThrough";

/** One user/assistant text entry from the transcript tail. */
export interface TranscriptTailEntry {
  role: "user" | "assistant";
  content: string;
  /** Entry's transcript timestamp (epoch ms). */
  timestampMs: number;
  /** Same timestamp, original ISO form (becomes the new anchor). */
  timestampIso: string;
}

function isControlText(content: string): boolean {
  const t = content.trim();
  return (
    t.startsWith("<command-name>") ||
    t.startsWith("<local-command-") ||
    t.startsWith("<task-notification>") ||
    isInternalNotificationPrompt(t) ||
    t.startsWith("This session is being continued from a previous conversation")
  );
}

function isInternalNotificationPrompt(content: string): boolean {
  const t = content.trim();
  return (
    (
      t.startsWith("📩 Employee ") &&
      t.includes(" replied in child session ") &&
      t.includes("To read the full reply:")
    ) ||
    (
      t.startsWith("⚠️ Employee ") &&
      t.includes(" (child session ") &&
      t.includes(" hit an error and could not finish:")
    ) ||
    (
      t.startsWith("📩 Thread ") &&
      t.includes(" reported back.") &&
      t.includes("To follow up,")
    ) ||
    (
      t.startsWith("⚠️ Thread ") &&
      t.includes(" hit an error.") &&
      t.includes("Tell the operator plainly")
    )
  );
}

export function isPersistableClaudeTranscriptEntry(obj: any): boolean {
  if (!obj || typeof obj !== "object") return false;
  const type = obj?.type;
  if (type !== "user" && type !== "assistant") return false;
  if (obj.isSidechain === true || obj.isMeta === true) return false;
  if (obj.sourceToolAssistantUUID || obj.toolUseResult) return false;
  if (obj.promptSource === "system") return false;
  if (obj?.origin?.kind === "task-notification") return false;
  if (obj?.message?.model === "<synthetic>") return false;
  const raw = obj?.message?.content;
  if (typeof raw === "string" && isControlText(raw)) return false;
  return true;
}

export function transcriptEntryText(obj: any): { role: "user" | "assistant"; content: string } | null {
  if (!isPersistableClaudeTranscriptEntry(obj)) return null;
  let content = obj?.message?.content;
  if (Array.isArray(content)) {
    content = content
      .filter((b: Record<string, unknown>) => b?.type === "text")
      .map((b: Record<string, unknown>) => String(b.text ?? ""))
      .join("");
  }
  if (typeof content !== "string" || !content.trim()) return null;
  if (isControlText(content)) return null;
  return { role: obj.type, content: content.trim() };
}

/**
 * Parse the user/assistant text entries of a Claude transcript newer than
 * `sinceMs`. Sidechain (sub-agent) and meta entries are skipped; array content
 * is reduced to its text blocks (tool_use/tool_result blocks drop out, exactly
 * like the full-transcript backfill in api.ts). Returns `null` when the file
 * can't be read — callers distinguish "unreadable" from "nothing new".
 */
export function readTranscriptTail(transcriptPath: string, sinceMs: number): TranscriptTailEntry[] | null {
  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, "utf-8");
  } catch {
    return null;
  }
  const entries: TranscriptTailEntry[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let obj: any;
    try { obj = JSON.parse(t); } catch { continue; }
    const iso = obj.timestamp;
    if (typeof iso !== "string") continue;
    const ms = new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms <= sinceMs) continue;
    const text = transcriptEntryText(obj);
    if (!text) continue;
    entries.push({ ...text, timestampMs: ms, timestampIso: iso });
  }
  return entries;
}

function anchorMsFor(session: { transportMeta: unknown }, sessionId: string): number {
  const meta = (session.transportMeta || {}) as Record<string, unknown>;
  const anchorIso = meta[TRANSCRIPT_SYNC_META_KEY];
  if (typeof anchorIso === "string") {
    const ms = new Date(anchorIso).getTime();
    if (Number.isFinite(ms)) return ms;
  }
  // No anchor yet — fall back to the newest DB message's insert time (0 = empty
  // session, i.e. sync the whole transcript, equivalent to a backfill).
  const messages = getMessages(sessionId);
  return messages.length > 0 ? messages[messages.length - 1].timestamp : 0;
}

function setAnchor(sessionId: string, anchorIso: string): void {
  const updated = patchSessionTransportMeta(sessionId, { [TRANSCRIPT_SYNC_META_KEY]: anchorIso });
  if (updated) updateSession(sessionId, { lastActivity: new Date().toISOString() });
}

/** Read up to the last `maxBytes` of a file as utf-8 (whole file when smaller). */
function readFileTailSync(filePath: string, maxBytes: number): { text: string; truncated: boolean } | undefined {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - maxBytes);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return { text: buf.toString("utf-8"), truncated: start > 0 };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

function latestIsoInLines(raw: string, skipFirstPartial: boolean): string | undefined {
  let latestMs = 0;
  let latestIso: string | undefined;
  const lines = raw.split("\n");
  for (let i = skipFirstPartial ? 1 : 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    let obj: any;
    try { obj = JSON.parse(t); } catch { continue; }
    const iso = obj?.timestamp;
    if (typeof iso !== "string") continue;
    const ms = new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms <= latestMs) continue;
    latestMs = ms;
    latestIso = iso;
  }
  return latestIso;
}

const LATEST_TS_TAIL_BYTES = 256 * 1024;

function latestTranscriptTimestampIso(transcriptPath: string): string | undefined {
  // Transcripts are append-only, so the newest timestamp lives in the last
  // lines. This runs on every completed Claude turn — a bounded tail read
  // replaces re-reading the whole (multi-MB, ever-growing) file each time.
  const tail = readFileTailSync(transcriptPath, LATEST_TS_TAIL_BYTES);
  if (!tail) return undefined;
  const iso = latestIsoInLines(tail.text, tail.truncated);
  if (iso || !tail.truncated) return iso;
  // Pathological tail (no parseable timestamp in the last 256KB of a larger
  // file) — fall back to scanning the whole transcript.
  try {
    return latestIsoInLines(fs.readFileSync(transcriptPath, "utf-8"), false);
  } catch {
    return undefined;
  }
}

/** Mark a Claude transcript as already owned by the gateway completion path. */
export function markTranscriptSyncedThrough(sessionId: string, engineSessionId?: string, transcriptPathOverride?: string): void {
  const session = getSession(sessionId);
  if (!session || session.engine !== "claude") return;
  const sid = engineSessionId || session.engineSessionId || undefined;
  const transcriptPath = transcriptPathOverride || (sid ? findTranscriptForSession(sid) : undefined);
  const anchorIso = transcriptPath ? latestTranscriptTimestampIso(transcriptPath) : undefined;
  setAnchor(sessionId, anchorIso ?? new Date().toISOString());
}

function contentCompatible(persisted: string, transcript: string): boolean {
  return persisted === transcript || persisted.startsWith(transcript) || transcript.startsWith(persisted);
}

function rolesCompatible(message: SessionMessage, entry: TranscriptTailEntry): boolean {
  if (message.role === entry.role) return true;
  return message.role === "notification" && entry.role === "user" && isInternalNotificationPrompt(entry.content);
}

function findPersistedSequence(existing: SessionMessage[], entries: TranscriptTailEntry[]): SessionMessage[] | null {
  const recent = existing.filter((m) => !m.partial).slice(-Math.max(50, entries.length * 4));
  const matched: SessionMessage[] = [];
  let cursor = 0;
  for (const entry of entries) {
    let found: SessionMessage | undefined;
    for (; cursor < recent.length; cursor += 1) {
      const candidate = recent[cursor];
      if (rolesCompatible(candidate, entry) && contentCompatible(candidate.content, entry.content)) {
        found = candidate;
        cursor += 1;
        break;
      }
    }
    if (!found) return null;
    matched.push(found);
  }
  return matched;
}

/**
 * Persist any un-synced transcript tail for a session into the messages DB.
 * Primary trigger: an unclaimed Stop hook (PTY-native turn — no run() in
 * flight). Also callable without a payload as the on-load safety net.
 *
 * Returns the number of messages inserted. Emits `session:external-turn`
 * `{ sessionId }` when anything was persisted (the frontend refetches messages
 * on it).
 */
export function syncExternalTurn(
  sessionId: string,
  emit: (event: string, payload: unknown) => void,
  payload?: HookPayload,
): number {
  const session = getSession(sessionId);
  if (!session) {
    logger.info(`External-turn sync skipped: session ${sessionId} not found`);
    return 0;
  }
  // A run() owns the session — its completion path persists the turn.
  if (session.status === "running") return 0;

  const engineSessionId =
    (typeof payload?.session_id === "string" && payload.session_id) ||
    session.engineSessionId ||
    undefined;
  const transcriptPath =
    (typeof payload?.transcript_path === "string" && fs.existsSync(payload.transcript_path)
      ? payload.transcript_path
      : undefined) ?? (engineSessionId ? findTranscriptForSession(engineSessionId) : undefined);

  const anchorMs = anchorMsFor(session, sessionId);
  const entries = transcriptPath ? readTranscriptTail(transcriptPath, anchorMs) : null;

  if (entries === null) {
    // Transcript missing/unreadable. Better than dropping the turn: persist the
    // assistant text straight from the hook payload (no user prompt available)
    // and advance the anchor to now so a redelivered Stop can't duplicate it.
    const hookText = String(payload?.last_assistant_message ?? "").trim();
    if (!hookText) return 0;
    // Anchor can't dedup this path (no transcript timestamps) — guard against a
    // redelivered Stop by comparing against the newest persisted message.
    const existing = getMessages(sessionId);
    const newest = existing[existing.length - 1];
    if (newest && newest.role === "assistant" && newest.content === hookText) return 0;
    insertMessage(sessionId, "assistant", hookText);
    setAnchor(sessionId, new Date().toISOString());
    emit("session:external-turn", { sessionId });
    logger.info(
      `External turn persisted for session ${sessionId} from hook payload (transcript unreadable: ${transcriptPath ?? "not found"})`,
    );
    return 1;
  }
  if (entries.length === 0) return 0; // tail already synced — dedup no-op

  // Reconcile against the trailing DB rows before inserting. The chat run()
  // completion path (manager.ts user prompt + settled assistant) may have
  // ALREADY persisted this exact turn — and, because the Claude harness keeps
  // writing continuation entries ("Continue from where you left off." + more
  // assistant text) with timestamps NEWER than that persist, those entries slip
  // past the timestamp anchor and this sync re-reads the same turn. The settled
  // assistant row is often truncated at an early Stop, so the re-read text is a
  // superset (prefix-compatible). When the trailing rows mirror the tail in role
  // order and are prefix-compatible, UPGRADE them in place (fixes the cutoff)
  // instead of inserting duplicates (fixes the duplication). Otherwise this is a
  // genuine CLI-native turn run() never saw — insert as before.
  const db = initDb();
  const existing = getMessages(sessionId);
  const matchedPersistedTurn = findPersistedSequence(existing, entries);
  if (matchedPersistedTurn) {
    // run() already stored this turn — overwrite any truncated row with the
    // complete transcript text, write no new rows.
    const txn = db.transaction(() => {
      entries.forEach((e, i) => {
        const persisted = matchedPersistedTurn[i];
        if (persisted.role === e.role && e.content.length > persisted.content.length) {
          updateMessageContent(persisted.id, e.content);
        }
      });
    });
    txn();
    const newAnchor = entries[entries.length - 1].timestampIso;
    setAnchor(sessionId, newAnchor);
    emit("session:external-turn", { sessionId });
    logger.info(
      `Reconciled ${entries.length} already-persisted turn message(s) in place for session ${sessionId} (anchor → ${newAnchor}, no duplicates inserted)`,
    );
    return 0;
  }
  // One transaction for the whole tail (mirrors the transcript backfill).
  const txn = db.transaction((items: TranscriptTailEntry[]) => {
    for (const e of items) insertMessage(sessionId, e.role, e.content);
  });
  txn(entries);
  // A PTY-native first turn means the DB may not know the engine session yet —
  // adopt it so future resumes/backfills/syncs target the right transcript.
  if (!session.engineSessionId && engineSessionId) {
    updateSession(sessionId, { engineSessionId });
  }
  const newAnchor = entries[entries.length - 1].timestampIso;
  setAnchor(sessionId, newAnchor);
  emit("session:external-turn", { sessionId });
  logger.info(
    `Synced ${entries.length} external (CLI-native) message(s) for session ${sessionId} (anchor → ${newAnchor})`,
  );
  return entries.length;
}

/** Sessions with an in-flight on-load tail sync (mirrors backfillInProgress). */
const onLoadSyncInProgress = new Set<string>();

/**
 * On-load safety net: when serving session detail, fire-and-forget a tail sync
 * so a PTY-native turn whose Stop was missed entirely still lands. Cheap in the
 * common case — the transcript's mtime is compared against the anchor BEFORE
 * any parsing, so an untouched transcript costs one stat(). The GET itself is
 * never delayed; the frontend refetches on `session:external-turn`.
 */
export function scheduleOnLoadTailSync(
  sessionId: string,
  emit: (event: string, payload: unknown) => void,
): void {
  if (onLoadSyncInProgress.has(sessionId)) return;
  onLoadSyncInProgress.add(sessionId);
  setImmediate(() => {
    try {
      const session = getSession(sessionId);
      if (!session || session.engine !== "claude" || session.status === "running") return;
      if (!session.engineSessionId) return;
      const transcriptPath = findTranscriptForSession(session.engineSessionId);
      if (!transcriptPath) return;
      const anchorMs = anchorMsFor(session, sessionId);
      try {
        if (fs.statSync(transcriptPath).mtimeMs <= anchorMs) return; // nothing new
      } catch {
        return;
      }
      syncExternalTurn(sessionId, emit);
    } catch (err) {
      logger.warn(`On-load transcript tail sync failed for session ${sessionId}: ${err instanceof Error ? err.message : err}`);
    } finally {
      onLoadSyncInProgress.delete(sessionId);
    }
  });
}
