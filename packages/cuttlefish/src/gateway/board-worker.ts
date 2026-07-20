import { getSession, listSessions } from "../sessions/registry.js";
import { normalizeBoardWorkerConfig } from "../shared/config.js";
import { logger } from "../shared/logger.js";
import { getEngineUsageStatus, type UsageStatus } from "../shared/usage-status.js";
import { readBoardArray, boardTicketComplexity, type BoardTicket, type BoardTicketComplexity } from "./board-service.js";
import type { ApiContext } from "./api/context.js";
import { dispatchTicket, findDepartmentManager } from "./ticket-dispatch.js";
import { scanOrg } from "./org.js";
import { isCwdInAutonomousProject, resolveAutonomousProject, type AutonomousProject } from "./autonomous-mode.js";

/** Throttle the board-worker usage-skip signal so an exhausted-quota department
 *  logs its reason at most once per interval instead of every tick (audit H6). */
const USAGE_SKIP_LOG_INTERVAL_MS = 15 * 60 * 1000;
const lastUsageSkipLogAt = new Map<string, number>();
function logBoardWorkerUsageSkip(department: string, engine: string, now: number): void {
  const last = lastUsageSkipLogAt.get(department) ?? 0;
  if (now - last < USAGE_SKIP_LOG_INTERVAL_MS) return;
  lastUsageSkipLogAt.set(department, now);
  logger.warn(
    `[board-worker] ${department}: idle — reason=usage-exhausted engine=${engine}; TODO tickets are held until quota recovers`,
  );
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const PRIORITY_RANK: Record<string, number> = { low: 1, medium: 2, high: 3 };
const INTERACTIVE_SOURCES = new Set(["web", "talk"]);

export interface BoardWorkerDeps {
  context: ApiContext;
  orgDir: string;
  intervalMs?: number;
  now?: () => number;
}

export interface SessionLikeForIdle {
  source: string;
  lastActivity: string;
}

export interface TicketCandidate {
  department: string;
  ticket: BoardTicket;
  manager: { name: string; engine: string };
}

function parseLocalParts(now: number, timezone: string): { weekday: number; minutes: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(now));
  const weekdayText = parts.find((part) => part.type === "weekday")?.value ?? "Mon";
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return { weekday: weekdayMap[weekdayText] ?? 1, minutes: (hour * 60) + minute };
}

function parseClockMinutes(clock: string): number {
  const [hour, minute] = clock.split(":").map((part) => Number(part));
  return (hour * 60) + minute;
}

export function isWithinBoardWorkerWindow(
  now: number,
  timezone: string,
  schedule: { weekday: { start: string; end: string }; weekend: { start: string; end: string } },
): boolean {
  const local = parseLocalParts(now, timezone);
  const window = local.weekday === 0 || local.weekday === 6 ? schedule.weekend : schedule.weekday;
  const start = parseClockMinutes(window.start);
  const end = parseClockMinutes(window.end);
  if (start === end) return true;
  if (start < end) return local.minutes >= start && local.minutes < end;
  return local.minutes >= start || local.minutes < end;
}

export function isChatIdle(
  sessions: SessionLikeForIdle[],
  idleMinutes: number,
  now: number,
): boolean {
  const thresholdMs = Math.max(0, idleMinutes) * 60_000;
  return !sessions.some((session) => {
    if (!INTERACTIVE_SOURCES.has(session.source)) return false;
    const last = Date.parse(session.lastActivity);
    return Number.isFinite(last) && now - last <= thresholdMs;
  });
}

export function usageModeForStatus(
  status: UsageStatus,
  minRemainingPercent: number,
): "skip" | "low-only" | "all" {
  if (status.state === "exhausted") return "skip";
  if (typeof status.remainingPercent === "number" && status.remainingPercent < minRemainingPercent) {
    return "skip";
  }
  if (status.state === "low") return "low-only";
  return "all";
}

function priorityRank(priority: string | undefined): number {
  return PRIORITY_RANK[priority ?? ""] ?? PRIORITY_RANK.medium;
}

