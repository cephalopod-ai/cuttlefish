import crypto from "node:crypto";

// Shared crypto primitives for the gateway auth modules (auth.ts, pty-auth.ts,
// scoped-token.ts). Kept in a dedicated low-level module so the token modules do
// not have to import back through auth.ts, which re-exports them.

export function createAuthToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
