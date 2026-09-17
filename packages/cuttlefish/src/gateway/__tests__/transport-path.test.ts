import { afterEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

const { home } = withStaticTempCuttlefishHome("cuttlefish-transport-path-");
vi.mock("../server/auth-gate.js", () => ({ resolvePrincipalGate: vi.fn(() => ({ status: 200 })) }));
const { resolvePrincipalGate } = await import("../server/auth-gate.js");
const { createGatewayTransports } = await import("../server/transports.js");
type Deps = Parameters<typeof createGatewayTransports>[0];

afterEach(() => { vi.clearAllMocks(); });

describe("transport dispatch pathname contract", () => {
  it.each(["/api/example/../status?probe=benign", "/api/status?probe=benign"])(
    "gates the same benign pathname the API dispatches: %s", async (target) => {
      const dispatch = vi.fn((_req: IncomingMessage, res: ServerResponse) => res.end());
      const transport = createGatewayTransports({
        apiContext: {}, authRequiredNow: () => true, gatewayAuthToken: "fixture-token",
        gatewayName: "Fixture", handleApiRequest: dispatch, handleTwilioWebhook: vi.fn(),
        host: "127.0.0.1", cuttlefishHome: home, port: 0, ptyViewEngines: {},
        getSession: () => undefined, webDir: home, wsClients: new Set(),
        a2aAdapter: { handles: () => false },
      } as unknown as Deps);
      try {
        const handler = transport.server.listeners("request")[0] as (req: IncomingMessage, res: ServerResponse) => Promise<void>;
        // Direct listener fixture: no HTTP listener, network or credential use.
        const req = { url: target, method: "GET", headers: { host: "localhost" } } as IncomingMessage;
        const res = { setHeader() {}, writeHead() {}, end() {} } as unknown as ServerResponse;
        await handler(req, res);
        expect(resolvePrincipalGate).toHaveBeenCalledWith(expect.objectContaining({ pathname: new URL(target, "http://localhost").pathname }));
        expect(dispatch).toHaveBeenCalledWith(req, res);
      } finally {
        transport.stopWsHeartbeat(); transport.wss.close(); transport.ptyWss.close(); transport.server.close();
      }
    },
  );
});
