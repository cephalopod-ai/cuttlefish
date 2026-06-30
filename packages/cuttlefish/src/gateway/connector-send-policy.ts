import type { GatewayPrincipal } from "./auth.js";
import { getSession } from "../sessions/registry.js";
import { isUntrustedSource } from "../sessions/untrusted-input.js";

/**
 * Authorize a connector outbound `send` for the calling principal.
 *
 * Policy (pure, HTTP-free so it can be unit-tested directly):
 * - Admin principals (or no principal) are allowed; the route-level auth already
 *   established the operator identity.
 * - Session-scoped tokens may only send via the connector bound to their own
 *   session, and only when that session originated from a trusted source
 *   (web/cron). Untrusted-source sessions (email, slack, whatsapp) are blocked
 *   from the outbound send path entirely to prevent confused-deputy injection:
 *   a malicious inbound message must not be able to steer the model into sending
 *   authenticated outbound messages on the operator's behalf.
 */
export function authorizeConnectorSend(
  principal: GatewayPrincipal | undefined,
  connectorName: string,
  deps: { getSession: typeof getSession } = { getSession },
): { allowed: boolean; reason?: string } {
  if (principal?.kind !== "session") return { allowed: true };
  const callerSession = deps.getSession(principal.sessionId);
  if (!callerSession?.connector || callerSession.connector !== connectorName) {
    return { allowed: false, reason: "Session token may only send via its own connector" };
  }
  if (isUntrustedSource(callerSession.source)) {
    return {
      allowed: false,
      reason: "Sessions originating from external connectors or email may not send outbound messages",
    };
  }
  return { allowed: true };
}
