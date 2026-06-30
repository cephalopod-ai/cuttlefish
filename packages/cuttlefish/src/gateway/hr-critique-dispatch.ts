/**
 * HR critique session dispatch (ARC-CF-002).
 *
 * This collaborator owns the *mechanism* of running an HR critique turn:
 * resolving the hr-manager employee + engine, getting-or-creating the reused HR
 * session, building the critique prompt, and dispatching the web-session run.
 *
 * It is kept separate from `hr-steward.ts` (which owns the *domain* logic —
 * guards, classification, the apply path) so the critique strategy (engine
 * choice, how the turn is queued/dispatched) can change without editing the org
 * mutation pipeline. `hr-steward.ts` consumes this as its default `runCritique`
 * dependency, and tests can inject a different runner entirely.
 */
import { scanOrg } from "./org.js";
import { HR_EMPLOYEE_NAME, HR_SESSION_KEY } from "./org-policy.js";
import { logger } from "../shared/logger.js";
import {
  createSession,
  getMessages,
  insertMessage,
  updateSession,
} from "../sessions/registry.js";
import { dispatchWebSessionRun } from "./api/session-dispatch.js";
import type { ApiContext } from "./api/context.js";
import type { Employee, OrgChangeRequest } from "../shared/types.js";
import { getReusableHrSession } from "./hr-session.js";

/** Result of an HR critique turn. */
export interface CritiqueResult {
  critique: string | null;
  /** The HR session that produced the critique, if one was spawned. */
  sessionId?: string;
}

let hrSessionPromise: Promise<ReturnType<typeof createSession> | NonNullable<ReturnType<typeof updateSession>>> | null = null;

/** Default critique runner: spawn the hr-manager employee in-process and read its reply. */
export async function defaultRunCritique(request: OrgChangeRequest, context: ApiContext): Promise<CritiqueResult> {
  const config = context.getConfig();
  const registry = scanOrg();
  const hr = registry.get(HR_EMPLOYEE_NAME);
  if (!hr) {
    logger.warn(`HR critique skipped: "${HR_EMPLOYEE_NAME}" employee not found`);
    return { critique: null };
  }
  const engineName = hr.engine || config.engines.default;
  const engine = context.sessionManager.getEngine(engineName);
  if (!engine) {
    logger.warn(`HR critique skipped: engine "${engineName}" not available`);
    return { critique: null };
  }

  const prompt = buildCritiquePrompt(request, registry);
  const now = new Date().toISOString();
  const session = await getOrCreateHrSession({
    engineName,
    hr,
    now,
    prompt,
    portalName: config.portal?.portalName,
  });
  insertMessage(session.id, "user", prompt);
  await dispatchWebSessionRun(session, prompt, engine, config, context);
  return { critique: readLastAssistantMessage(session.id), sessionId: session.id };
}

async function getOrCreateHrSession(input: {
  engineName: string;
  hr: Employee;
  now: string;
  prompt: string;
  portalName: string | undefined;
}) {
  if (hrSessionPromise) return hrSessionPromise;
  hrSessionPromise = Promise.resolve().then(() => {
    const existing = getReusableHrSession();
    return existing
      ? (updateSession(existing.id, {
          engine: input.engineName,
          model: input.hr.model ?? null,
          effortLevel: input.hr.effortLevel ?? null,
          status: "running",
          lastActivity: input.now,
          lastError: null,
        }) ?? existing)
      : createSession({
          engine: input.engineName,
          source: "web",
          sourceRef: HR_SESSION_KEY,
          connector: "web",
          sessionKey: HR_SESSION_KEY,
          replyContext: { source: "web" },
          employee: HR_EMPLOYEE_NAME,
          model: input.hr.model,
          effortLevel: input.hr.effortLevel,
          prompt: input.prompt,
          portalName: input.portalName,
        });
  }).finally(() => {
    hrSessionPromise = null;
  });
  return hrSessionPromise;
}

function readLastAssistantMessage(sessionId: string): string | null {
  const assistant = getMessages(sessionId).filter((m) => m.role === "assistant" && !m.partial);
  const last = assistant[assistant.length - 1];
  return last ? last.content : null;
}

function buildCritiquePrompt(request: OrgChangeRequest, registry: Map<string, Employee>): string {
  const roster = [...registry.values()]
    .map(
      (e) =>
        `- ${e.name} (${e.displayName}) — ${e.rank} in ${e.department}, ${e.engine}/${e.model}` +
        (e.lifecycle && e.lifecycle !== "active" ? ` [${e.lifecycle}]` : ""),
    )
    .join("\n");

  return [
    `A **${request.changeType}** change has been proposed for "${request.employeeName}".`,
    request.rationale ? `\nStated rationale: ${request.rationale}` : "",
    `\n## Proposed change`,
    `\n### Before\n${request.beforeYaml ?? "(new employee — nothing exists yet)"}`,
    `\n### After\n${request.afterYaml ?? "(none)"}`,
    `\n## Current roster\n${roster || "(empty)"}`,
    `\n## Your task`,
    `Critique this change against your invariants. Lead with a verdict — recommend, revise, or argue against —`,
    `then cover: redundancy vs the roster, scope (narrow & measurable?), model & cost fit, structure`,
    `(department/rank/reportsTo, no cycles), guardrails (minimal tool grants, forbidden actions, escalation),`,
    `and a rollback path. Be concise and decisive. This is an automatic pre-decision review; the operator`,
    `will read your critique before approving.`,
  ].join("\n");
}
