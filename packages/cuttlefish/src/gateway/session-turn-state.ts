import type { Session, JsonObject } from "../shared/types.js";
import { getSession, patchSessionTransportMeta } from "../sessions/registry.js";

/**
 * "Superseded running turn" transport-meta marker helpers.
 *
 * Extracted from `api.ts` (audit AS-001) without behavior change. When a new
 * turn interrupts a still-running one, the old turn is marked superseded so its
 * late completion can be discarded instead of clobbering the new turn's state.
 */

export const SUPERSEDED_TURN_META_KEY = "supersededRunningTurnAt";

export function withTransportMeta(session: Session, updates: JsonObject): JsonObject {
  const base =
    session.transportMeta && typeof session.transportMeta === "object" && !Array.isArray(session.transportMeta)
      ? session.transportMeta
      : {};
  return { ...base, ...updates };
}

export function supersedeRunningTurn(session: Session): void {
  patchSessionTransportMeta(session.id, { [SUPERSEDED_TURN_META_KEY]: new Date().toISOString() });
}

export function clearSupersededTurnMeta(sessionId: string): void {
  const session = getSession(sessionId);
  const meta = session?.transportMeta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta) || !(SUPERSEDED_TURN_META_KEY in meta)) return;
  patchSessionTransportMeta(sessionId, (current) => {
    const next = { ...current };
    delete next[SUPERSEDED_TURN_META_KEY];
    return next;
  });
}

export function isTurnSuperseded(sessionId: string, turnStartedAt: number): boolean {
  const marker = getSession(sessionId)?.transportMeta?.[SUPERSEDED_TURN_META_KEY];
  if (typeof marker !== "string") return false;
  const markedAt = new Date(marker).getTime();
  return Number.isFinite(markedAt) && markedAt >= turnStartedAt;
}
