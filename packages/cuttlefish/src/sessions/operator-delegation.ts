import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Session } from "../shared/types.js";
import { ORG_DIR } from "../shared/paths.js";
import { findEmployeeYamlPath } from "../gateway/org.js";

export const OPERATOR_DELEGATION_SCOPES = ["approve", "decide", "plan", "act"] as const;
export type OperatorDelegationScope = (typeof OPERATOR_DELEGATION_SCOPES)[number];

export interface OperatorDelegationGrant {
  version: 1;
  /** Unique host issuance, even when the operator repeats identical text. */
  id: string;
  state: "active";
  scopes: OperatorDelegationScope[];
  promptHash: string;
  grantedAt: string;
  grantedBy: string;
  expiresAt: string;
  sessionId: string;
  generation: string;
  engine: string;
  model: string | null;
  employee: string | null;
  /** Only the issuing employee's exact configuration revision; no tree scan at use. */
  employeePolicy: { relativePath: string; sha256: string } | null;
}

const PROGRAM_MANAGER_NAME = "program-manager";
const ALLOWED_MODELS = new Set([
  "codex::gpt-6-astra",
  "codex::gpt-5.5",
  "codex::gpt-5.6-sol",
  "claude::claude-opus-5",
  "claude::claude-opus-4-8",
  "claude::opus",
  "claude::claude-fable-5-1",
  "claude::claude-fable-5",
]);

/**
 * Human-readable rendering of {@link ALLOWED_MODELS}, for the 403 bodies and the
 * runtime guidance injected into a delegated turn.
 *
 * Derived from the set rather than restated: the two were previously written out
 * by hand in three places, so widening the allowlist left the agent being told a
 * model was forbidden that the gateway had just accepted.
 */
export const HUMAN_DELEGATION_MODELS_LABEL: string = [...ALLOWED_MODELS]
  .map((rung) => rung.replace("::", "/"))
  .join(", ");

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function isHumanDelegationModelAllowed(engine: string, model: string | null | undefined): boolean {
  return ALLOWED_MODELS.has(`${normalize(engine)}::${normalize(model)}`);
}

export function isHumanDelegateRole(employeeName: string | null | undefined, source = "web"): boolean {
  return employeeName === PROGRAM_MANAGER_NAME || (!employeeName && source !== "talk");
}

/**
 * Deliberately strict turn-level syntax. The directive must begin the direct
 * operator message, preventing quoted instructions, child callbacks, fetched
 * content, or an agent-created task body from silently minting authority.
 */
export function parseOperatorDelegationScopes(prompt: string): OperatorDelegationScope[] | null {
  const slash = /^\s*\/delegate-authority\s+([^\n]+)/i.exec(prompt);
  const natural = /^\s*(?:i\s+)?(?:explicitly\s+)?(?:authorize|delegate|grant|give)\s+you(?:\s+authority)?\s+to\s+(.{1,180}?)\s+on\s+my\s+behalf(?:\b|[.:,])/i.exec(prompt);
  const clause = slash?.[1] ?? natural?.[1];
  if (!clause) return null;
  const normalized = clause.toLowerCase();
  const scopes = OPERATOR_DELEGATION_SCOPES.filter((scope) =>
    normalized === "all" || new RegExp(`\\b${scope}(?:e|i)?(?:d|s|ing)?\\b`, "i").test(normalized),
  );
  return scopes.length > 0 ? [...scopes] : null;
}

