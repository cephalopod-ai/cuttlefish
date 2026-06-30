import crypto from "node:crypto";
import { safeEqual } from "./auth-crypto.js";

// ── PTY access tokens ─────────────────────────────────────────────────────────
// Short-lived HMAC tokens that bind a session id to a gateway secret so the
// WebSocket pty upgrade can be authenticated without an auth-cookie round-trip.

const PTY_TOKEN_TTL_MS = 60_000; // 60 s

export function createPtyAccessToken(sessionId: string, secret: string, now = Date.now()): string {
  const expiresAt = now + PTY_TOKEN_TTL_MS;
  const payload = `${sessionId}:${expiresAt}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyPtyAccessToken(sessionId: string, token: string, secret: string, now = Date.now()): boolean {
  try {
    const lastDot = token.lastIndexOf(".");
    if (lastDot < 0) return false;
    const payload = token.slice(0, lastDot);
    const sig = token.slice(lastDot + 1);
    const [sid, expiresStr] = payload.split(":");
    if (sid !== sessionId) return false;
    const expiresAt = Number(expiresStr);
    if (!Number.isFinite(expiresAt) || now > expiresAt) return false;
    const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
    return safeEqual(sig, expected);
  } catch {
    return false;
  }
}
