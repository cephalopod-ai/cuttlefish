import { isLoopbackHost, verifyPtyAccessToken } from "../auth.js";
import { isAllowedCorsOrigin } from "./http-static.js";

/**
 * Pure authorization decisions for the HTTP/WebSocket transport layer. Kept
 * separate from `transports.ts` (which is hard to unit-test without a live
 * server) so the security-critical rules below are directly testable.
 */

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * DNS-rebinding guard. When the gateway is bound to a loopback interface, the
 * only legitimate `Host` header is a loopback name. A remote page that rebinds
 * its domain to 127.0.0.1 still connects with `Host: <attacker-domain>`, so we
 * refuse it. When bound to a network host (an explicit opt-in), this check is a
 * no-op — that deployment is out of the loopback trust model.
 */
export function isHostAllowed(boundLoopback: boolean, reqHost: string | undefined): boolean {
  if (!boundLoopback) return true;
  return isLoopbackHost(reqHost);
}

/**
 * Defense-in-depth CSRF guard. A state-changing request that the browser itself
 * labels `Sec-Fetch-Site: cross-site` can never be a legitimate call from the
 * same-origin dashboard. Same-origin and same-site (cross-port dev server) pass;
 * non-browser clients (curl, the agent) omit the header and authenticate with a
 * bearer token, which is not forgeable cross-site. (Cross-origin requests are
 * also already rejected by the CORS gate; this is a second, explicit layer.)
 */
export function isBlockedCrossSiteWrite(
  method: string | undefined,
  secFetchSite: string | undefined,
): boolean {
  if (!MUTATING_METHODS.has((method || "GET").toUpperCase())) return false;
  return secFetchSite === "cross-site";
}

/**
 * Authorization for a `/ws/pty/:id` WebSocket upgrade. WebSockets bypass CORS,
 * so without this a malicious web page open in the operator's browser could open
 * a live terminal to the loopback gateway. We require, in addition to the normal
 * gateway auth gate enforced in `transports.ts`:
 *   1. a loopback Host (rebinding guard),
 *   2. a same-origin / allowed Origin, and
 *   3. a valid, session-bound PTY access token (the web client already mints and
 *      sends `?token=`; minted with the same secret = the gateway api token).
 */
export function isPtyUpgradeAllowed(opts: {
  boundLoopback: boolean;
  reqHost: string | undefined;
  origin: string | undefined;
  sessionId: string;
  token: string;
  secret: string;
  now?: number;
}): boolean {
  if (!isHostAllowed(opts.boundLoopback, opts.reqHost)) return false;
  if (!isAllowedCorsOrigin(opts.origin, opts.reqHost)) return false;
  if (!opts.secret) return false;
  return verifyPtyAccessToken(opts.sessionId, opts.token, opts.secret, opts.now);
}
