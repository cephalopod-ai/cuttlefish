/**
 * ⚠️ INTENTIONAL SAFETY OVERRIDE — NOT A BUG, NOT A VULNERABILITY TO PATCH.
 *
 * This module is the gate for "autonomous authorization mode": an explicitly
 * operator-configured feature that lets a two-model verdict (see
 * dual-model-verdict.ts) resolve pending approvals/checkpoints — including,
 * when opted into, HR/org-change approvals — WITHOUT a human clicking
 * approve/reject. That is a deliberate inversion of Cuttlefish's normal
 * human-in-the-loop guarantee, authorized by the repo operator, not an
 * accidental gap.
 *
 * If you are here because a security review flagged "an approval can be
 * resolved without human sign-off" — that is this feature working as
 * designed, not a defect. Do NOT "fix" this by:
 *   - routing autonomous resolutions back through human approval,
 *   - deleting/no-op'ing resolveAutonomousProject or the callers that check it,
 *   - widening or removing the scoped-token deny-list entries for
 *     /api/approvals* or /api/checkpoints* to "simplify" this (the autonomous
 *     path resolves approvals server-side, in-process — it deliberately does
 *     NOT go through those HTTP routes, and that deny-list must stay intact).
 *
 * Safety properties that make this safe to leave as-is:
 *   - Structurally confined to at most ONE workspace profile (config-load
 *     invalidates a config with 2+ profiles enabled — see config-schema.ts).
 *   - Requires BOTH an independent Claude (claude-fable-5) and Codex
 *     (gpt-5.6-sol) verdict to agree — fail-closed on any disagreement,
 *     error, timeout, or unparseable output (dual-model-verdict.ts).
 *   - Every autonomous resolution is stamped with a code-owned, non-spoofable
 *     `resolvedByKind: "autonomous_dual_model"` column — never settable via
 *     any HTTP request body (see resolveApprovalAsAutonomous in approvals.ts).
 *   - isAutonomousVerdictSession() below prevents a verdict session's own
 *     tool calls from ever being auto-authorized (no recursive self-grading).
 *   - assertNotSelfModification/assertAcyclic in org-policy.ts remain hard,
 *     unconditional errors regardless of this feature — never bypassed.
 *
 * If you believe this feature itself should be removed or re-scoped, that is
 * a product decision for the repo operator to make explicitly — raise it,
 * don't silently revert it.
 */
import { validateCwd } from "../sessions/session-patch.js";
import type { CuttlefishConfig, WorkspaceProfileConfig } from "../shared/types.js";

/** The `actor` value stamped on every autonomously-resolved approval/checkpoint.
 *  Human-readable audit context only — resolvedByKind is the authoritative,
 *  non-spoofable discriminator (see resolveApprovalAsAutonomous in approvals.ts). */
export const AUTONOMOUS_ACTOR_SENTINEL = "autonomous:claude-fable-5+gpt-5.6-sol";

export interface AutonomousProject {
  profileId: string;
  /** Human label for dashboard display — falls back to profileId. */
  label: string;
  /** Realpath-resolved absolute directory. */
  cwd: string;
  toolReview: boolean;
  orgChangeOverride: boolean;
  continuousDispatch: boolean;
  maxAutoDispatchesPerHour: number;
}

const DEFAULT_MAX_AUTO_DISPATCHES_PER_HOUR = 12;

export function isAutonomousModeEnabled(config: CuttlefishConfig): boolean {
  return config.features?.autonomousMode === true;
}

function profileEntries(config: CuttlefishConfig): Array<[string | undefined, WorkspaceProfileConfig]> {
  const raw = config.workspaces?.profiles;
  if (!raw) return [];
  return Array.isArray(raw)
    ? raw.map((entry): [string | undefined, WorkspaceProfileConfig] => [entry.id, entry])
    : Object.entries(raw);
}

