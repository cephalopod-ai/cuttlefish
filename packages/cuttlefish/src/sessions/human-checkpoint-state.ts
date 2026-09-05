import type { Session } from "../shared/types.js";

/** A turn finishing is not authority to clear an operator-owned checkpoint. */
export function isHumanCheckpointPaused(session: Session | undefined): boolean {
  if (session?.status !== "waiting") return false;
  const checkpoint = session.transportMeta?.humanCheckpoint;
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) return false;
  return checkpoint.state === "pending" || checkpoint.resultingAction === "stay_paused";
}
