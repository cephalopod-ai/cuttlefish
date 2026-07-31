import fs from "node:fs";
import { logger } from "../shared/logger.js";
import { readBoardArray, writeBoardTickets, type BoardTicket } from "./board-service.js";
import type { ApiContext } from "./api/context.js";
import { dispatchTicket, findDepartmentManager } from "./ticket-dispatch.js";
import { scanOrg } from "./org.js";
import { listSessions } from "../sessions/registry.js";
import { resolveBestSessionForTicket, sessionsForDepartment } from "./ticket-session-resolver.js";
import type { Session } from "../shared/types.js";

const STUCK_THRESHOLD_MS = 60 * 60 * 1000;
const DEFAULT_WATCHDOG_INTERVAL_MS = 60 * 60 * 1000;

export interface StuckTicketWatchdogDeps {
  context: ApiContext;
  orgDir: string;
  intervalMs?: number;
  stuckThresholdMs?: number;
  now?: () => number;
}

/**
 * A ticket whose session is still alive is not stuck — it is waiting.
 *
 * The alert this watchdog raises tells the manager the tickets are blocked
 * "with no active session" and invites re-assignment to a new agent. That claim
 * has to be true, or the manager is being told to start a duplicate run against
 * live work. The common false positive is the model-fallback approval path,
 * which blocks a ticket while its session sits waiting on a human — human
 * approvals routinely outlast the one-hour threshold.
 *
 * `sessions` must already be narrowed to this ticket's department: ticket ids
 * are unique only within a board, so an unscoped lookup would let a live session
 * in one department mask a genuinely dead ticket of the same id in another.
 */
function hasLiveSession(ticket: BoardTicket, sessions: Session[]): boolean {
  const session = resolveBestSessionForTicket(ticket, sessions);
  return session?.status === "running" || session?.status === "waiting";
}

function isStuck(ticket: BoardTicket, now: number, thresholdMs: number, sessions: Session[]): boolean {
  if (ticket.status !== "blocked") return false;
  if (ticket.manualOnly === true) return false;
  const updated = Date.parse(typeof ticket.updatedAt === "string" ? ticket.updatedAt : ticket.createdAt);
  if (!Number.isFinite(updated)) return false;
  if (now - updated < thresholdMs) return false;
  return !hasLiveSession(ticket, sessions);
}

function watchdogTicketId(department: string, now: number): string {
  return `watchdog-${department}-${now}`;
}

async function runWatchdog(deps: StuckTicketWatchdogDeps, now: number): Promise<void> {
  const threshold = deps.stuckThresholdMs ?? STUCK_THRESHOLD_MS;
  const registry = scanOrg();
  const sessions = listSessions();

  let departments: fs.Dirent[];
  try {
    departments = fs.readdirSync(deps.orgDir, { withFileTypes: true });
  } catch (err) {
    logger.warn(`[watchdog] failed to scan org dir: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  for (const entry of departments) {
    if (!entry.isDirectory()) continue;
    const department = entry.name;

    let tickets: BoardTicket[] | null;
    try {
      tickets = readBoardArray(deps.orgDir, department);
    } catch (err) {
      logger.warn(`[watchdog] ${department}/board.json unreadable: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (!tickets) continue;

    const departmentSessions = sessionsForDepartment(sessions, department);
    const stuck = tickets.filter((t) => isStuck(t, now, threshold, departmentSessions));
    if (stuck.length === 0) continue;

    logger.info(`[watchdog] ${department}: ${stuck.length} stuck ticket(s)`);

    const thresholdMin = Math.round(threshold / 60_000);
    const timestamp = new Date(now).toISOString();

    for (const ticket of stuck) {
      ticket.manualOnly = true;
      const note = `[watchdog ${timestamp}] Stuck blocked for >${thresholdMin}min — flagged for manual resolution.`;
      if (typeof ticket.description === "string" && !ticket.description.includes("[watchdog")) {
        ticket.description = ticket.description + "\n\n" + note;
      } else {
        ticket.description = note;
      }
      ticket.updatedAt = timestamp;
      logger.info(`[watchdog] ${department}/${ticket.id}: marked manualOnly`);
    }

    try {
      writeBoardTickets(deps.orgDir, department, tickets);
    } catch (err) {
      logger.warn(`[watchdog] failed to write ${department}/board.json: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const manager = findDepartmentManager(department, registry);
    if (!manager) {
      logger.info(`[watchdog] ${department}: no manager to notify, skipping dispatch`);
      continue;
    }

    const stuckSummary = stuck
      .map((t) => `- [${t.id}] ${t.title} (blocked: ${t.updatedAt})`)
      .join("\n");

    const alertId = watchdogTicketId(department, now);
    const alertTicket: BoardTicket = {
      id: alertId,
      title: `[Watchdog] ${stuck.length} stuck ticket${stuck.length === 1 ? "" : "s"} need investigation`,
      description:
        `The following ticket${stuck.length === 1 ? " has" : "s have"} been blocked for over ${thresholdMin} minutes ` +
        `with no active session. Please review, then re-assign to a new agent, move to backlog with findings, or resolve the underlying issue.\n\n` +
        stuckSummary,
      status: "todo",
      priority: "high",
      assignee: manager.name,
      source: "watchdog",
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    let latestTickets: BoardTicket[];
    try {
      latestTickets = readBoardArray(deps.orgDir, department) ?? [];
    } catch {
      latestTickets = tickets;
    }

    const alreadyExists = latestTickets.some(
      (t) => t.source === "watchdog" && t.status === "todo" && t.assignee === manager.name,
    );
    if (alreadyExists) {
      logger.info(`[watchdog] ${department}: active watchdog alert already pending, skipping`);
      continue;
    }

    latestTickets.push(alertTicket);
    try {
      writeBoardTickets(deps.orgDir, department, latestTickets);
    } catch (err) {
      logger.warn(`[watchdog] failed to write alert ticket for ${department}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const result = await dispatchTicket(
      department,
      alertId,
      { source: "watchdog", routeToManager: true },
      { context: deps.context, orgDir: deps.orgDir, now: () => now },
    );

    if (result.ok) {
      logger.info(`[watchdog] dispatched ${alertId} to ${manager.name} (session ${result.sessionId})`);
    } else {
      logger.warn(`[watchdog] dispatch failed for ${alertId}: ${result.reason}`);
    }
  }
}

export function startStuckTicketWatchdog(deps: StuckTicketWatchdogDeps): () => void {
  let isRunning = false;

  const tick = async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      const now = deps.now?.() ?? Date.now();
      await runWatchdog(deps, now);
    } catch (err) {
      logger.warn(`[watchdog] tick error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      isRunning = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, deps.intervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