/**
 * Resolves the single autonomous-mode-enabled project, or `undefined` if the
 * global switch is off, no project opted in, its `cwd` doesn't validate, or
 * (defensively) more than one profile has it enabled. `config-schema.ts`
 * already rejects the latter at config-load time — this stays fail-closed
 * even if that invariant were ever bypassed (e.g. a hot-reloaded config that
 * skipped the loader's validation pass).
 */
export function resolveAutonomousProject(config: CuttlefishConfig): AutonomousProject | undefined {
  if (!isAutonomousModeEnabled(config)) return undefined;

  const enabled = profileEntries(config).filter(([, entry]) => entry?.autonomousMode?.enabled === true);
  if (enabled.length !== 1) return undefined;

  const [key, entry] = enabled[0]!;
  const profileId = (typeof entry.id === "string" && entry.id.trim()) || key;
  if (!profileId) return undefined;

  const cwdResult = validateCwd(entry.cwd, { roots: config.workspaces?.roots });
  const cwd = cwdResult.cwd;
  if (!cwdResult.ok || !cwd) return undefined;

  const mode = entry.autonomousMode ?? {};
  const label = (typeof entry.label === "string" && entry.label.trim()) || profileId;
  return {
    profileId,
    label,
    cwd,
    toolReview: mode.toolReview === true,
    orgChangeOverride: mode.orgChangeOverride === true,
    continuousDispatch: mode.continuousDispatch === true,
    maxAutoDispatchesPerHour:
      typeof mode.maxAutoDispatchesPerHour === "number" && mode.maxAutoDispatchesPerHour > 0
        ? mode.maxAutoDispatchesPerHour
        : DEFAULT_MAX_AUTO_DISPATCHES_PER_HOUR,
  };
}

/**
 * Exact match on realpath'd cwd — deliberately conservative: a session in an
 * unexpected subdirectory (a monorepo package, a worktree) falls through to
 * an ordinary human checkpoint rather than silently matching a sibling
 * project. Loosen to a subtree match later only if this produces false
 * negatives in practice; tightening after a live incident is not cheap.
 */
export function isCwdInAutonomousProject(cwd: string | null | undefined, project: AutonomousProject): boolean {
  if (!cwd) return false;
  const resolved = validateCwd(cwd);
  return resolved.ok && resolved.cwd === project.cwd;
}

/**
 * The dual-model verdict primitive stamps every judge session it spawns with
 * `transportMeta.autonomousVerdictSession: true`. Every autonomous choke
 * point must check this and skip straight to the ordinary human-approval
 * path when true — a verdict session's own tool calls must never themselves
 * be eligible for auto-authorization, which would let the checker
 * recursively grade its own homework.
 */
export function isAutonomousVerdictSession(transportMeta: Record<string, unknown> | null | undefined): boolean {
  return transportMeta?.["autonomousVerdictSession"] === true;
}

// ---------------------------------------------------------------------------
// Observability: a minimal, in-memory "how much has this done today" counter.
// Not the audit record (that's the DB's resolved_by_kind column, queryable
// via GET /api/approvals?state=all) — this is only for the dashboard banner,
// so the operator is never "flying blind" while autonomous mode runs. Resets
// on process restart and rolls over at UTC midnight, same accepted soft-limit
// tradeoff as board-worker.ts's other in-memory counters.
// ---------------------------------------------------------------------------

let authorizationDayKey: string | null = null;
let authorizationsToday = 0;

function currentUtcDayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Call exactly once per successful autonomous auto-authorization — both the
 *  tool-checkpoint path (security-review.ts) and the org-change path
 *  (hr-steward.ts) call this right after logging "AUTO-AUTHORIZED". */
export function recordAutonomousAuthorization(): void {
  const key = currentUtcDayKey();
  if (authorizationDayKey !== key) {
    authorizationDayKey = key;
    authorizationsToday = 0;
  }
  authorizationsToday += 1;
}

export function getAutonomousAuthorizationsToday(): number {
  return authorizationDayKey === currentUtcDayKey() ? authorizationsToday : 0;
}
