import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AUTH_COOKIE,
  createPtyAccessToken,
  handleAuthApiRequest,
  isAuthenticatedRequest,
  verifyPtyAccessToken,
} from "../auth.js";

function req(headers: Record<string, string | undefined> = {}): IncomingMessage {
  return { headers } as IncomingMessage;
}

function jsonReq(body: unknown, headers: Record<string, string | undefined> = {}): IncomingMessage {
  const r = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
  r.headers = { ...headers, "content-type": "application/json" };
  return r;
}

function captureRes(): { res: ServerResponse; cap: { status?: number; headers: Record<string, unknown>; body?: unknown } } {
  const cap: { status?: number; headers: Record<string, unknown>; body?: unknown } = { headers: {} };
  const res = {
    writeHead(status: number, headers?: Record<string, unknown>) {
      cap.status = status;
      cap.headers = headers ?? {};
      return this;
    },
    end(chunk?: unknown) {
      cap.body = chunk ? JSON.parse(String(chunk)) : undefined;
      return this;
    },
  } as unknown as ServerResponse;
  return { res, cap };
}

describe("gateway auth", () => {
  it("accepts bearer, x-cuttlefish-token, and auth cookie tokens", () => {
    expect(isAuthenticatedRequest(req({ authorization: "Bearer secret" }), "secret")).toBe(true);
    expect(isAuthenticatedRequest(req({ "x-cuttlefish-token": "secret" }), "secret")).toBe(true);
    expect(isAuthenticatedRequest(req({ cookie: `${AUTH_COOKIE}=secret` }), "secret")).toBe(true);
    expect(isAuthenticatedRequest(req({ authorization: "Bearer wrong" }), "secret")).toBe(false);
  });

  it("login sets an HttpOnly auth cookie only for the correct token", async () => {
    const ok = captureRes();
    await handleAuthApiRequest(jsonReq({ token: "secret" }), ok.res, "/api/auth/login", "POST", "secret");
    expect(ok.cap.status).toBe(200);
    expect(String(ok.cap.headers["Set-Cookie"])).toContain("HttpOnly");
    expect(String(ok.cap.headers["Set-Cookie"])).toContain(AUTH_COOKIE);

    const bad = captureRes();
    await handleAuthApiRequest(jsonReq({ token: "wrong" }), bad.res, "/api/auth/login", "POST", "secret");
    expect(bad.cap.status).toBe(401);
  });

  it("PTY access tokens are bound to the session id and expire", () => {
    const token = createPtyAccessToken("s1", "secret", 1_000);
    expect(verifyPtyAccessToken("s1", token, "secret", 2_000)).toBe(true);
    expect(verifyPtyAccessToken("s2", token, "secret", 2_000)).toBe(false);
    expect(verifyPtyAccessToken("s1", token, "wrong", 2_000)).toBe(false);
    expect(verifyPtyAccessToken("s1", token, "secret", 70_000)).toBe(false);
  });
});
