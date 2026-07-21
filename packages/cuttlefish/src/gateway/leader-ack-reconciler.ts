import { getMessages, getSession, insertMessage, listSessions } from "../sessions/registry.js";
import { resolveOrgHierarchy, withPortalExecutive } from "./org-hierarchy.js";
import { scanOrg } from "./org.js";
import { logger } from "../shared/logger.js";
import { DEFAULT_MODEL_LADDER } from "../shared/model-escalation.js";
import { getModelRegistry, isKnownEngine } from "../shared/models.js";
import type { CuttlefishConfig, Employee, ModelRegistry, Session } from "../shared/types.js";
import { acknowledgeLeaderAck, isLeaderAckNoOpResult, markLeaderAckEscalated, markLeaderAckReminderSent, readLeaderAckMeta, type LeaderAckMeta } from "../sessions/leader-ack.js";

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_ESCALATIONS = 1;
const MIN_SUPERVISOR_CONTACT_ATTEMPTS = 2;

export interface LeaderAckEscalationDispatch {
  childSession: Session;
  recipient: Employee;
  ackLeaderName: string | null;
  timeoutMs: number;
}

export interface LeaderAckTriageModel {
  engine: string;
  model: string;
  effortLevel?: string;
}

export interface LeaderAckReconcilerDeps {
  emit: (event: string, payload: unknown) => void;
  getConfig: () => CuttlefishConfig;
  intervalMs?: number;
  now?: () => number;
  dispatchEscalation?: (input: LeaderAckEscalationDispatch) => Promise<void>;
  dispatchParentReminder?: (parentSessionId: string, message: string, displayMessage: string) => Promise<void>;
}

function buildParentReminderMessage(child: Session): { message: string; displayMessage: string } {
  const worker = child.employee || "A delegated worker";
  return {
    message: [
      `Second notice: ${worker}'s delegated-work report is still awaiting your acknowledgement.`,
      `Review GET /api/sessions/${child.id}?last=20, then reply with the next action before the handoff escalates.`,
    ].join("\n"),
    displayMessage: `⏱️ Second notice: ${worker}'s report needs acknowledgement.`,
  };
}

