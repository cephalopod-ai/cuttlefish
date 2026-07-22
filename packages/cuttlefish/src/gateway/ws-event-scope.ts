import type { GatewayPrincipal } from "./scoped-token.js";

export interface WsEventScopeSession {
  parentSessionId?: string | null;
}

export function payloadSessionId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as { sessionId?: unknown }).sessionId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function canSendWsEventToPrincipal(
  principal: GatewayPrincipal | undefined,
  payload: unknown,
  getSession: (sessionId: string) => WsEventScopeSession | undefined,
): boolean {
  if (principal?.kind !== "session") return true;
  const sessionId = payloadSessionId(payload);
  if (!sessionId) return false;
  if (sessionId.toLowerCase() === principal.sessionId.toLowerCase()) return true;
  const session = getSession(sessionId);
  return session?.parentSessionId?.toLowerCase() === principal.sessionId.toLowerCase();
}