function createdAtMs(ticket: BoardTicket): number {
  const parsed = Date.parse(ticket.createdAt);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

export function rankBoardWorkerCandidates(candidates: TicketCandidate[]): TicketCandidate[] {
  if (candidates.length === 0) return [];
  const low = candidates.filter((candidate) => boardTicketComplexity(candidate.ticket) === "low");
  const pool = low.length > 0 ? low : candidates;
  return [...pool].sort((a, b) => {
    const priorityDelta = priorityRank(b.ticket.priority) - priorityRank(a.ticket.priority);
    if (priorityDelta !== 0) return priorityDelta;
    return createdAtMs(a.ticket) - createdAtMs(b.ticket);
  });
}

export function selectBoardWorkerCandidate(candidates: TicketCandidate[]): TicketCandidate | undefined {
  return rankBoardWorkerCandidates(candidates)[0];
}

/** True when a board ticket's linked resource directory is the one
 *  autonomous-mode project (exact-match — see isCwdInAutonomousProject). */
function ticketMatchesAutonomousProject(ticket: BoardTicket, project: AutonomousProject): boolean {
  return isCwdInAutonomousProject(ticket.resourcePath, project);
}

async function buildCandidates(
  now: number,
  deps: BoardWorkerDeps,
): Promise<TicketCandidate[]> {
  const registry = scanOrg();
  const config = deps.context.getConfig();
  const boardWorkerConfig = normalizeBoardWorkerConfig(config.boardWorker);
  // ⚠️ INTENTIONAL, not a bug: while the one autonomous project has
  // continuousDispatch on, board-worker's own auto-pickup narrows to that
  // project's tickets only — see gateway/autonomous-mode.ts's module
  // docblock. Byte-for-byte unchanged (no filtering at all) when off.
  const autonomousProject = resolveAutonomousProject(config);
  const scopeToAutonomousProject = autonomousProject?.continuousDispatch === true;
  const departments = new Set([...registry.values()].map((employee) => employee.department));
  const candidates: TicketCandidate[] = [];

  for (const department of departments) {
    const manager = findDepartmentManager(department, registry);
    if (!manager) {
      logger.info(`[board-worker] ${department}: no-manager`);
      continue;
    }

    let tickets: BoardTicket[] | null;
    try {
      tickets = readBoardArray(deps.orgDir, department);
    } catch (err) {
      logger.warn(`[board-worker] ${department}/board.json malformed: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (!tickets) continue;

    const status = await getEngineUsageStatus(manager.engine, deps.context.getConfig(), { now });
    const usageMode = usageModeForStatus(status, boardWorkerConfig.usage.minRemainingPercent);
    if (usageMode === "skip") {
      // Audit H6: a usage-exhausted skip previously wrote nothing, so TODO tickets
      // simply sat and the pause looked like a bug/stall. Emit a throttled, structured
      // signal so an operator can tell quota (not a defect) is why work isn't moving.
      logBoardWorkerUsageSkip(department, manager.engine, now);
      continue;
    }

    const todoTickets = tickets.filter((ticket) => ticket.status === "todo" && ticket.manualOnly !== true);
    let filtered = usageMode === "low-only"
      ? todoTickets.filter((ticket) => boardTicketComplexity(ticket) === "low")
      : todoTickets;
    if (scopeToAutonomousProject && autonomousProject) {
      filtered = filtered.filter((ticket) => ticketMatchesAutonomousProject(ticket, autonomousProject));
    }
    for (const ticket of filtered) {
      candidates.push({
        department,
        ticket,
        manager: { name: manager.name, engine: manager.engine },
      });
    }
  }

  return candidates;
}

export function startBoardWorker(deps: BoardWorkerDeps): () => void {
  let isDispatching = false;

  const tick = async () => {
    if (isDispatching) return;
    isDispatching = true;
    try {
      const now = deps.now?.() ?? Date.now();
      const config = normalizeBoardWorkerConfig(deps.context.getConfig().boardWorker);
      if (!config.enabled) return;
      if (!isWithinBoardWorkerWindow(now, config.timezone, config.schedule)) return;

      const idle = isChatIdle(
        listSessions().map((session) => ({ source: session.source, lastActivity: session.lastActivity })),
        config.idleMinutes,
        now,
      );
      if (!idle) return;

      const candidates = rankBoardWorkerCandidates(await buildCandidates(now, deps));
      for (const selected of candidates) {
        const result = await dispatchTicket(
          selected.department,
          selected.ticket.id,
          { source: "board-worker", routeToManager: true },
          { context: deps.context, orgDir: deps.orgDir, now: () => now },
        );
        if (result.ok) {
          logger.info(
            `[board-worker] auto-dispatched ${selected.department}/${selected.ticket.id} ` +
            `-> ${selected.manager.name} at ${new Date(now).toISOString()}`,
          );
          return;
        }
        logger.info(
          `[board-worker] skipped ${selected.department}/${selected.ticket.id}: ${result.reason}`,
        );
      }
    } catch (err) {
      logger.warn(`[board-worker] tick failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      isDispatching = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, deps.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------
// Continuous dispatch (autonomous mode)
//
// ⚠️ INTENTIONAL feature, not a bug/leak: this is what makes Cuttlefish keep
// working on the one autonomous project "non-stop" instead of going idle
// between board-worker's 5-minute ticks. See gateway/autonomous-mode.ts's
// module docblock for the full rationale. Bounded by THREE independent
// safety valves below (rolling-hour cap, the existing usage-quota gate
// reused via buildCandidates, and a same-ticket cooldown) — do not remove
// any of them "to simplify," each guards against a distinct runaway pattern.
// ---------------------------------------------------------------------------

const AUTO_DISPATCH_WINDOW_MS = 60 * 60 * 1000;
const SAME_TICKET_COOLDOWN_MS = 2 * 60 * 1000;
/** Rolling-hour dispatch timestamps. Reset on process restart — same
 *  accepted soft-limit tradeoff as lastUsageSkipLogAt above. */
const autoDispatchTimestamps: number[] = [];
const lastAutoDispatchAtByTicket = new Map<string, number>();

function pruneAutoDispatchTimestamps(now: number): void {
  while (autoDispatchTimestamps.length > 0 && now - autoDispatchTimestamps[0]! > AUTO_DISPATCH_WINDOW_MS) {
    autoDispatchTimestamps.shift();
  }
}

/**
 * Called from server.ts's `session:completed` handler, alongside the existing
 * syncBoardForEvent call. If the completed session belonged to a board ticket
 * in the one continuousDispatch-enabled project, immediately dispatches the
 * next eligible todo ticket for that department instead of waiting for the
 * next board-worker tick. No-ops instantly (cheap) whenever autonomous mode
 * or continuousDispatch is off — safe to call unconditionally on every
 * session completion.
 */
export async function maybeAutoDispatchNext(
  payload: { sessionId?: string },
  deps: BoardWorkerDeps,
): Promise<void> {
  try {
    const config = deps.context.getConfig();
    const project = resolveAutonomousProject(config);
    if (!project?.continuousDispatch) return;

    const sessionId = payload.sessionId;
    if (!sessionId) return;
    const session = getSession(sessionId);
    if (!session) return;
    if (!isCwdInAutonomousProject(session.cwd, project)) return;

    const meta = (session.transportMeta ?? {}) as Record<string, unknown>;
    const department = typeof meta.boardDepartment === "string" ? meta.boardDepartment : undefined;
    const ticketId = typeof meta.boardTicketId === "string" ? meta.boardTicketId : undefined;
    if (!department || !ticketId) return; // not a board-ticket-dispatched session

    const now = deps.now?.() ?? Date.now();

    // Safety valve 1/3: rolling-hour cap.
    pruneAutoDispatchTimestamps(now);
    if (autoDispatchTimestamps.length >= project.maxAutoDispatchesPerHour) {
      logger.info(
        `[autonomous][continuous] throttled: hourly cap (${project.maxAutoDispatchesPerHour}) reached — falling back to the ordinary board-worker tick`,
      );
      return;
    }

    // Safety valve 2/3: same-ticket cooldown, guards against an
    // instant-complete/instant-redispatch loop on one broken ticket.
    const ticketKey = `${department}/${ticketId}`;
    const lastForTicket = lastAutoDispatchAtByTicket.get(ticketKey) ?? 0;
    if (now - lastForTicket < SAME_TICKET_COOLDOWN_MS) {
      logger.info(`[autonomous][continuous] throttled: same-ticket cooldown active for ${ticketKey}`);
      return;
    }

    // Safety valve 3/3: buildCandidates() already applies the existing
    // per-department usage-quota gate (usageModeForStatus) — reused for free.
    const candidates = (await buildCandidates(now, deps)).filter((c) => c.department === department);
    const next = selectBoardWorkerCandidate(candidates);
    if (!next) return;

    const result = await dispatchTicket(
      next.department,
      next.ticket.id,
      { source: "autonomous-continuous", routeToManager: true },
      { context: deps.context, orgDir: deps.orgDir, now: () => now },
    );
    if (result.ok) {
      autoDispatchTimestamps.push(now);
      lastAutoDispatchAtByTicket.set(`${next.department}/${next.ticket.id}`, now);
      logger.info(
        `[autonomous][continuous] auto-dispatched ${next.department}/${next.ticket.id} immediately on prior completion`,
      );
    } else {
      logger.info(`[autonomous][continuous] skipped ${next.department}/${next.ticket.id}: ${result.reason}`);
    }
  } catch (err) {
    logger.warn(`[autonomous][continuous] failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
