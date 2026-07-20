/**
 * ⚠️ INTENTIONAL SAFETY OVERRIDE — NOT A BUG. See the docblock at the top of
 * autonomous-mode.ts before changing anything in this file. This module is
 * the mechanism by which approvals/checkpoints get resolved WITHOUT a human,
 * by deliberate operator opt-in — that is the feature, not an accident to
 * patch out.
 *
 * Dual-model autonomous verdict primitive.
 *
 * Spawns two independent, judge-only, non-employee-bound child sessions —
 * always Claude `claude-fable-5` and always Codex `gpt-5.6-sol`, with no
 * fallback-chain lookup of any kind — and requires BOTH to independently
 * return `{approved: true}` before treating a pending approval/checkpoint as
 * autonomously authorized. This is the one thing deliberately NOT reused from
 * mid-pair-orchestrator.ts's reviewer pattern: that module's "independent"
 * reviewer defaults to the implementer's own engine/model absent explicit
 * operator config (`primaryEngine = reviewerRole?.override?.engine ??
 * employee.engine`) — a confirmed "echo-consensus" finding (audit A-F7).
 * Genuine independence here means the two rungs are hardcoded literals, never
 * derived from the session/employee under review.
 *
 * Fail-closed by construction: any outcome other than both rungs returning
 * `approved` (an error, a timeout, unparseable output, or a real
 * disagreement) yields `authorized: false`. Callers treat that identically to
 * "no autonomous verdict was ever requested" — the existing approval/
 * checkpoint stays pending for a human, exactly as it would with autonomous
 * mode off. There is no auto-reject path.
 */
import { randomUUID } from "node:crypto";
import { createSession, getMessages, getSession, insertMessage } from "../sessions/registry.js";
import { logger } from "../shared/logger.js";
import type { CuttlefishConfig, JsonObject, Session } from "../shared/types.js";
import { dispatchWebSessionRun, killSessionEngines } from "./api/session-dispatch.js";
import type { ApiContext } from "./api/context.js";

export type DualModelVerdictKind = "tool_checkpoint" | "org_change";

export interface DualModelVerdictRequest {
  /** The real session/decision this verdict is about — for cwd inheritance and audit linkage. */
  parentSessionId: string;
  /** Must equal the autonomous project's cwd (callers are expected to have already checked this). */
  cwd: string;
  decisionKind: DualModelVerdictKind;
  /** The rendered decision packet: the blocked command + triggers + transcript tail, or the org-change diff/summary. */
  contextPrompt: string;
}

export type VerdictOutcome = "approved" | "not_approved" | "error" | "unparseable" | "timeout";

export interface SingleModelVerdict {
  rung: "claude-fable-5" | "gpt-5.6-sol";
  outcome: VerdictOutcome;
  reason: string;
  /** Last raw assistant text, kept for the audit trail even when unparseable. */
  raw?: string;
}

export interface DualModelVerdictResult {
  authorized: boolean;
  claude: SingleModelVerdict;
  codex: SingleModelVerdict;
}

interface Rung {
  rung: SingleModelVerdict["rung"];
  engine: string;
  model: string;
}

// No `?? employee.engine` / `?? session.model` fallback, ever — see module docblock.
const RUNGS: readonly [Rung, Rung] = [
  { rung: "claude-fable-5", engine: "claude", model: "claude-fable-5" },
  { rung: "gpt-5.6-sol", engine: "codex", model: "gpt-5.6-sol" },
];

// Shorter than employee-execution.ts's 300s implementer budget — a verdict
// turn is a small, bounded judgment call, not open-ended implementation work.
const VERDICT_TIMEOUT_MS = 90_000;

