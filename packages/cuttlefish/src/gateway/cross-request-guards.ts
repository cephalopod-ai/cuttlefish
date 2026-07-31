/**
 * Cross-department service-request guards.
 *
 * These are the domain rules a cross-request must satisfy before a provider
 * session is created: who the caller is allowed to speak for, and whether this
 * hop would close a loop or nest too deep. They live here rather than in
 * `api/routes/org.ts` because the router contract in `AGENTS.md` limits router
 * files to registering routes, parsing shallow adapter input, calling domain
 * services, and translating results — validation algorithms and persisted-state
 * traversal belong in a focused module.
 *
 * Both guards return a typed decision; mapping a decision onto an HTTP status is
 * the router's job.
 */
import type { GatewayPrincipal } from "./auth.js";
import type { Session } from "../shared/types.js";

/** Hard ceiling on how deep a chain of cross-department requests may nest. */
export const MAX_CROSS_REQUEST_CHAIN_DEPTH = 4;

export interface CrossRequestHop {
  fromEmployee: string;
  provider: string;
}

export type CrossRequestIdentity =
  | { ok: true; fromEmployee: string; parentSessionId: string | undefined }
  | { ok: false; error: string; code: "cross_request_identity_mismatch" };

export type CrossRequestChainDecision =
  | { ok: true }
  | {
      ok: false;
      error: string;
      code: "cross_request_cycle" | "cross_request_depth_exceeded";
      chain: string[];
    };

export interface CrossRequestSessionLookup {
  getSession: (id: string) => Session | undefined;
}

function readCrossRequestHop(session: Pick<Session, "transportMeta"> | undefined): CrossRequestHop | null {
  const meta = session?.transportMeta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const raw = (meta as Record<string, unknown>).crossRequest;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const hop = raw as Record<string, unknown>;
  const fromEmployee = typeof hop.fromEmployee === "string" ? hop.fromEmployee : "";
  const provider = typeof hop.provider === "string" ? hop.provider : "";
  if (!fromEmployee || !provider) return null;
  return { fromEmployee, provider };
}

function describeHop(hop: CrossRequestHop): string {
  return `${hop.fromEmployee}→${hop.provider}`;
}

/**
 * Resolve who this request actually speaks for.
 *
 * A session-scoped caller speaks only for itself. Without this, `fromEmployee`
 * and `parentSessionId` are body-claimed: an agent could attribute a request to
 * any colleague — the provider's brief names the requester as a trusted peer —
 * and could graft its work under an unrelated session, including someone else's
 * talk thread. Binding the caller to its own session also gives the chain walk
 * below a real edge to follow. Non-session callers (the operator/UI) keep the
 * requested values.
 */
export function resolveCrossRequestIdentity(input: {
  principal: GatewayPrincipal | undefined;
  fromEmployee: string;
  parentSessionId: string | undefined;
  lookup: CrossRequestSessionLookup;
}): CrossRequestIdentity {
  if (input.principal?.kind !== "session") {
    return { ok: true, fromEmployee: input.fromEmployee, parentSessionId: input.parentSessionId };
  }
  const callerSession = input.lookup.getSession(input.principal.sessionId);
  if (!callerSession?.employee || callerSession.employee !== input.fromEmployee) {
    return {
      ok: false,
      code: "cross_request_identity_mismatch",
      error: "A session-scoped caller may only submit cross-requests as its own employee",
    };
  }
  return { ok: true, fromEmployee: callerSession.employee, parentSessionId: callerSession.id };
}

/**
 * Reject a cross-request that would close a loop or nest too deep.
 *
 * A provider session may raise its own cross-request, so these chain. Walking
 * the parent-session links gives the hops already on this branch; a repeated
 * `(requester → provider)` pair means the work has come back around to a pair
 * that already ran, which never terminates on its own.
 */
export function evaluateCrossRequestChain(input: {
  parentSessionId: string | undefined;
  fromEmployee: string;
  provider: string;
  lookup: CrossRequestSessionLookup;
}): CrossRequestChainDecision {
  const hops: CrossRequestHop[] = [];
  const seenSessions = new Set<string>();
  let cursor = input.parentSessionId;
  while (cursor && !seenSessions.has(cursor)) {
    seenSessions.add(cursor);
    const session = input.lookup.getSession(cursor);
    if (!session) break;
    const hop = readCrossRequestHop(session);
    if (hop) hops.push(hop);
    cursor = session.parentSessionId ?? undefined;
  }

  const chain = [...hops].reverse().map(describeHop);
  const pending = describeHop({ fromEmployee: input.fromEmployee, provider: input.provider });

  if (hops.some((hop) => hop.fromEmployee === input.fromEmployee && hop.provider === input.provider)) {
    return {
      ok: false,
      code: "cross_request_cycle",
      error: `Cross-request cycle detected: ${pending} already appears in this request chain`,
      chain: [...chain, pending],
    };
  }
  if (hops.length >= MAX_CROSS_REQUEST_CHAIN_DEPTH) {
    return {
      ok: false,
      code: "cross_request_depth_exceeded",
      error: `Cross-request chain exceeded the maximum depth of ${MAX_CROSS_REQUEST_CHAIN_DEPTH}`,
      chain: [...chain, pending],
    };
  }
  return { ok: true };
}