export function operatorDelegationPromptHash(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

function employeePolicyDigest(relativePath: string): string | null {
  const candidate = path.resolve(ORG_DIR, relativePath);
  if (!candidate.startsWith(path.resolve(ORG_DIR) + path.sep) || !fs.existsSync(candidate)) return null;
  const real = fs.realpathSync(candidate);
  if (!real.startsWith(fs.realpathSync(ORG_DIR) + path.sep)) return null;
  const stat = fs.statSync(real);
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return null;
  return createHash("sha256").update(fs.readFileSync(real)).digest("hex");
}

export class OperatorDelegationPolicyError extends Error {}

export function buildOperatorDelegationGrant(input: {
  session: Pick<Session, "id" | "engine" | "model" | "employee" | "executionBoundary">;
  prompt: string;
  scopes: OperatorDelegationScope[];
  grantedBy?: string | null;
  now?: string;
}): OperatorDelegationGrant {
  const grantedAt = input.now ?? new Date().toISOString();
  if (!input.session.executionBoundary || input.session.executionBoundary.cancelled) throw new Error("Delegation requires an active gateway execution boundary");
  if (!Number.isFinite(Date.parse(grantedAt))) throw new Error("Invalid delegation issuance time");
  const employeePath = input.session.employee === PROGRAM_MANAGER_NAME ? findEmployeeYamlPath(PROGRAM_MANAGER_NAME) : undefined;
  const relativePath = employeePath ? path.relative(ORG_DIR, employeePath) : null;
  const digest = relativePath ? employeePolicyDigest(relativePath) : null;
  if (input.session.employee === PROGRAM_MANAGER_NAME && !digest) throw new OperatorDelegationPolicyError("Delegation requires an available Program Manager configuration revision");
  return {
    version: 1,
    id: randomBytes(32).toString("hex"),
    state: "active",
    scopes: [...new Set(input.scopes)],
    promptHash: operatorDelegationPromptHash(input.prompt),
    grantedAt,
    grantedBy: input.grantedBy?.trim() || "operator",
    expiresAt: new Date(Date.parse(grantedAt) + 2 * 60 * 60 * 1000).toISOString(),
    sessionId: input.session.id,
    generation: input.session.executionBoundary.generation,
    engine: input.session.engine,
    model: input.session.model,
    employee: input.session.employee,
    employeePolicy: relativePath && digest ? { relativePath, sha256: digest } : null,
  };
}

/** Strict legacy/unknown-version rejection applies only to live authority. History remains readable. */
export function readActiveOperatorDelegationGrant(session: Pick<Session, "id" | "engine" | "model" | "employee" | "transportMeta" | "executionBoundary" | "executionBoundaryInvalid">, now = Date.now()): OperatorDelegationGrant | null {
  const raw = session.transportMeta?.operatorDelegation;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const grant = raw as Record<string, unknown>;
  if (grant.version !== 1 || grant.state !== "active" || typeof grant.id !== "string" || !/^[a-f0-9]{64}$/.test(grant.id)
    || typeof grant.promptHash !== "string" || !/^[a-f0-9]{64}$/.test(grant.promptHash)
    || !Array.isArray(grant.scopes) || grant.scopes.length === 0 || grant.scopes.some((scope) => !OPERATOR_DELEGATION_SCOPES.includes(scope as OperatorDelegationScope))
    || typeof grant.grantedBy !== "string" || !grant.grantedBy
    || typeof grant.grantedAt !== "string" || typeof grant.expiresAt !== "string") return null;
  const issued = Date.parse(grant.grantedAt);
  const expires = Date.parse(grant.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > now || expires <= now || expires - issued > 2 * 60 * 60 * 1000 || expires <= issued) return null;
  if (session.executionBoundaryInvalid || !session.executionBoundary || session.executionBoundary.cancelled
    || grant.sessionId !== session.id || grant.generation !== session.executionBoundary.generation
    || grant.engine !== session.engine || grant.model !== session.model || grant.employee !== session.employee) return null;
  if (session.employee === PROGRAM_MANAGER_NAME) {
    const policy = grant.employeePolicy;
    if (!policy || typeof policy !== "object" || Array.isArray(policy)) return null;
    const value = policy as Record<string, unknown>;
    if (typeof value.relativePath !== "string" || typeof value.sha256 !== "string") return null;
    try { if (employeePolicyDigest(value.relativePath) !== value.sha256) return null; } catch { return null; }
  } else if (grant.employeePolicy !== null) return null;
  return grant as unknown as OperatorDelegationGrant;
}

export function readOperatorDelegationScopesForTurn(
  session: Session,
  prompt: string,
): OperatorDelegationScope[] {
  const grant = readActiveOperatorDelegationGrant(session);
  return grant?.promptHash === operatorDelegationPromptHash(prompt) ? grant.scopes : [];
}

export function readActiveOperatorDelegationScopes(session: Session): OperatorDelegationScope[] {
  return readActiveOperatorDelegationGrant(session)?.scopes ?? [];
}

export function activeOperatorDelegationMatches(
  session: Session,
  operatorDelegationId: string | undefined,
): boolean {
  if (!operatorDelegationId) return false;
  return readActiveOperatorDelegationGrant(session)?.id === operatorDelegationId;
}

export function expireOperatorDelegationForPrompt(
  session: Pick<Session, "transportMeta">,
  prompt: string,
  now = new Date().toISOString(),
  issuanceId?: string | null,
): Record<string, unknown> | null {
  const raw = (session.transportMeta as Record<string, unknown> | null)?.operatorDelegation;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const grant = raw as Record<string, unknown>;
  if (!issuanceId || grant.id !== issuanceId || grant.state !== "active" || grant.promptHash !== operatorDelegationPromptHash(prompt)) return null;
  return { ...grant, state: "expired", expiredAt: now };
}
