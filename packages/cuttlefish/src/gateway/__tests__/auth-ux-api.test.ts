import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleApiRequest, type ApiContext } from "../api.js";
import { createAuthSession } from "../auth.js";

function makeReq(
  method: string,
  url: string,
  opts: { body?: unknown; cookie?: string; remoteAddress?: string; userAgent?: string; authorization?: string; host?: string } = {},
): IncomingMessage {
  const raw = opts.body === undefined ? "" : JSON.stringify(opts.body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []) as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = {
    host: opts.host ?? "localhost",
    ...(opts.cookie ? { cookie: opts.cookie } : {}),
    ...(opts.userAgent ? { "user-agent": opts.userAgent } : {}),
    ...(opts.authorization ? { authorization: opts.authorization } : {}),
  };
  (req as any).socket = { remoteAddress: opts.remoteAddress ?? "127.0.0.1" };
  return req;
}

function makeRes() {
  let status = 200;
  let chunks: Buffer[] = [];
  const headers = new Map<string, unknown>();
  const res = {
    setHeader(name: string, value: unknown) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    writeHead(s: number, h?: Record<string, unknown>) {
      status = s;
      if (h) for (const [key, value] of Object.entries(h)) headers.set(key.toLowerCase(), value);
      return this;
    },
    end(buf?: Buffer | string) {
      if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
      return this;
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get header() {
      return (name: string) => headers.get(name.toLowerCase());
    },
    get body() {
      const raw = Buffer.concat(chunks).toString("utf-8");
      return raw ? JSON.parse(raw) : null;
    },
  };
}

function ctx(cuttlefishHome = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-auth-api-"))): ApiContext {
  return {
    gatewayAuthToken: "gateway-token",
    cuttlefishHome,
    getConfig: () => ({ gateway: { host: "0.0.0.0" }, engines: { default: "claude" } }),
    connectors: new Map(),
    startTime: Date.now(),
  } as unknown as ApiContext;
}

function browserCookie(cuttlefishHome: string, remoteAddress = "127.0.0.1"): string {
  const session = createAuthSession(
    cuttlefishHome,
    { headers: { "user-agent": "Mozilla/5.0" }, socket: { remoteAddress } } as any,
    { kind: remoteAddress === "127.0.0.1" ? "local" : "remote" },
  );
  return `cuttlefish_auth=${session.secret}; cuttlefish_device=${session.device.id}`;
}

describe("auth UX API routes", () => {
  it("reports safe auth state without exposing the token", async () => {
    const cap = makeRes();
    await handleApiRequest(makeReq("GET", "/api/auth/state", { remoteAddress: "100.64.1.2" }), cap.res, ctx());

    expect(cap.status).toBe(200);
    expect(cap.body).toMatchObject({
      authRequired: true,
      authenticated: false,
      canBootstrapLocal: false,
      networkExposed: true,
    });
    expect(JSON.stringify(cap.body)).not.toContain("gateway-token");
  });

  it("creates a loopback-only pairing code for an authenticated local browser", async () => {
    const context = ctx();
    const cap = makeRes();
    await handleApiRequest(
      makeReq("POST", "/api/auth/pairing-codes", {
        cookie: browserCookie((context as any).cuttlefishHome),
        remoteAddress: "127.0.0.1",
        body: {},
      }),
      cap.res,
      context,
    );

    expect(cap.status).toBe(200);
    expect(cap.body.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(new Date(cap.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(JSON.stringify(cap.body)).not.toContain("gateway-token");
  });

  it("rejects remote and proxied local bootstrap without setting cookies", async () => {
    const remote = makeRes();
    await handleApiRequest(
      makeReq("POST", "/api/auth/bootstrap", {
        remoteAddress: "100.64.1.2",
        host: "100.64.1.10:8888",
        body: {},
      }),
      remote.res,
      ctx(),
    );

    expect(remote.status).toBe(403);
    expect(remote.header("set-cookie")).toBeUndefined();

    const proxied = makeRes();
    await handleApiRequest(
      makeReq("POST", "/api/auth/bootstrap", {
        remoteAddress: "127.0.0.1",
        host: "tailnet.example.ts.net",
        body: {},
      }),
      proxied.res,
      ctx(),
    );

    expect(proxied.status).toBe(403);
    expect(proxied.header("set-cookie")).toBeUndefined();
  });

  it("rejects remote pairing-code creation", async () => {
    const context = ctx();
    const cap = makeRes();
    await handleApiRequest(
      makeReq("POST", "/api/auth/pairing-codes", {
        cookie: browserCookie((context as any).cuttlefishHome, "100.64.1.2"),
        remoteAddress: "100.64.1.2",
        body: {},
      }),
      cap.res,
      context,
    );

    expect(cap.status).toBe(403);
  });

  it("pairs a remote browser with a one-time code and sets the auth cookie", async () => {
    const context = ctx();
    const created = makeRes();
    await handleApiRequest(
      makeReq("POST", "/api/auth/pairing-codes", {
        cookie: browserCookie((context as any).cuttlefishHome),
        body: {},
      }),
      created.res,
      context,
    );

    const paired = makeRes();
    await handleApiRequest(
      makeReq("POST", "/api/auth/pair", {
        remoteAddress: "100.64.1.2",
        body: { code: created.body.code },
      }),
      paired.res,
      context,
    );

    expect(paired.status).toBe(200);
    expect(paired.body).toMatchObject({ status: "ok" });
    expect(String(paired.header("set-cookie"))).toContain("cuttlefish_auth=");
    expect(String(paired.header("set-cookie"))).toContain("cuttlefish_device=");
    expect(String(paired.header("set-cookie"))).toContain("HttpOnly");

    const reused = makeRes();
    await handleApiRequest(
      makeReq("POST", "/api/auth/pair", {
        remoteAddress: "100.64.1.2",
        body: { code: created.body.code },
      }),
      reused.res,
      context,
    );
    expect(reused.status).toBe(401);
  });

  it("rejects oversized public auth bodies before parsing", async () => {
    const cap = makeRes();
    await handleApiRequest(
      makeReq("POST", "/api/auth/pair", {
        remoteAddress: "100.64.1.2",
        body: { code: "A".repeat(20_000) },
      }),
      cap.res,
      ctx(),
    );

    expect(cap.status).toBe(413);
  });

  it("lists paired devices without exposing secrets", async () => {
    const context = ctx();
    const created = makeRes();
    await handleApiRequest(
      makeReq("POST", "/api/auth/bootstrap", {
        cookie: "cuttlefish_auth=gateway-token",
        remoteAddress: "127.0.0.1",
        userAgent: "Mozilla/5.0 Macintosh",
        body: {},
      }),
      created.res,
      context,
    );
    const cookie = Array.isArray(created.header("set-cookie"))
      ? created.header("set-cookie")
      : [created.header("set-cookie")];
    const cookieHeader = (cookie as string[]).map((part) => part.split(";")[0]).join("; ");

    const listed = makeRes();
    await handleApiRequest(makeReq("GET", "/api/auth/devices", { cookie: cookieHeader }), listed.res, context);

    expect(listed.status).toBe(200);
    expect(listed.body.devices).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        name: expect.any(String),
        current: true,
      }),
    ]);
    expect(JSON.stringify(listed.body)).not.toContain("gateway-token");
    expect(JSON.stringify(listed.body)).not.toContain("tokenHash");
  });

  it("revokes paired devices by id and clears cookies when revoking the current device", async () => {
    const context = ctx();
    const local = makeRes();
    await handleApiRequest(
      makeReq("POST", "/api/auth/bootstrap", {
        cookie: "cuttlefish_auth=gateway-token",
        remoteAddress: "127.0.0.1",
        userAgent: "Mozilla/5.0 Macintosh",
        body: {},
      }),
      local.res,
      context,
    );
    const localCookies = Array.isArray(local.header("set-cookie"))
      ? local.header("set-cookie")
      : [local.header("set-cookie")];
    const localCookieHeader = (localCookies as string[]).map((part) => part.split(";")[0]).join("; ");

    const pairingCode = makeRes();
    await handleApiRequest(
      makeReq("POST", "/api/auth/pairing-codes", {
        cookie: localCookieHeader,
        remoteAddress: "127.0.0.1",
        body: {},
      }),
      pairingCode.res,
      context,
    );

    const remote = makeRes();
    await handleApiRequest(
      makeReq("POST", "/api/auth/pair", {
        remoteAddress: "100.64.1.2",
        userAgent: "Mozilla/5.0 iPhone",
        body: { code: pairingCode.body.code },
      }),
      remote.res,
      context,
    );

    const remoteDeviceId = remote.body.device.id;
    const revokedRemote = makeRes();
    await handleApiRequest(
      makeReq("DELETE", `/api/auth/devices/${encodeURIComponent(remoteDeviceId)}`, {
        authorization: "Bearer gateway-token",
      }),
      revokedRemote.res,
      context,
    );

    expect(revokedRemote.status).toBe(200);
    expect(revokedRemote.body).toMatchObject({ status: "ok", current: false });

    const listed = makeRes();
    await handleApiRequest(
      makeReq("GET", "/api/auth/devices", { authorization: "Bearer gateway-token" }),
      listed.res,
      context,
    );
    expect((listed.body.devices as Array<{ id: string }>).map((device) => device.id)).not.toContain(remoteDeviceId);

    const localDeviceId = local.body.device.id;
    const revokedCurrent = makeRes();
    await handleApiRequest(
      makeReq("DELETE", `/api/auth/devices/${encodeURIComponent(localDeviceId)}`, {
        cookie: localCookieHeader,
      }),
      revokedCurrent.res,
      context,
    );

    expect(revokedCurrent.status).toBe(200);
    expect(revokedCurrent.body).toMatchObject({ status: "ok", current: true });
    expect(String(revokedCurrent.header("set-cookie"))).toContain("Max-Age=0");
    expect(String(revokedCurrent.header("set-cookie"))).toContain("cuttlefish_device=");
  });

  it("clears auth and device cookies on logout", async () => {
    const cap = makeRes();
    await handleApiRequest(makeReq("POST", "/api/auth/logout", { body: {} }), cap.res, ctx());

    expect(cap.status).toBe(200);
    expect(String(cap.header("set-cookie"))).toContain("Max-Age=0");
    expect(String(cap.header("set-cookie"))).toContain("cuttlefish_device=");
  });
});
