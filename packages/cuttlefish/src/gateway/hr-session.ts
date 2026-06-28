import { getSessionBySessionKey, listSessions } from "../sessions/registry.js";
import type { Session } from "../shared/types.js";
import { HR_EMPLOYEE_NAME, HR_SESSION_KEY } from "./org-policy.js";

/**
 * Reuse the singleton HR session when present, but also fall back to the most
 * recent legacy HR web session created before the singleton key existed.
 */
export function getReusableHrSession(): Session | undefined {
  const singleton = getSessionBySessionKey(HR_SESSION_KEY);
  if (singleton) return singleton;
  return listSessions().find((session) => session.employee === HR_EMPLOYEE_NAME && session.source === "web");
}
