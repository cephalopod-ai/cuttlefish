import { isInterruptibleEngine, type Session } from "../../shared/types.js";
import type { PublicSession } from "@cuttlefish/contracts";
import type { ApiContext } from "./context.js";
import { enrichRunAttachmentsForSession } from "../run-attachments.js";
import { type ExecutionRunState } from "../employee-execution.js";

const BACKGROUND_ACTIVITY_STALE_MS = 5 * 60 * 1000;

function extractExecutionRunState(session: Session): ExecutionRunState | null {
  const meta = session.transportMeta as Record<string, unknown> | undefined;
  if (!meta) return null;
  const employeeRunId = meta["employeeRunId"];
  const tier = meta["executionTier"];
  if (typeof employeeRunId !== "string" || typeof tier !== "string") return null;
  return {
    employeeRunId,
    tier: tier as ExecutionRunState["tier"],
    phase: (typeof meta["executionPhase"] === "string" ? meta["executionPhase"] : "implementing") as ExecutionRunState["phase"],
    childSessionCount: typeof meta["executionChildCount"] === "number" ? meta["executionChildCount"] : 0,
    degraded: meta["executionDegraded"] === true,
    degradedReason: typeof meta["executionDegradedReason"] === "string" ? meta["executionDegradedReason"] : undefined,
    fallbackActive: meta["executionFallbackActive"] === true,
    pass: typeof meta["executionPass"] === "number" ? meta["executionPass"] : 1,
    maxPasses: typeof meta["executionMaxPasses"] === "number" ? meta["executionMaxPasses"] : 1,
    reviewContext: meta["executionReviewContext"] === "diff" || meta["executionReviewContext"] === "summary_only"
      ? meta["executionReviewContext"]
      : undefined,
    reviewContextReason: typeof meta["executionReviewContextReason"] === "string" ? meta["executionReviewContextReason"] : undefined,
  };
}

export function serializeSession(session: Session, context: ApiContext): Session & PublicSession & { executionRunState?: ExecutionRunState | null } {
  const queue = context.sessionManager.getQueue();
  const queueDepth = queue.getPendingCount(session.sessionKey || session.sourceRef);
  const transportState = queue.getTransportState(session.sessionKey || session.sourceRef, session.status);
  const bg = context.backgroundActivity?.get(session.id);
  const bgIsStale = bg && Date.now() - bg.lastActivityAt > BACKGROUND_ACTIVITY_STALE_MS;
  if (bgIsStale) context.backgroundActivity?.delete(session.id);
  const executionRunState = extractExecutionRunState(session);
  return {
    ...session,
    attachments: enrichRunAttachmentsForSession(session),
    queueDepth,
    transportState,
    backgroundActivity: bg && !bgIsStale
      ? { activeStreams: bg.activeStreams, lastActivityAt: new Date(bg.lastActivityAt).toISOString() }
      : null,
    ...(executionRunState ? { executionRunState } : {}),
  };
}

export function isSessionLiveRunning(session: Session, context: ApiContext): boolean {
  if (session.status !== "running") return false;
  const engine = context.sessionManager.getEngine(session.engine);
  if (!engine || !isInterruptibleEngine(engine)) return true;
  if ("isTurnRunning" in engine) return Boolean((engine as any).isTurnRunning(session.id));
  return engine.isAlive(session.id);
}