function buildVerdictSystemPrompt(kind: DualModelVerdictKind): string {
  const subject = kind === "org_change" ? "a proposed organizational/HR change" : "a blocked tool action";
  return `You are an independent safety reviewer evaluating whether ${subject} should be authorized to proceed without a human operator in the loop.

You have READ-ONLY, judge-only access. Do not run shell commands, write files, or modify any repository contents — your job is to judge, not to act.

Return a structured JSON verdict — your ENTIRE response must be valid JSON:

{
  "approved": true | false,
  "reason": "One or two sentence justification."
}

Approve only if you are confident this specific action is safe and appropriate to run unattended. If you are uncertain, or the risk is non-trivial, set approved to false — a false verdict simply defers the decision to a human operator, it does not itself block or reject anything.

Return ONLY the JSON object. No prose before or after.`;
}

function buildVerdictPacketPrompt(input: DualModelVerdictRequest): string {
  return `## Autonomous Authorization Review

**Decision needed:**
${input.contextPrompt}

Please evaluate the above and return your structured JSON verdict.`;
}

function buildVerdictRepairPrompt(error: string): string {
  return `Your previous response could not be parsed as a verdict.

Problem: ${error}

Reply again with ONLY the JSON verdict object — no prose, no markdown, no code fences:

{
  "approved": true | false,
  "reason": "One or two sentence justification."
}`;
}

type VerdictValidation =
  | { ok: true; value: { approved: boolean; reason: string } }
  | { ok: false; error: string };

function validateAutonomousVerdict(raw: string): VerdictValidation {
  if (!raw || !raw.trim()) return { ok: false, error: "verdict response was empty" };
  const cleaned = raw.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
  let obj: unknown;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    return { ok: false, error: "verdict response was not valid JSON" };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, error: "verdict response was not a JSON object" };
  }
  const record = obj as Record<string, unknown>;
  if (typeof record.approved !== "boolean") {
    return { ok: false, error: "verdict response was missing a boolean 'approved' field" };
  }
  return {
    ok: true,
    value: { approved: record.approved, reason: typeof record.reason === "string" ? record.reason : "" },
  };
}

function readLastAssistantMessage(sessionId: string): string | null {
  const assistant = getMessages(sessionId).filter((m) => m.role === "assistant" && !m.partial);
  const last = assistant[assistant.length - 1];
  return last ? last.content : null;
}

/** Races a turn dispatch against the verdict timeout; on timeout, interrupts
 *  the engine rather than leaving the child session running unattended. */
async function runTurnWithTimeout(
  verdictSession: Session,
  prompt: string,
  engine: NonNullable<ReturnType<ApiContext["sessionManager"]["getEngine"]>>,
  config: CuttlefishConfig,
  context: ApiContext,
): Promise<"settled" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), VERDICT_TIMEOUT_MS);
  });
  const run = (async (): Promise<"settled"> => {
    insertMessage(verdictSession.id, "user", prompt);
    await dispatchWebSessionRun(verdictSession, prompt, engine, config, context);
    return "settled";
  })();
  const outcome = await Promise.race([run, timeout]);
  if (timer) clearTimeout(timer);
  if (outcome === "timeout") killSessionEngines(context, verdictSession, "autonomous verdict timed out");
  return outcome;
}

