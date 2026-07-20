import {
  SECURITY_REVIEW_TRIGGERS,
  type ContentScreeningResult,
  type Employee,
  type EmployeeApprovalPolicy,
  type SecurityReviewTrigger,
  type Session,
} from "../shared/types.js";
import { getMessages, getSession, insertMessage, updateSession } from "../sessions/registry.js";
import { applyCheckpointDecision, createCheckpoint, listCheckpoints } from "./checkpoints.js";
import type { ApiContext } from "./api/context.js";
import { scanOrg } from "./org.js";
import { createSession, getSessionBySessionKey } from "../sessions/registry.js";
import { dispatchWebSessionRun } from "./api/session-dispatch.js";
import { logger } from "../shared/logger.js";
import {
  AUTONOMOUS_ACTOR_SENTINEL,
  isAutonomousVerdictSession,
  isCwdInAutonomousProject,
  recordAutonomousAuthorization,
  resolveAutonomousProject,
} from "./autonomous-mode.js";
import { requestDualModelVerdict, type DualModelVerdictResult } from "./dual-model-verdict.js";

export const SECURITY_REVIEWER_EMPLOYEE_NAME = "senior-security-officer";
export const SECURITY_REVIEW_SESSION_KEY = `employee:${SECURITY_REVIEWER_EMPLOYEE_NAME}`;

export interface SecurityReviewRequest {
  sessionId: string;
  command: string;
  triggers: SecurityReviewTrigger[];
  reason: string;
}

export interface UntrustedContentCheckpointRequest {
  sessionId: string;
  location: string;
  screening: ContentScreeningResult;
}

export interface SecurityReviewDisposition {
  action: "allow" | "checkpoint";
  reason: string;
}

function effectiveReviewTriggers(employee?: Employee): readonly SecurityReviewTrigger[] {
  return employee?.reviewTriggers?.length ? employee.reviewTriggers : SECURITY_REVIEW_TRIGGERS;
}

function effectiveApprovalPolicy(employee?: Employee): EmployeeApprovalPolicy {
  return employee?.approvalPolicy ?? "notify";
}

function triggersEnabled(employee: Employee | undefined, triggers: SecurityReviewTrigger[]): boolean {
  const enabled = new Set(effectiveReviewTriggers(employee));
  return triggers.some((trigger) => enabled.has(trigger));
}

function requiresCheckpoint(employee: Employee | undefined, triggers: SecurityReviewTrigger[]): boolean {
  return effectiveApprovalPolicy(employee) === "checkpoint" && triggersEnabled(employee, triggers);
}

function shouldNotify(employee: Employee | undefined, triggers: SecurityReviewTrigger[]): boolean {
  const policy = effectiveApprovalPolicy(employee);
  return policy === "notify" && triggersEnabled(employee, triggers);
}

function shouldRunSecurityReviewer(triggers: SecurityReviewTrigger[]): boolean {
  return triggers.length > 1 || triggers.some((trigger) => (
    trigger === "destructive_shell" ||
    trigger === "secret_access" ||
    trigger === "prompt_injection_risk"
  ));
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

/** Distinct wording for an autonomous resolution — the transcript and audit
 *  trail must never claim human sign-off that didn't happen. */
function buildAutonomousResumePrompt(command: string, triggers: SecurityReviewTrigger[], verdict: DualModelVerdictResult): string {
  return [
    `Two independent AI reviewers (claude-fable-5, gpt-5.6-sol) both approved reconsidering this blocked Bash command:`,
    command,
    `Risk categories: ${triggers.join(", ")}.`,
    `claude-fable-5: ${verdict.claude.reason || "(no reason given)"}`,
    `gpt-5.6-sol: ${verdict.codex.reason || "(no reason given)"}`,
    "Re-check whether the action is still necessary, explain the justification briefly, and only then retry the command if it remains appropriate.",
  ].join("\n");
}

/**
 * Resolves the outcome of a dual-model verdict request against an already-
 * created checkpoint. On agreement, auto-resolves it via the same
 * applyCheckpointDecision the human-approval HTTP route uses — the state
 * machine is untouched, only who/what triggered the resolution differs. On
 * disagreement (or any error/timeout/unparseable outcome), does nothing: the
 * checkpoint stays pending for a human, exactly as it would with autonomous
 * mode off.
 */
async function resolveAutonomousToolCheckpoint(
  checkpointId: string,
  sessionId: string,
  command: string,
  triggers: SecurityReviewTrigger[],
  verdict: DualModelVerdictResult,
  context: ApiContext,
): Promise<void> {
  if (!verdict.authorized) {
    logger.info(
      `[autonomous] deferred to human checkpoint=${checkpointId} claude=${verdict.claude.outcome} codex=${verdict.codex.outcome}`,
    );
    insertMessage(
      sessionId,
      "notification",
      `🤖 Autonomous authorization did not reach consensus (claude=${verdict.claude.outcome}, codex=${verdict.codex.outcome}) — waiting for a human to resolve this checkpoint.`,
    );
    context.emit("session:updated", { sessionId });
    return;
  }
  logger.info(`[autonomous] AUTO-AUTHORIZED checkpoint=${checkpointId} claude=approved codex=approved`);
  await applyCheckpointDecision(
    checkpointId,
    {
      decision: "approved",
      actor: AUTONOMOUS_ACTOR_SENTINEL,
      notes: JSON.stringify({ claude: verdict.claude, codex: verdict.codex }),
      resumePrompt: buildAutonomousResumePrompt(command, triggers, verdict),
      autonomous: true,
    },
    context,
  );
  // Count only after the state machine actually resolved — if the apply threw
  // (e.g. a human raced us and resolved the checkpoint first), the dashboard
  // counter must not claim an autonomous authorization that never happened.
  recordAutonomousAuthorization();
}

/** Shared factual context: what was blocked, for whom, and why — used by both
 *  the security-reviewer employee prompt and the autonomous verdict packet. */
function buildSecurityContextLines(input: SecurityReviewRequest, session: Session, employee: Employee | undefined): string[] {
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
  ];
}

