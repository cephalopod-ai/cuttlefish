/**
 * Cuttlefish Talk — session attachments (server side, leaf-level).
 *
 * A talk session can "adopt" ANY other session (an employee, the COO, a chat) as
 * an observe- or engage-target without owning it. Unlike delegation (which spawns
 * or continues a CHILD the talk session owns), an attachment is a soft link: the
 * orchestrator watches the target's progress (observe) and may relay a briefed
 * message to it (engage). The set is capped per talk session and PERSISTED by
 * merging a `talkAttachments` array into the talk session's existing
 * `transport_meta` JSON column, so it survives a reload.
 *
 * This module is deliberately LEAF-level: it imports no other talk module (no
 * graph.ts / delegate.ts) so T8's wake-on-completion can `import
 * { talkSessionsAttachedTo }` without a cycle. Persistence is injected
 * (getSession / patchSessionMeta) exactly like delegate.ts injects its deps;
 * the in-memory map is hydrated lazily from meta on first touch per talk session.
 * Module-level Maps + a `__resetForTest` seam follow the mute-state / tts-stream
 * precedent for per-session module state.
 */
import type { JsonObject, JsonValue, Session } from "../shared/types.js";

/** Max attachments a single talk session may hold at once. */
export const MAX_ATTACHMENTS = 5;

export type AttachMode = "observe" | "engage";

export interface Attachment {
  targetId: string;
  mode: AttachMode;
  /** Epoch ms when the attachment was created (plain Date.now — backend code). */
  since: number;
}

/** Injected persistence — uses the registry's atomic transport_meta patch seam. */
export interface AttachmentDeps {
  getSession: (id: string) => Session | undefined;
  patchSessionMeta: (id: string, patch: JsonObject) => void;
}

export type AttachResult =
  | { ok: true; attachment: Attachment }
  | { ok: false; error: string };

// talkSessionId → (targetId → Attachment). Hydrated lazily; the source of truth
// for reverse lookups (talkSessionsAttachedTo) at runtime.
const attachmentsByTalk = new Map<string, Map<string, Attachment>>();
// Talk sessions whose meta we've already read in — prevents re-hydration from
// clobbering in-memory writes made after the first touch.
const hydrated = new Set<string>();
// Set once a full cross-session scan (hydrateAllAttachments) has succeeded, so
// the wake path can find attachments on talk sessions nobody touched this process
// (e.g. after a gateway restart). Distinct from per-session `hydrated` markers.
let allHydrated = false;

/** Read persisted attachments into the in-memory map once per talk session. */
function hydrate(talkId: string, deps: Pick<AttachmentDeps, "getSession">): void {
  if (hydrated.has(talkId)) return;
  hydrated.add(talkId);
  const raw = deps.getSession(talkId)?.transportMeta?.talkAttachments;
  if (!Array.isArray(raw)) return;
  const map = new Map<string, Attachment>();
  for (const item of raw) {
    if (
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      typeof (item as JsonObject).targetId === "string" &&
      ((item as JsonObject).mode === "observe" || (item as JsonObject).mode === "engage")
    ) {
      const o = item as JsonObject;
      map.set(o.targetId as string, {
        targetId: o.targetId as string,
        mode: o.mode as AttachMode,
        since: typeof o.since === "number" ? o.since : Date.now(),
      });
    }
  }
  if (map.size > 0) attachmentsByTalk.set(talkId, map);
}

/** Persist the current attachment set without replacing concurrent metadata. */
function persist(talkId: string, deps: AttachmentDeps): void {
  const map = attachmentsByTalk.get(talkId);
  const arr: Attachment[] = map ? [...map.values()] : [];
  deps.patchSessionMeta(talkId, { talkAttachments: arr as unknown as JsonValue });
}

/**
 * Attach `targetId` to `talkId` in the given mode. Idempotent for an already-
 * attached target (updates its mode, not capped). Returns `{ok:false}` only when
 * adding a NEW target would exceed MAX_ATTACHMENTS.
 */
