import { beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import type { ApiContext } from "../api/context.js";

const { home } = withStaticTempCuttlefishHome("cuttlefish-auth-principal-policy-");
vi.mock("../auth.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../auth.js")>(),
  authenticateGatewayRequest: vi.fn(),
  // Harmless producer stub: no real code, auth session or pairing state minted.
  issuePairingCode: vi.fn(() => ({ code: "FIXTURE", expiresAt: Date.now() + 1000 })),
}));
const auth = await import("../auth.js");
const { handleAuthRoutes } = await import("../api/routes/auth.js");

function fixture(remoteAddress = "127.0.0.1", bearer = false) {
  const req = Object.assign(Readable.from([]), {
    headers: { host: "localhost", ...(bearer ? { authorization: "Bearer fixture-token" } : {}) },
    socket: { remoteAddress },
  }) as unknown as IncomingMessage;
  const result = { status: 0 };
  const res = {
    writeHead(status: number) { result.status = status; return this; }, end() {},
  } as unknown as ServerResponse;
  const context = { cuttlefishHome: home, gatewayAuthToken: "fixture-token" } as ApiContext;
  return { req, res, context, result };
}

beforeEach(() => { vi.clearAllMocks(); });

describe("protected pairing producer principal", () => {
  it("refuses a synthetic session principal before invoking the producer", async () => {
    vi.mocked(auth.authenticateGatewayRequest).mockReturnValue({ ok: true, principal: { kind: "session", sessionId: "fixture-session" } });
    const f = fixture();
    await handleAuthRoutes("POST", "/api/auth/pairing-codes", f.req, f.res, f.context);
    expect(f.result.status).toBe(403);
    expect(auth.issuePairingCode).not.toHaveBeenCalled();
  });

  it.each([["local cookie", "127.0.0.1", false], ["operator bearer", "192.0.2.1", true]] as const)(
    "preserves the intended admin %s control", async (_name, remote, bearer) => {
      vi.mocked(auth.authenticateGatewayRequest).mockReturnValue({ ok: true, principal: { kind: "admin" } });
      const f = fixture(remote, bearer);
      await handleAuthRoutes("POST", "/api/auth/pairing-codes", f.req, f.res, f.context);
      expect(f.result.status).toBe(200);
      expect(auth.issuePairingCode).toHaveBeenCalledOnce();
    },
  );

  it("retains the nonlocal browser restriction even for an admin principal", async () => {
    vi.mocked(auth.authenticateGatewayRequest).mockReturnValue({ ok: true, principal: { kind: "admin" } });
    const f = fixture("192.0.2.1");
    await handleAuthRoutes("POST", "/api/auth/pairing-codes", f.req, f.res, f.context);
    expect(f.result.status).toBe(403);
    expect(auth.issuePairingCode).not.toHaveBeenCalled();
  });

  it("retains invalid-credential refusal", async () => {
    vi.mocked(auth.authenticateGatewayRequest).mockReturnValue({ ok: false });
    const f = fixture();
    await handleAuthRoutes("POST", "/api/auth/pairing-codes", f.req, f.res, f.context);
    expect(f.result.status).toBe(401);
    expect(auth.issuePairingCode).not.toHaveBeenCalled();
  });
});
