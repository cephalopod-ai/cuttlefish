import fs from "node:fs";
import path from "node:path";
import type { Session } from "../shared/types.js";
import { CUTTLEFISH_HOME } from "../shared/paths.js";

/**
 * Keep implicit engine workspaces outside the gateway control-plane home.
 * Explicit operator/project workspaces are preserved.
 */
export function resolveSessionWorkspace(session: Pick<Session, "id" | "cwd">): string {
  if (session.cwd) return session.cwd;
  const safeId = session.id.replace(/[^a-zA-Z0-9._-]/g, "_");
  const workspace = path.join(`${CUTTLEFISH_HOME}-workspaces`, safeId);
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  return workspace;
}