export function resolveLeaderAckTimeoutMs(config: CuttlefishConfig): number {
  const raw = config.gateway?.leaderAckTimeoutMs;
  return typeof raw === "number" && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

export function resolveLeaderAckMaxEscalations(config: CuttlefishConfig): number {
  const raw = config.gateway?.leaderAckMaxEscalations;
  return typeof raw === "number" && raw >= 0 ? raw : DEFAULT_MAX_ESCALATIONS;
}

/**
 * Routine acknowledgement triage should not start on the virtual COO's
 * high-capability default. Reuse the existing model ladder's cheap tier and
 * select the first model that is both configured and available. Returning
 * null preserves the working executive fallback on installations that do not
 * expose any cheap-tier model.
 */
export function resolveLeaderAckTriageModel(
  config: CuttlefishConfig,
  registry: ModelRegistry = getModelRegistry(config),
): LeaderAckTriageModel | null {
  for (const rung of DEFAULT_MODEL_LADDER[0] ?? []) {
    if (!isKnownEngine(rung.engine)) continue;
    const entry = registry[rung.engine];
    if (!entry?.available) continue;
    const model = entry.models.find((candidate) => candidate.id.toLowerCase() === rung.model.toLowerCase());
    if (!model) continue;
    const effortLevel = model.supportsEffort && model.effortLevels.includes("low") ? "low" : undefined;
    return { engine: rung.engine, model: model.id, ...(effortLevel ? { effortLevel } : {}) };
  }
  return null;
}

function formatDurationMinutes(ms: number): number {
  return Math.max(1, Math.round(ms / 60_000));
}

function escalationRecipientFor(child: Session, config: CuttlefishConfig): Employee | null {
  const registry = withPortalExecutive(scanOrg(), config.portal?.portalName);
  const hierarchy = resolveOrgHierarchy(registry);
  const currentLeader = child.parentSessionId ? getSession(child.parentSessionId)?.employee ?? null : null;
  if (!hierarchy.root) return null;
  const executive = registry.get(hierarchy.root) ?? null;
  if (!executive) return null;
  return executive.name === currentLeader ? null : executive;
}

function escalationTargetLabel(recipient: Employee | null): string {
  return recipient?.displayName || recipient?.name || "manual human review";
}

function buildChildEscalationMessage(child: Session, timeoutMs: number, recipient: Employee | null, ackLeaderName: string | null): string {
  const minutes = formatDurationMinutes(timeoutMs);
  const leader = ackLeaderName || "the assigned leader";
  return `🧭 Leader acknowledgement timeout: ${leader} did not acknowledge this report within ${minutes} minute${minutes === 1 ? "" : "s"}. Escalated to ${escalationTargetLabel(recipient)} for reassignment or backlog guidance.`;
}

/**
 * Whether the leader has already dealt with this report without hitting the
 * explicit ack API. Two ways that happens in practice:
 *  - The leader posts ANY assistant reply after the report landed. The report
 *    is delivered by waking the leader's own turn, so a subsequent assistant
 *    message means the leader was active and responded to that wake — this is
 *    the common "relayed the result in free text" case, not just a no-op.
 *  - A human/HR closes it out with a boilerplate no-op user message (e.g.
 *    "acknowledged", "task remains done").
 */
function hasParentNoOpAcknowledgement(ack: LeaderAckMeta): boolean {
  const parent = getSession(ack.parentSessionId);
  if (!parent) return false;
  const reportedAt = Date.parse(ack.reportedAt);
  if (!Number.isFinite(reportedAt)) return false;
  return getMessages(parent.id).some((message) => {
    if (message.timestamp < reportedAt) return false;
    if (message.role === "assistant") return true;
    if (message.role === "user") return isLeaderAckNoOpResult(message.content);
    return false;
  });
}

export function buildLeaderAckEscalationPrompt(input: LeaderAckEscalationDispatch): string {
  const minutes = formatDurationMinutes(input.timeoutMs);
  const ackLeader = input.ackLeaderName || "the assigned leader";
  const ack = readLeaderAckMeta(input.childSession);
  const ticketText = ack?.boardTicketId ? `Related board ticket: ${ack.boardTicketId}.` : "No linked board ticket was recorded.";
  return [
    `A delegated worker reported back, but ${ackLeader} did not acknowledge the report within ${minutes} minutes.`,
    `Please triage this stalled management handoff for session ${input.childSession.id}.`,
    `Worker: ${input.childSession.employee || "unknown"}.`,
    `Session title: ${input.childSession.title || "(untitled)"}.`,
    ticketText,
    `Choose one of these actions and carry it through:`,
    `1. Reassign the remaining work to a different leader or specialist.`,
    `2. Put the remaining work back into backlog and explain what is blocked.`,
    `3. If the current leader should continue, send a clear acknowledgement/follow-up to the worker chat.`,
    `Reply with the concrete next action, then perform it if you have the authority.`,
  ].join("\n");
}

export function sweepLeaderAcknowledgements(deps: LeaderAckReconcilerDeps): number {
  const now = deps.now?.() ?? Date.now();
  const timeoutMs = resolveLeaderAckTimeoutMs(deps.getConfig());
  const maxEscalations = resolveLeaderAckMaxEscalations(deps.getConfig());
  let escalated = 0;

  for (const session of listSessions()) {
    const ack = readLeaderAckMeta(session);
    if (!ack || ack.state !== "pending") continue;
    if (hasParentNoOpAcknowledgement(ack)) {
      acknowledgeLeaderAck(session.id, session, {
        acknowledgedBy: ack.leaderName || ack.leaderSessionId,
        now: new Date(now).toISOString(),
      });
      deps.emit("session:updated", { sessionId: session.id });
      logger.info(`[leader-ack] session ${session.id} acknowledged by parent no-op/closure response`);
      continue;
    }
    const lastContactAt = Date.parse(ack.lastContactAttemptAt ?? ack.reportedAt);
    if (!Number.isFinite(lastContactAt) || now - lastContactAt < timeoutMs) continue;

    // The completion/error callback is the first direct-supervisor contact.
    // Give that same supervisor one explicit reminder and a fresh timeout
    // window before routing the handoff to an executive or manual review.
    if ((ack.contactAttemptCount ?? 1) < MIN_SUPERVISOR_CONTACT_ATTEMPTS) {
      const attemptedAt = new Date(now).toISOString();
      if (!markLeaderAckReminderSent(session.id, session, { now: attemptedAt })) continue;
      const reminder = buildParentReminderMessage(session);
      const parent = getSession(ack.parentSessionId);
      if (parent) {
        if (deps.dispatchParentReminder) {
          void deps.dispatchParentReminder(parent.id, reminder.message, reminder.displayMessage).catch((err) => {
            logger.warn(`[leader-ack] failed second supervisor contact for ${session.id}: ${err instanceof Error ? err.message : String(err)}`);
          });
        } else {
          insertMessage(parent.id, "notification", reminder.displayMessage);
          deps.emit("session:updated", { sessionId: parent.id });
        }
      }
      insertMessage(session.id, "notification", `⏱️ Supervisor acknowledgement is overdue; a second notice was sent to ${ack.leaderName || "the assigned leader"}.`);
      deps.emit("session:updated", { sessionId: session.id });
      logger.warn(`[leader-ack] session ${session.id} sent second supervisor contact before escalation`);
      continue;
    }

    // Every completed child turn re-arms a fresh pending cycle (markLeaderAckPending),
    // including turns that are just administrative follow-up (e.g. HR sending a closing
    // note into the worker session). Without a cap, each of those re-arms times out
    // 10 minutes later and repeats the escalation forever on the same handoff.
    // Once this session lineage has already escalated maxEscalations times, stop paging
    // and settle quietly instead — a human already saw this once.
    if ((ack.escalationCount ?? 0) >= maxEscalations) {
      acknowledgeLeaderAck(session.id, session, {
        acknowledgedBy: `leader-ack-cap (suppressed repeat escalation #${(ack.escalationCount ?? 0) + 1})`,
        now: new Date(now).toISOString(),
      });
      deps.emit("session:updated", { sessionId: session.id });
      logger.warn(`[leader-ack] session ${session.id} hit repeat timeout after ${ack.escalationCount ?? 0} prior escalation(s); suppressing duplicate escalation`);
      continue;
    }

    const recipient = escalationRecipientFor(session, deps.getConfig());
    const recipientName = recipient?.name ?? "manual-review";
    if (!markLeaderAckEscalated(session.id, session, {
      escalatedTo: recipientName,
      now: new Date(now).toISOString(),
    })) {
      continue;
    }

    const childMessage = buildChildEscalationMessage(session, timeoutMs, recipient, ack.leaderName);
    insertMessage(session.id, "notification", childMessage);
    deps.emit("session:updated", { sessionId: session.id });

    const parent = getSession(ack.parentSessionId);
    if (parent) {
      insertMessage(
        parent.id,
        "notification",
        `⏱️ A report from ${session.employee || "a report"} went unacknowledged and was escalated to ${escalationTargetLabel(recipient)}.`,
      );
      deps.emit("session:updated", { sessionId: parent.id });
    }

    if (recipient && deps.dispatchEscalation) {
      void deps.dispatchEscalation({
        childSession: getSession(session.id) ?? session,
        recipient,
        ackLeaderName: ack.leaderName,
        timeoutMs,
      }).catch((err) => {
        logger.warn(`[leader-ack] failed to dispatch escalation for ${session.id}: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    logger.warn(
      `[leader-ack] session ${session.id} escalated after ${formatDurationMinutes(timeoutMs)}m without leader acknowledgement` +
      (recipient ? ` -> ${recipient.name}` : " -> manual review"),
    );
    escalated++;
  }

  return escalated;
}

export function startLeaderAckReconciler(deps: LeaderAckReconcilerDeps): () => void {
  const timer = setInterval(() => {
    try {
      sweepLeaderAcknowledgements(deps);
    } catch (err) {
      logger.warn(`[leader-ack] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, deps.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
