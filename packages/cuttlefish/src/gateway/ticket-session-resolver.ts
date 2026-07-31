import type { Session } from "../shared/types.js";
import type { BoardTicket } from "./board-service.js";

const TICKET_CHANNEL_KEYS = ["channel", "thread", "ticketId"] as const;
const STALLED_ERROR_PREFIX = "Stalled:";

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boardMeta(session: Session): Record<string, unknown> | null {
  return asObject(session.transportMeta);
}

function replyMeta(session: Session): Record<string, unknown> | null {
  return asObject(session.replyContext);
}

export interface ResolvedTicketSessionFallbackState {
  active: boolean;
  fromEngine: string | null;
  toEngine: string | null;
  toModel: string | null;
}

function modelFallbackMeta(session: Pick<Session, "transportMeta">): Record<string, unknown> | null {
  return asObject(asObject(session.transportMeta)?.modelFallback);
}

function fallbackEndpoint(value: unknown): Record<string, unknown> | null {
  return asObject(value);
}

export function resolveTicketSessionFailureReason(session: Pick<Session, "transportMeta" | "lastError">): string | null {
  const fallback = modelFallbackMeta(session);
  if (typeof fallback?.reason === "string" && fallback.reason.trim()) return fallback.reason;
  if (typeof session.lastError === "string" && session.lastError.startsWith(STALLED_ERROR_PREFIX)) return "timeout";
  return null;
}

export function resolveTicketSessionStalled(session: Pick<Session, "lastError">): boolean {
  return typeof session.lastError === "string" && session.lastError.startsWith(STALLED_ERROR_PREFIX);
}

export function resolveTicketSessionFallbackState(
  session: Pick<Session, "transportMeta">,
): ResolvedTicketSessionFallbackState | null {
  const fallback = modelFallbackMeta(session);
  if (!fallback) return null;
  const from = fallbackEndpoint(fallback.from);
  const to = fallbackEndpoint(fallback.to);
  const status = typeof fallback.status === "string" ? fallback.status : null;
  return {
    active: status === "running_on_fallback",
    fromEngine: typeof from?.engine === "string" ? from.engine : null,
    toEngine: typeof to?.engine === "string" ? to.engine : null,
    toModel: typeof to?.model === "string" ? to.model : null,
  };
}

function sessionChannelCandidates(session: Session): string[] {
  const values = new Set<string>();
  const transport = boardMeta(session);
  const reply = replyMeta(session);
  for (const key of TICKET_CHANNEL_KEYS) {
    const transportValue = transport?.[key];
    if (typeof transportValue === "string" && transportValue.trim()) values.add(transportValue);
    const replyValue = reply?.[key];
    if (typeof replyValue === "string" && replyValue.trim()) values.add(replyValue);
  }
  if (session.sessionKey?.trim()) values.add(session.sessionKey);
  if (session.sourceRef?.trim()) values.add(session.sourceRef);
  return [...values];
}

/**
 * Whether `session` is the session behind `ticket`.
 *
 * Matching runs strongest-signal-first: an explicit `boardTicketId`, then an
 * exact persisted `sessionId`/`engineSessionId` link, and only then the weak
 * fallback of finding the id inside a composite channel key.
 *
 * `department` narrows ONLY that weak fallback. Ticket ids are unique just
 * within a board, so `<source>:<department>:<ticketId>` keys from two
 * departments are otherwise indistinguishable — but the strong links above are
 * already unambiguous, and gating them on a department heuristic would discard
 * real matches (a session key like `cross-request:<timestamp>:<provider>` has
 * the same shape as a board key without being one).
 */
export function sessionMatchesTicket(
  ticket: Pick<BoardTicket, "id" | "sessionId">,
  session: Session,
  department?: string,
): boolean {
  const transport = boardMeta(session);
  if (transport && transport.boardTicketId === ticket.id) {
    // A session that names a different board is another department's ticket of
    // the same id; anything else (including no recorded board) still matches.
    const recorded = transport.boardDepartment;
    if (department && typeof recorded === "string" && recorded && recorded !== department) return false;
    return true;
  }

  const persistedSessionId = typeof ticket.sessionId === "string" ? ticket.sessionId.trim() : "";
  if (persistedSessionId) {
    if (session.id === persistedSessionId) return true;
    if (session.engineSessionId === persistedSessionId) return true;
  }

  // Weak fallback. With a department in hand, require the key to carry that
  // department segment immediately before the ticket id, which is exactly the
  // shape board keys have.
  const needle = department ? `${department}:${ticket.id}` : ticket.id;
  return sessionChannelCandidates(session).some((candidate) => containsTicketIdSegment(candidate, needle));
}

/**
 * Ticket ids appear inside composite keys like `board:<dept>:<ticketId>`, so the
 * match has to be substring-based — but a raw `includes` also makes `ticket-1`
 * match `ticket-10`'s sessions, which silently binds one ticket's feedback to
 * another's session (and can leave the shorter-id ticket wedged `in_progress`
 * forever behind its neighbour's live session). Require the id to occupy whole
 * delimiter-bounded segments instead.
 */
function containsTicketIdSegment(candidate: string, ticketId: string): boolean {
  if (!ticketId) return false;
  let from = 0;
  for (;;) {
    const at = candidate.indexOf(ticketId, from);
    if (at < 0) return false;
    const before = at === 0 ? "" : candidate[at - 1];
    const afterIndex = at + ticketId.length;
    const after = afterIndex >= candidate.length ? "" : candidate[afterIndex];
    if (!isTicketIdBodyChar(before) && !isTicketIdBodyChar(after)) return true;
    from = at + 1;
  }
}

/**
 * Characters that would make an adjacent position part of a longer id. Board
 * keys are colon-delimited (`<source>:<department>:<ticketId>[:<ts>]`), so
 * treating `-`/`_` as id body — not as a boundary — is what makes `ticket-1`
 * stop matching both `ticket-10` and `ticket-1-retry`.
 */
function isTicketIdBodyChar(char: string): boolean {
  return char !== "" && /[A-Za-z0-9_-]/.test(char);
}

export function resolveBestSessionForTicket<T extends Pick<BoardTicket, "id" | "sessionId">>(
  ticket: T,
  sessions: Session[],
  department?: string,
): Session | undefined {
  return sessions
    .filter((session) => sessionMatchesTicket(ticket, session, department))
    .sort((a, b) => Date.parse(b.lastActivity || "") - Date.parse(a.lastActivity || ""))[0];
}

export function shouldExposeSessionForTicket(
  ticket: Pick<BoardTicket, "status">,
  session: Pick<Session, "status" | "transportMeta" | "lastError">,
): boolean {
  if (session.status === "running" || session.status === "waiting") return true;
  if (ticket.status === "in_progress") return true;
  if (ticket.status !== "blocked") return false;
  return (
    session.status === "error" ||
    session.status === "interrupted" ||
    resolveTicketSessionStalled(session) ||
    resolveTicketSessionFailureReason(session) !== null
  );
}

export function findBoardTicketForSession(
  tickets: BoardTicket[],
  session: Session,
  fallbackTicketId: string,
): BoardTicket | undefined {
  const transport = boardMeta(session);
  const boardTicketId = typeof transport?.boardTicketId === "string" ? transport.boardTicketId : null;
  return tickets.find((ticket) =>
    ticket &&
    (
      (boardTicketId !== null && ticket.id === boardTicketId) ||
      ticket.sessionId === session.id ||
      ticket.id === fallbackTicketId
    ),
  );
}
