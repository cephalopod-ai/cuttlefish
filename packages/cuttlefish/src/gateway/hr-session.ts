import { getSessionBySessionKey, listSessions } from "../sessions/registry.js";
import type { Session } from "../shared/types.js";
import { HR_EMPLOYEE_NAME, HR_SESSION_KEY } from "./org-policy.js";

export interface HrSessionProfileRequest {
  engine?: string;
  model?: string;
  effortLevel?: string;
  cwd?: string | null;
}

export interface HrSessionProfileConflict {
  field: keyof HrSessionProfileRequest;
  requested: string | null;
  existing: string | null;
}

/**
 * Reuse the singleton HR session when present, but also fall back to the most
 * recent legacy HR web session created before the singleton key existed.
 */
export function getReusableHrSession(): Session | undefined {
  const singleton = getSessionBySessionKey(HR_SESSION_KEY);
  if (singleton) return singleton;
  return listSessions().find((session) => session.employee === HR_EMPLOYEE_NAME && session.source === "web");
}

/**
 * A normal HR prompt may continue the singleton thread, but an operator who
 * explicitly selects a different execution profile must not have that request
 * silently appended to an older, incompatible session.
 */
export function findHrSessionProfileConflict(
  session: Pick<Session, "engine" | "model" | "effortLevel" | "cwd">,
  requested: HrSessionProfileRequest,
): HrSessionProfileConflict | null {
  const fields: Array<keyof HrSessionProfileRequest> = ["engine", "model", "effortLevel", "cwd"];
  for (const field of fields) {
    const wanted = requested[field];
    if (wanted === undefined) continue;
    const existing = session[field] ?? null;
    if (wanted !== existing) {
      return { field, requested: wanted, existing };
    }
  }
  return null;
}