async function attemptRung(
  rung: Rung,
  input: DualModelVerdictRequest,
  parentSession: Session,
  context: ApiContext,
): Promise<SingleModelVerdict> {
  const engine = context.sessionManager.getEngine(rung.engine);
  if (!engine) {
    logger.warn(`[autonomous] verdict engine "${rung.engine}" (${rung.rung}) not available`);
    return { rung: rung.rung, outcome: "error", reason: `engine "${rung.engine}" not available` };
  }

  const verdictSession = createSession({
    engine: rung.engine,
    model: rung.model,
    source: parentSession.source,
    sourceRef: `autonomous-verdict:${input.decisionKind}:${rung.rung}:${randomUUID()}`,
    connector: parentSession.connector ?? parentSession.source,
    parentSessionId: parentSession.id,
    // Inherit the project cwd so the verdict session can actually read the
    // files/diff it's being asked to judge — restrictToJudgeOnly (derived
    // from the autonomousVerdictSession stamp below, in run-web-session.ts)
    // keeps this read-only rather than granting real access.
    cwd: input.cwd,
    title: `Autonomous verdict (${rung.rung}): ${parentSession.title ?? parentSession.id}`,
    // Deliberately no `employee:` — never an org member, never board-synced.
    // `autonomousVerdictSession: true` is the recursion guard (every choke
    // point must skip straight to the human path for sessions carrying it)
    // AND the judge-only engine restriction signal (read in run-web-session.ts).
    transportMeta: { autonomousVerdictSession: true } as unknown as JsonObject,
    portalName: context.getConfig().portal?.portalName,
  });

  const config = context.getConfig();
  const systemPrompt = buildVerdictSystemPrompt(input.decisionKind);
  const packetPrompt = buildVerdictPacketPrompt(input);

  const first = await runTurnWithTimeout(verdictSession, `${systemPrompt}\n\n${packetPrompt}`, engine, config, context);
  if (first === "timeout") {
    return { rung: rung.rung, outcome: "timeout", reason: `no verdict within ${VERDICT_TIMEOUT_MS}ms` };
  }
  const settled = getSession(verdictSession.id);
  if (!settled || settled.status === "error" || settled.status === "interrupted") {
    return { rung: rung.rung, outcome: "error", reason: "verdict session errored or was interrupted" };
  }

  const firstRaw = readLastAssistantMessage(verdictSession.id) ?? "";
  const firstResult = validateAutonomousVerdict(firstRaw);
  if (firstResult.ok) {
    return {
      rung: rung.rung,
      outcome: firstResult.value.approved ? "approved" : "not_approved",
      reason: firstResult.value.reason,
      raw: firstRaw,
    };
  }

  // One in-place JSON repair retry on the SAME session, mirroring the
  // mid-pair reviewer idiom — no cross-rung retries, no engine swap on failure.
  logger.warn(`[autonomous] verdict ${rung.rung} unparseable (${firstResult.error}); requesting one JSON repair`);
  const repair = await runTurnWithTimeout(verdictSession, buildVerdictRepairPrompt(firstResult.error), engine, config, context);
  if (repair === "timeout") {
    return { rung: rung.rung, outcome: "timeout", reason: `repair retry exceeded ${VERDICT_TIMEOUT_MS}ms` };
  }
  const repairSettled = getSession(verdictSession.id);
  if (!repairSettled || repairSettled.status === "error" || repairSettled.status === "interrupted") {
    return { rung: rung.rung, outcome: "error", reason: `verdict session errored during repair retry (${firstResult.error})` };
  }
  const repairedRaw = readLastAssistantMessage(verdictSession.id) ?? "";
  const repaired = validateAutonomousVerdict(repairedRaw);
  if (repaired.ok) {
    return {
      rung: rung.rung,
      outcome: repaired.value.approved ? "approved" : "not_approved",
      reason: repaired.value.reason,
      raw: repairedRaw,
    };
  }
  return { rung: rung.rung, outcome: "unparseable", reason: repaired.error, raw: repairedRaw };
}

export async function requestDualModelVerdict(
  input: DualModelVerdictRequest,
  context: ApiContext,
): Promise<DualModelVerdictResult> {
  const parentSession = getSession(input.parentSessionId);
  if (!parentSession) {
    const reason = `parent session ${input.parentSessionId} not found`;
    return {
      authorized: false,
      claude: { rung: "claude-fable-5", outcome: "error", reason },
      codex: { rung: "gpt-5.6-sol", outcome: "error", reason },
    };
  }

  const [claude, codex] = await Promise.all(RUNGS.map((rung) => attemptRung(rung, input, parentSession, context)));
  const authorized = claude.outcome === "approved" && codex.outcome === "approved";
  logger.info(
    `[autonomous] verdict ${input.decisionKind} session=${input.parentSessionId} claude=${claude.outcome} codex=${codex.outcome} authorized=${authorized}`,
  );
  return { authorized, claude, codex };
}
