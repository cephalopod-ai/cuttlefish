/**
 * UPS-A5: names an employee may not claim, because the audit and authority
 * layers already use them to mean something other than "an employee".
 *
 * Cuttlefish stamps an actor string in several places that decide, or later
 * evidence, who did something:
 *
 *  - `gateway/hr-steward.ts` records `"operator"` when no actor is supplied, and
 *    writes it into the transcript line that says a human approved an org change.
 *  - `sessions/operator-delegation.ts` records `grantedBy: "operator"` for a
 *    grant with no named granter.
 *  - `gateway/org-policy.ts`'s `assertNotSelfModification` reads the proposer as
 *    `"user"` when none is given, and treats a proposer NOT in its agent-alias
 *    set as a human — so the string is load-bearing in both directions.
 *  - `"session"`, `"cron"` and `"workflow"` name origins of work, not people
 *    (`board-service.ts`, `board-sync.ts`, `scoped-token.ts`).
 *
 * An employee slug equal to one of those turns an agent's own action into
 * something the audit trail reads as the operator's, the system's, or a
 * session's. Reserving the namespace is what keeps the actor string honest;
 * the alternative — teaching every comparison to carry a kind alongside the
 * name — is the same fix spread over a dozen call sites.
 *
 * The reservation is enforced at both ends: `validateEmployeeCreate` refuses a
 * colliding name up front, and `scanOrg` skips a colliding YAML that reached
 * `org/` some other way (a hand-written file, a restored backup) with a warning
 * rather than loading it.
 */

const RESERVED_ACTOR_NAMES = [
  // Human authority.
  "operator",
  "user",
  "human",
  "you",
  // System / non-human authority.
  "system",
  "agent",
  "cuttlefish",
  // Origins of work rather than actors.
  "session",
  "cron",
  "workflow",
  "unknown",
  "anonymous",
] as const;

const RESERVED_ACTOR_SET = new Set<string>(RESERVED_ACTOR_NAMES);

/**
 * Prefixes reserved for machine-minted author strings (`cron:<jobId>`,
 * `session:<id>`). An employee name may not start with one, or a stamped author
 * could be confused for an employee and vice versa.
 */
const RESERVED_ACTOR_PREFIXES = ["operator:", "system:", "session:", "cron:", "workflow:", "agent:"] as const;

export function reservedActorNames(): readonly string[] {
  return RESERVED_ACTOR_NAMES;
}

/**
 * True when `name` collides with a reserved actor identity.
 *
 * Case-insensitive, because the actor strings above are compared after
 * `toLowerCase()` (see `assertNotSelfModification`) and employee YAML filenames
 * are case-insensitive on the default macOS and Windows filesystems.
 */
export function isReservedActorName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return false;
  if (RESERVED_ACTOR_SET.has(normalized)) return true;
  return RESERVED_ACTOR_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/** Operator-facing explanation for a refused or skipped name. */
export function reservedActorNameReason(name: string): string {
  return `employee name "${name}" is reserved: it is used to identify the operator, the system, or the origin of a piece of work in audit records, so an employee may not claim it`;
}
