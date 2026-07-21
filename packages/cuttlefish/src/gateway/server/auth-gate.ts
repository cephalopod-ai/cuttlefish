import type { IncomingMessage } from "node:http";
import path from "node:path";
import {
  authenticateGatewayRequest,
  authRequiredForRequest,
  scopedTokenForbidden,
  scopedTokenChildDetailReadTarget,
  scopedTokenCollectionForbidden,
  scopedTokenSessionMismatch,
  type GatewayPrincipal,
} from "../auth.js";
import { isDirectChildSession } from "../manager-auth.js";

/**
 * Pure principal-resolution/authorization decision for the HTTP and WebSocket
 * transport layer. Kept separate from `transports.ts` (hard to unit-test
 * without a live server), mirroring `request-guards.ts`'s existing pattern.
 *
 * CF2-120 root cause: on the shipped default (loopback bind, `authRequired`
 * unset), `authRequiredNow()` is false, so — before this module existed — the
 * *entire* principal-resolution block in `transports.ts` (including
 * `scopedTokenForbidden` and `scopedTokenSessionMismatch`) lived inside a
 * single `if (authRequiredNow() && ...)` guard and never ran. Any caller,
 * including an agent subprocess presenting its own scoped session token, was
 * treated as unrestricted — `req.cuttlefishPrincipal` was never set, so
 * `connector-send-policy.ts`'s `authorizeConnectorSend` (which short-circuits
 * `allowed:true` whenever `principal?.kind !== "session"`) saw `undefined`
 * and let a scoped-token caller send outbound connector messages freely
 * (CF2-112).
 *
 * This function separates the two concerns:
 *   1. "Is auth required to let this request in at all?" — unchanged from
 *      before: only reject with 401 when `authRequiredNow()` and the route
 *      requires it. An unauthenticated loopback human sees no behavior
 *      change (`authRequiredNow()` is false by default, so this branch never
 *      fires for them).
 *   2. "If this request identifies itself via a scoped session token,
 *      constrain what it can do" — now runs unconditionally whenever a
 *      scoped token is *presented and valid*, regardless of `authRequiredNow()`.
 *      This is the actual fix: a presented scoped token is always honored as
 *      a constraint, and `principal` is always attached when resolvable, so
 *      downstream code (route handlers, `connector-send-policy.ts`) sees the
 *      real caller identity on loopback too.
 */
export interface PrincipalGateResult {
  status: 200 | 401 | 403;
  reason?: string;
  principal?: GatewayPrincipal;
}

/**
 * A session may propose an org change, but that proposal must carry the
 * session identity so its eventual human approval can be shown in the
 * originating chat.  Requiring a credential here also prevents an agent from
 * dropping its injected scoped token to make an anonymous, unowned proposal.
 */
function isOrgChangeProposal(method: string | undefined, rawPathname: string): boolean {
  return (method || "GET").toUpperCase() === "POST"
    && path.posix.normalize(rawPathname || "/").toLowerCase() === "/api/org/change-requests";
}

/** Human approval decisions are always operator actions, even on loopback. */
function isOperatorApprovalAction(method: string | undefined, rawPathname: string): boolean {
  if ((method || "GET").toUpperCase() !== "POST") return false;
  const pathname = path.posix.normalize(rawPathname || "/").toLowerCase();
  return /^\/api\/approvals\/[^/]+\/(approve|reject)$/.test(pathname)
    || /^\/api\/checkpoints\/[^/]+\/decision$/.test(pathname)
    || /^\/api\/org\/change-requests\/[^/]+\/(approve|reject|apply)$/.test(pathname);
}

export function resolvePrincipalGate(opts: {
  req: Pick<IncomingMessage, "headers" | "socket">;
  method: string | undefined;
  pathname: string;
  authRequiredNow: () => boolean;
  gatewayAuthToken: string;
  cuttlefishHome: string;
  isDirectChildSession?: (parentSessionId: string, childSessionId: string) => boolean;
}): PrincipalGateResult {
  const auth = authenticateGatewayRequest(opts.req, opts.gatewayAuthToken, opts.cuttlefishHome);

  // This route accepts both an operator and a scoped chat token.  It is not
  // governed by authRequiredNow(): without an identity the server cannot bind
  // the resulting approval to its source chat.
  if (isOrgChangeProposal(opts.method, opts.pathname) && !auth.ok) {
    return { status: 401, reason: auth.reason || "Authentication required to propose an org change" };
  }

  // An approval is an operator control, never a conversational acknowledgement.
  // Enforce this regardless of the loopback-friendly global auth setting.
  if (isOperatorApprovalAction(opts.method, opts.pathname)) {
    if (!auth.ok) return { status: 401, reason: auth.reason || "Operator authentication required to resolve approval" };
    if (auth.principal?.kind !== "admin") {
      return { status: 403, reason: "Only an operator can resolve approvals" };
    }
  }

  if (opts.authRequiredNow() && authRequiredForRequest(opts.method, opts.pathname) && !auth.ok) {
    return { status: 401, reason: auth.reason || "Unauthorized" };
  }

  if (auth.principal?.kind === "session") {
    if (scopedTokenForbidden(opts.method, opts.pathname)) {
      return { status: 403, reason: "Forbidden for session-scoped tokens" };
    }
    if (scopedTokenCollectionForbidden(opts.method, opts.pathname)) {
      return { status: 403, reason: "Forbidden: cross-session collection route for a session-scoped token" };
    }
    if (scopedTokenSessionMismatch(auth.principal.sessionId, opts.pathname)) {
      const childTarget = scopedTokenChildDetailReadTarget(opts.method, opts.pathname);
      const ownsDirectChild = childTarget !== null
        && (opts.isDirectChildSession ?? isDirectChildSession)(auth.principal.sessionId, childTarget);
      if (!ownsDirectChild) {
        return { status: 403, reason: "Forbidden: session-scoped token bound to a different session" };
      }
    }
  }

  return { status: 200, principal: auth.ok ? auth.principal : undefined };
}