export function attach(
  talkId: string,
  targetId: string,
  mode: AttachMode,
  deps: AttachmentDeps,
): AttachResult {
  hydrate(talkId, deps);
  let map = attachmentsByTalk.get(talkId);
  if (map && !map.has(targetId) && map.size >= MAX_ATTACHMENTS) {
    return {
      ok: false,
      error: `attachment cap reached (${MAX_ATTACHMENTS}) for this talk session — detach one first`,
    };
  }
  if (!map) {
    map = new Map<string, Attachment>();
    attachmentsByTalk.set(talkId, map);
  }
  const attachment: Attachment = { targetId, mode, since: Date.now() };
  map.set(targetId, attachment);
  persist(talkId, deps);
  return { ok: true, attachment };
}

/** Remove an attachment. Returns true if one was removed, false if unknown. */
export function detach(talkId: string, targetId: string, deps: AttachmentDeps): boolean {
  hydrate(talkId, deps);
  const map = attachmentsByTalk.get(talkId);
  if (!map || !map.has(targetId)) return false;
  map.delete(targetId);
  if (map.size === 0) attachmentsByTalk.delete(talkId);
  persist(talkId, deps);
  return true;
}

/** The talk session's current attachments (creation order). */
export function listAttachments(talkId: string, deps: AttachmentDeps): Attachment[] {
  hydrate(talkId, deps);
  const map = attachmentsByTalk.get(talkId);
  return map ? [...map.values()] : [];
}

/**
 * Reverse map: which talk sessions are attached to `targetId`. Importable with no
 * deps (in-memory scan) so T8 can wake talk sessions on a target's completion
 * without a circular dep. Only reflects talk sessions already hydrated/touched in
 * this process — call hydrateAllAttachments first on the wake path so restarts
 * don't lose wakes.
 */
export function talkSessionsAttachedTo(targetId: string): string[] {
  const out: string[] = [];
  for (const [talkId, map] of attachmentsByTalk) {
    if (map.has(targetId)) out.push(talkId);
  }
  return out;
}

/** The mode a talk session holds on a target, if attached (in-memory scan, no deps). */
export function attachmentMode(talkId: string, targetId: string): AttachMode | undefined {
  return attachmentsByTalk.get(talkId)?.get(targetId)?.mode;
}

/** Deps for the one-time global hydration scan: read recent talk sessions + their meta. */
export interface HydrateAllDeps {
  getSession: (id: string) => Session | undefined;
  /** Recent talk sessions (newest first) whose attachment meta should be loaded. */
  listTalkSessions: () => Session[];
}

/**
 * One-time global hydration: load attachments from EVERY recent talk session's
 * persisted meta into the in-memory map. Guarded by a once-flag so it scans at
 * most once per process — the lazy fix for the restart-survival gap, where an
 * attached session could complete before anyone touched its talk session, losing
 * the wake. Best-effort: a listing failure leaves the flag clear so a later call
 * retries. Cheap thereafter (every subsequent call is a flag check).
 */
export function hydrateAllAttachments(deps: HydrateAllDeps): void {
  if (allHydrated) return;
  let talks: Session[];
  try {
    talks = deps.listTalkSessions();
  } catch {
    return; // leave allHydrated false so the next wake retries the scan
  }
  allHydrated = true;
  for (const t of talks) hydrate(t.id, deps);
}

/** Test seam: clear all in-memory attachment state + hydration markers. */
/** Forget a session's in-memory attachment state entirely (session delete).
 *  Covers both directions: its own attachments as a talk session, and any
 *  hydration marker — without this, deleted sessions accumulate entries for
 *  the daemon's lifetime. */
export function clearTalkAttachments(sessionId: string): void {
  attachmentsByTalk.delete(sessionId);
  hydrated.delete(sessionId);
}

export function __resetAttachmentsForTest(): void {
  attachmentsByTalk.clear();
  hydrated.clear();
  allHydrated = false;
}
