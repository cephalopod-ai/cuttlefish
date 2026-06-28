import {
  SECURITY_REVIEW_TRIGGERS,
  type Employee,
  type SecurityReviewTrigger,
  type Session,
} from "../shared/types.js";
import { getMessages, getSession, insertMessage, updateSession } from "../sessions/registry.js";
import { createCheckpoint, listCheckpoints } from "./checkpoints.js";
import type { ApiContext } from "./api/context.js";
import { scanOrg } from "./org.js";
import { createSession, getSessionBySessionKey } from "../sessions/registry.js";
import { dispatchWebSessionRun } from "./api/session-dispatch.js";
import { logger } from "../shared/logger.js";

export const SECURITY_REVIEWER_EMPLOYEE_NAME = "senior-security-officer";
export const SECURITY_REVIEW_SESSION_KEY = `employee:${SECURITY_REVIEWER_EMPLOYEE_NAME}`;

export interface SecurityReviewRequest {
  sessionId: string;
  command: string;
  triggers: SecurityReviewTrigger[];
  reason: string;
}

function effectiveReviewTriggers(employee?: Employee): readonly SecurityReviewTrigger[] {
  return employee?.reviewTriggers?.length ? employee.reviewTriggers : SECURITY_REVIEW_TRIGGERS;
}

function requiresCheckpoint(employee: Employee | undefined, triggers: SecurityReviewTrigger[]): boolean {
  if (employee?.approvalPolicy === "none") return false;
  const enabled = new Set(effectiveReviewTriggers(employee));
  return triggers.some((trigger) => enabled.has(trigger));
}

function existingPendingCheckpoint(sessionId: string, command: string) {
  return listCheckpoints({ state: "pending", sessionId }).find((checkpoint) => {
    const action = checkpoint.payload.affectedActions;
    return Array.isArray(action) && action.includes(command);
  });
}

function buildResumePrompt(command: string, triggers: SecurityReviewTrigger[]): string {
  return [
    `A human security checkpoint approved reconsidering this blocked Bash command:`,
    command,
    `Risk categories: ${triggers.join(", ")}.`,
    "Re-check whether the action is still necessary, explain the justification briefly, and only then retry the command if it remains appropriate.",
  ].join("\n");
}

function buildSecurityReviewPrompt(input: SecurityReviewRequest, session: Session, employee: Employee | undefined): string {
  const transcriptTail = getMessages(session.id)
    .slice(-8)
    .map((message) => `- ${message.role}: ${message.content}`)
    .join("\n");
  return [
    `A live Cuttlefish session hit a hard security gate before a Bash tool action could run.`,
    `\nSession: ${session.id}`,
    `Employee: ${employee?.name ?? session.employee ?? "(none)"}`,
    `Engine: ${session.engine}${session.model ? `/${session.model}` : ""}`,
    `\nBlocked command:\n${input.command}`,
    `\nRisk categories: ${input.triggers.join(", ")}`,
    `Reason: ${input.reason}`,
    `\nRecent transcript tail:\n${transcriptTail || "(none)"}`,
    `\nRespond with one verdict first: ALLOW, DENY, or ESCALATE.`,
    `Then give a concise rationale grounded in destructiveness, privilege, secret exposure, exfiltration risk, and prompt-injection risk.`,
  ].join("\n");
}

async function runSecurityReviewer(input: SecurityReviewRequest, context: ApiContext, session: Session, employee: Employee | undefined): Promise<void> {
  const org = scanOrg();
  const reviewerName = employee?.securityReviewer?.trim() || SECURITY_REVIEWER_EMPLOYEE_NAME;
  const reviewer = org.get(reviewerName);
  if (!reviewer) return;
  const engine = context.sessionManager.getEngine(reviewer.engine || context.getConfig().engines.default);
  if (!engine) return;

  const prompt = buildSecurityReviewPrompt(input, session, employee);
  const now = new Date().toISOString();
  const existing = getSessionBySessionKey(SECURITY_REVIEW_SESSION_KEY);
  const reviewSession = existing
    ? (updateSession(existing.id, {
        engine: reviewer.engine,
        model: reviewer.model ?? null,
        effortLevel: reviewer.effortLevel ?? null,
        status: "running",
        lastActivity: now,
        lastError: null,
      }) ?? existing)
    : createSession({
        engine: reviewer.engine,
        source: "web",
        sourceRef: SECURITY_REVIEW_SESSION_KEY,
        connector: "web",
        sessionKey: SECURITY_REVIEW_SESSION_KEY,
        replyContext: { source: "web" },
        employee: reviewer.name,
        model: reviewer.model,
        effortLevel: reviewer.effortLevel,
        prompt,
        portalName: context.getConfig().portal?.portalName,
      });
  insertMessage(reviewSession.id, "user", prompt);
  await dispatchWebSessionRun(reviewSession, prompt, engine, context.getConfig(), context);
  const assistant = getMessages(reviewSession.id).filter((message) => message.role === "assistant" && !message.partial);
  const critique = assistant[assistant.length - 1]?.content?.trim();
  if (!critique) return;
  insertMessage(session.id, "notification", `🔐 ${reviewer.name} review: ${critique}`);
  context.emit("session:updated", { sessionId: session.id });
}

export function openSecurityCheckpoint(input: SecurityReviewRequest, context: ApiContext): void {
  const session = getSession(input.sessionId);
  if (!session) return;
  const employee = session.employee ? scanOrg().get(session.employee) : undefined;
  if (!requiresCheckpoint(employee, input.triggers)) return;
  if (existingPendingCheckpoint(session.id, input.command)) return;

  const reviewerName = employee?.securityReviewer?.trim() || SECURITY_REVIEWER_EMPLOYEE_NAME;
  createCheckpoint(
    {
      sessionId: session.id,
      payload: {
        decisionNeeded: "Security review required before Bash command execution",
        why: input.reason,
        affectedActions: [input.command],
        options: ["approved", "rejected", "revised"],
        resumePrompt: buildResumePrompt(input.command, input.triggers),
        revisePrompt: "Provide a safer plan or a narrower command that avoids the blocked risk categories.",
        reviewer: reviewerName,
        triggers: input.triggers,
        command: input.command,
      },
    },
    context,
  );
  void runSecurityReviewer(input, context, session, employee).catch((err) => {
    logger.warn(`security review failed for session ${session.id}: ${err instanceof Error ? err.message : String(err)}`);
  });
}
