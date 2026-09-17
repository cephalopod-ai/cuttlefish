import { describe, expect, it } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

const { home } = withStaticTempCuttlefishHome("cuttlefish-internal-auth-");
const { apiAuthHeaders, jsonApiHeaders } = await import("../internal-auth.js");
const { authenticateGatewayRequest } = await import("../auth.js");

function authenticate(headers: Record<string, string>) {
  // Headers applies the casing normalization used at an HTTP transport boundary.
  return authenticateGatewayRequest({
    headers: Object.fromEntries(new Headers(headers)),
    socket: {},
  } as Parameters<typeof authenticateGatewayRequest>[0], "fixture-gateway-token", home);
}

describe("internal API authentication at the gateway boundary", () => {
  it("accepts the shared caller headers as an operator principal", () => {
    expect(authenticate(apiAuthHeaders("  fixture-gateway-token  "))).toEqual({
      ok: true, principal: { kind: "admin" },
    });
    expect(authenticate(jsonApiHeaders("fixture-gateway-token"))).toEqual({
      ok: true, principal: { kind: "admin" },
    });
  });

  it("keeps missing and incorrect credentials unauthorized", () => {
    expect(authenticate(apiAuthHeaders(undefined, { fallbackToGatewayInfo: false })).ok).toBe(false);
    expect(authenticate(jsonApiHeaders("incorrect-token")).ok).toBe(false);
    expect(jsonApiHeaders(undefined, { fallbackToGatewayInfo: false })).toEqual({
      "Content-Type": "application/json",
    });
  });

  it("preserves the strict gate for unsupported legacy token headers", () => {
    expect(authenticate({ "X-Cuttlefish-Token": "fixture-gateway-token" }).ok).toBe(false);
  });
});