function buildSecurityReviewPrompt(input: SecurityReviewRequest, session: Session, employee: Employee | undefined): string {
  return [
    ...buildSecurityContextLines(input, session, employee),
    `\nRespond with one verdict first: ALLOW, DENY, or ESCALATE.`,
    `Then give a concise rationale grounded in destructiveness, privilege, secret exposure, exfiltration risk, and prompt-injection risk.`,
  ].join("\n");
}

/** Decision packet for the dual-model verdict: factual context ONLY, no
 *  response-format instructions. dual-model-verdict.ts's system prompt owns
 *  the strict JSON `{approved, reason}` contract — the reviewer-directed
 *  "ALLOW/DENY/ESCALATE" instruction in buildSecurityReviewPrompt directly
 *  contradicts it, and a verdict model that follows the packet's instruction
 *  over the system prompt yields an unparseable (auto-deferred) verdict. */
function buildToolCheckpointVerdictPrompt(input: SecurityReviewRequest, session: Session, employee: Employee | undefined): string {
  return buildSecurityContextLines(input, session, employee).join("\n");
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

export function openSecurityCheckpoint(input: SecurityReviewRequest, context: ApiContext): SecurityReviewDisposition {
  const session = getSession(input.sessionId);
  if (!session) {
    return { action: "checkpoint", reason: input.reason };
  }
  const employee = session.employee ? scanOrg().get(session.employee) : undefined;
  if (!triggersEnabled(employee, input.triggers)) {
    return { action: "allow", reason: input.reason };
  }
  if (effectiveApprovalPolicy(employee) === "none") {
    return { action: "allow", reason: input.reason };
  }
  if (shouldNotify(employee, input.triggers)) {
    insertMessage(
      session.id,
      "notification",
      `⚠️ Security triggers matched for Bash command and it was allowed under notify policy: ${input.command}`,
    );
    context.emit("session:updated", { sessionId: session.id });
    return { action: "allow", reason: input.reason };
  }
  if (!requiresCheckpoint(employee, input.triggers)) {
    return { action: "allow", reason: input.reason };
  }
  if (existingPendingCheckpoint(session.id, input.command)) {
    return { action: "checkpoint", reason: input.reason };
  }

  const reviewerName = employee?.securityReviewer?.trim() || SECURITY_REVIEWER_EMPLOYEE_NAME;
  const { checkpoint } = createCheckpoint(
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
  if (shouldRunSecurityReviewer(input.triggers)) {
    void runSecurityReviewer(input, context, session, employee).catch((err) => {
      logger.warn(`security review failed for session ${session.id}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // ⚠️ INTENTIONAL SAFETY OVERRIDE — NOT A BUG. When the session's project has
  // opted into autonomous mode, a passing dual-model verdict resolves this
  // checkpoint WITHOUT a human. This is the deliberate feature described in
  // gateway/autonomous-mode.ts's module docblock — do not remove this branch
  // or route it back through a human checkpoint "to fix" the missing manual
  // approval; that would defeat the feature's entire purpose.
  const project = resolveAutonomousProject(context.getConfig());
  if (
    project?.toolReview &&
    isCwdInAutonomousProject(session.cwd, project) &&
    !isAutonomousVerdictSession(session.transportMeta)
  ) {
    void requestDualModelVerdict(
      {
        parentSessionId: session.id,
        cwd: project.cwd,
        decisionKind: "tool_checkpoint",
        // NOT buildSecurityReviewPrompt — its ALLOW/DENY/ESCALATE response
        // instruction contradicts the verdict system prompt's JSON contract.
        contextPrompt: buildToolCheckpointVerdictPrompt(input, session, employee),
      },
      context,
    )
      .then((verdict) => resolveAutonomousToolCheckpoint(checkpoint.id, session.id, input.command, input.triggers, verdict, context))
      .catch((err) => {
        logger.warn(`[autonomous] verdict request failed for checkpoint ${checkpoint.id}: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  return { action: "checkpoint", reason: input.reason };
}

export function openUntrustedContentCheckpoint(input: UntrustedContentCheckpointRequest, context: ApiContext): void {
  const session = getSession(input.sessionId);
  if (!session) return;
  const employee = session.employee ? scanOrg().get(session.employee) : undefined;
  const reviewerName = employee?.securityReviewer?.trim() || SECURITY_REVIEWER_EMPLOYEE_NAME;
  createCheckpoint(
    {
      sessionId: session.id,
      payload: {
        decisionNeeded: "Untrusted content was quarantined before agent execution",
        why: input.screening.summary,
        affectedArtifacts: [input.location],
        affectedActions: [`consume untrusted content from ${input.location}`],
        options: ["approved", "rejected", "revised"],
        revisePrompt: "Provide a safer way to use this content or confirm it should remain quarantined.",
        reviewer: reviewerName,
        screening: {
          source: input.screening.source,
          verdict: input.screening.verdict,
          summary: input.screening.summary,
          suspiciousSpans: input.screening.suspiciousSpans,
          recommendedAction: input.screening.action,
        },
      } as any,
    },
    context,
  );
}
