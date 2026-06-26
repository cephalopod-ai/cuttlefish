import fs from "node:fs";
import path from "node:path";
import type { Engine, Session } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { readBoardArray, writeBoardTickets, type BoardTicket } from "./board-service.js";
import { resolveBestSessionForTicket } from "./ticket-session-resolver.js";
import { DEFAULT_STALE_MS, sessionHasLiveTurn } from "./status-reconciler.js";

export interface OrphanedTicketReconcilerDeps {
  engines: Map<string, Engine>;
  orgDir: string;
  getSession: (id: string) => Session | undefined;
  listSessions: () => Session[];
  emit?: (event: string, payload: unknown) => void;
  now?: () => number;
  staleMs?: number;
  cause?: OrphanSweepCause;
}

export interface OrphanedTicketReconcileResult {
  boardsUpdated: number;
  ticketsUpdated: number;
}

export type OrphanSweepCause = "startup" | "periodic";

export interface OrphanedTicketDecision {
  shouldUpdate: boolean;
  blockedReason?: string;
}

function findSessionForTicket(ticket: Pick<BoardTicket, "id" | "sessionId">, sessions: Session[]): Session | undefined {
  return resolveBestSessionForTicket(ticket, sessions);
}

function orphanReason(
  ticket: Pick<BoardTicket, "id" | "sessionId" | "status">,
  session: Session | undefined,
  deps: { engines: Map<string, Engine>; getSession?: (id: string) => Session | undefined },
  now: number,
  staleMs: number,
  cause: OrphanSweepCause,
): string | null {
  const persistedSessionId = typeof ticket.sessionId === "string" ? ticket.sessionId.trim() : "";
  if (!persistedSessionId) return null;
  if (!session) {
    if (deps.getSession?.(persistedSessionId)) return null;
    return cause === "startup" ? "interrupted - gateway restarted" : "interrupted - worker died";
  }
  if (session.status === "interrupted") return "interrupted - gateway restarted";
  if (session.status === "error" || session.status === "idle") return "interrupted - worker died";
  if (session.status !== "running") return null;

  const last = session.lastActivity ? Date.parse(session.lastActivity) : Number.NaN;
  const staleFor = Number.isFinite(last) ? now - last : Number.POSITIVE_INFINITY;
  if (staleFor <= staleMs) return null;
  if (sessionHasLiveTurn(session, deps.engines)) return null;
  return "interrupted - worker died";
}

export function classifyOrphanedBoardTicket(
  ticket: Pick<BoardTicket, "id" | "sessionId" | "status">,
  sessions: Session[],
  deps: { engines: Map<string, Engine>; getSession?: (id: string) => Session | undefined },
  now: number,
  staleMs = DEFAULT_STALE_MS,
  cause: OrphanSweepCause = "periodic",
): OrphanedTicketDecision {
  if (ticket.status !== "in_progress") return { shouldUpdate: false };
  const sessionId = typeof ticket.sessionId === "string" ? ticket.sessionId.trim() : "";
  if (!sessionId) return { shouldUpdate: false };
  const session = findSessionForTicket(ticket, sessions);
  const blockedReason = orphanReason(ticket, session, deps, now, staleMs, cause);
  return blockedReason ? { shouldUpdate: true, blockedReason } : { shouldUpdate: false };
}

export function sweepOrphanedBoardTickets(
  tickets: BoardTicket[],
  sessions: Session[],
  deps: { engines: Map<string, Engine>; getSession?: (id: string) => Session | undefined },
  now: number,
  staleMs = DEFAULT_STALE_MS,
  cause: OrphanSweepCause = "periodic",
): number {
  let changed = 0;
  for (const ticket of tickets) {
    const decision = classifyOrphanedBoardTicket(ticket, sessions, deps, now, staleMs, cause);
    if (!decision.shouldUpdate) continue;
    ticket.status = "blocked";
    if (decision.blockedReason) ticket.blockedReason = decision.blockedReason;
    ticket.updatedAt = new Date(now).toISOString();
    changed++;
  }
  return changed;
}

export function reconcileOrphanedTickets(deps: OrphanedTicketReconcilerDeps): OrphanedTicketReconcileResult {
  const now = deps.now?.() ?? Date.now();
  const staleMs = deps.staleMs ?? DEFAULT_STALE_MS;
  const sessions = deps.listSessions();
  let boardsUpdated = 0;
  let ticketsUpdated = 0;

  let departments: fs.Dirent[];
  try {
    departments = fs.readdirSync(deps.orgDir, { withFileTypes: true });
  } catch (err) {
    logger.warn(`[orphaned-ticket-reconciler] failed to scan org dir: ${err instanceof Error ? err.message : String(err)}`);
    return { boardsUpdated, ticketsUpdated };
  }

  for (const department of departments) {
    if (!department.isDirectory()) continue;
    const boardPath = path.join(deps.orgDir, department.name, "board.json");
    if (!fs.existsSync(boardPath)) continue;

    let tickets: BoardTicket[] | null;
    try {
      tickets = readBoardArray(deps.orgDir, department.name);
    } catch (err) {
      logger.warn(
        `[orphaned-ticket-reconciler] ${department.name}/board.json invalid — skipping: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (!tickets) continue;

    let changed = false;
    const updated = sweepOrphanedBoardTickets(tickets, sessions, deps, now, staleMs, deps.cause ?? "periodic");
    changed = updated > 0;
    ticketsUpdated += updated;

    if (!changed) continue;

    try {
      writeBoardTickets(deps.orgDir, department.name, tickets);
    } catch (err) {
      logger.warn(
        `[orphaned-ticket-reconciler] failed to write ${department.name}/board.json: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    boardsUpdated++;
    deps.emit?.("board:updated", { department: department.name });
  }

  return { boardsUpdated, ticketsUpdated };
}
