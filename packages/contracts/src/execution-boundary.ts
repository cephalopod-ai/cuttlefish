/** Gateway-owned state. Deserializing this shape never authenticates its author. */
export type ExecutionOriginKind = "operator" | "session" | "connector" | "peer" | "scheduler" | "internal" | "history" | "unknown";
export type ExecutionRequirement = "standard" | "read_only";

export interface SessionExecutionBoundary {
  version: 1;
  origin: ExecutionOriginKind;
  requirement: ExecutionRequirement;
  generation: string;
  parentGeneration: string | null;
  cancelled: boolean;
}

export interface QueueDispatchAuthority {
  version: 1;
  generation: string;
  delegationId: string | null;
  payloadHash: string;
  /** A callback is evidence from this exact child attempt, not a new task grant. */
  sourceSessionId: string | null;
  sourceRunId: string | null;
  decision?: { approvalId: string; revision: string; materialHash: string; engine: string; model: string | null;
    delegateSessionId: string | null; delegationId: string | null };
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const origins: readonly string[] = ["operator", "session", "connector", "peer", "scheduler", "internal", "history", "unknown"];
const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128;
const nullableIdentifier = (value: unknown): boolean => value === null || identifier(value);

export function isSessionExecutionBoundary(value: unknown): value is SessionExecutionBoundary {
  return record(value) && value.version === 1 && origins.includes(value.origin as string)
    && (value.requirement === "standard" || value.requirement === "read_only")
    && identifier(value.generation) && nullableIdentifier(value.parentGeneration) && typeof value.cancelled === "boolean";
}

export function isQueueDispatchAuthority(value: unknown): value is QueueDispatchAuthority {
  return record(value) && value.version === 1 && identifier(value.generation)
    && typeof value.payloadHash === "string" && /^[a-f0-9]{64}$/.test(value.payloadHash)
    && nullableIdentifier(value.delegationId) && nullableIdentifier(value.sourceSessionId) && nullableIdentifier(value.sourceRunId)
    && ((value.sourceSessionId === null) === (value.sourceRunId === null))
    && (value.decision === undefined || (record(value.decision) && identifier(value.decision.approvalId) && identifier(value.decision.revision)
      && typeof value.decision.materialHash === "string" && /^[a-f0-9]{64}$/.test(value.decision.materialHash)
      && identifier(value.decision.engine) && nullableIdentifier(value.decision.model)
      && nullableIdentifier(value.decision.delegateSessionId) && nullableIdentifier(value.decision.delegationId)
      && ((value.decision.delegateSessionId === null) === (value.decision.delegationId === null))));
}
