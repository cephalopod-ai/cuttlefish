import crypto from "node:crypto";
import { safeEqual } from "./auth-crypto.js";

// ── Scoped session tokens ─────────────────────────────────────────────────────
// Each session gets its own HMAC-signed token embedded in its system prompt.
// The token authenticates the session to the gateway API but is confined by
// scopedTokenForbidden — a prompt-injected agent cannot reach the operator
// control plane (config, auth, system management).

/**
 * Who is making an authenticated gateway request.
 * - `admin`   — the operator (dashboard cookie / CLI bearer with the gateway token).
 * - `session` — an agent acting on behalf of one session, holding a scoped token.
 *               Restricted by scopedTokenForbidden.
 */
export type GatewayPrincipal = { kind: "admin" } | { kind: "session"; sessionId: string };

const SCOPED_SESSION_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (session lifetime)

export function createScopedSessionToken(sessionId: string, secret: string, now = Date.now()): string {
  const expiresAt = now + SCOPED_SESSION_TOKEN_TTL_MS;
  const payload = `session:${sessionId}:${expiresAt}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyScopedSessionToken(token: string, secret: string, now = Date.now()): string | null {
  try {
    if (!secret || !token.startsWith("session:")) return null;
    const lastDot = token.lastIndexOf(".");
    if (lastDot < 0) return null;
    const payload = token.slice(0, lastDot);
    const sig = token.slice(lastDot + 1);
    const parts = payload.split(":");
    if (parts.length !== 3 || parts[0] !== "session") return null;
    const sessionId = parts[1];
    const expiresAt = Number(parts[2]);
    if (!sessionId || !Number.isFinite(expiresAt) || now > expiresAt) return null;
    const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
    return safeEqual(sig, expected) ? sessionId : null;
  } catch {
    return null;
  }
}

/**
 * Routes a session-scoped (agent) token must NOT reach — the operator control
 * plane. Agents keep the endpoints they legitimately need (spawn/message/read
 * sessions, scoped connector send, read org/email/status, push attachments).
 * Deny list (vs allow list) is deliberate for the "contained" scope.
 */
export function scopedTokenForbidden(method: string | undefined, pathname: string): boolean {
  const m = (method || "GET").toUpperCase();
  if (pathname === "/api/config" || pathname.startsWith("/api/config/")) return true;
  if (pathname === "/api/system" || pathname.startsWith("/api/system/")) return true;
  if (pathname === "/api/auth" || pathname.startsWith("/api/auth/")) return true;
  if (pathname === "/api/logs") return true;
  if (pathname === "/api/instances") return true;
  if (pathname === "/api/connectors/reload") return true;
  if (pathname.startsWith("/api/connectors/") && (pathname.endsWith("/incoming") || pathname.endsWith("/proxy"))) {
    return true;
  }
  // Org roster is readable; mutations (create/rename/rank/cliFlags/delete) are not.
  if ((pathname === "/api/org" || pathname.startsWith("/api/org/")) && m !== "GET") return true;
  return false;
}
