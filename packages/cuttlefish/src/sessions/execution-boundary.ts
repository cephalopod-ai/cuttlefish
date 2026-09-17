import { randomUUID } from "node:crypto";
import type { ExecutionOriginKind, ExecutionRequirement, QueueDispatchAuthority, SessionExecutionBoundary } from "@cuttlefish/contracts";
import type { Session } from "../shared/types.js";
import { operatorDelegationPromptHash, readActiveOperatorDelegationGrant } from "./operator-delegation.js";

export function buildSessionExecutionBoundary(input: {
  origin: ExecutionOriginKind;
  requirement?: ExecutionRequirement;
  parent?: Session;
}): SessionExecutionBoundary {
  if (input.requirement !== undefined && !["standard", "read_only"].includes(input.requirement)) throw new Error("Unsupported execution requirement");
  if (input.parent?.executionBoundaryInvalid) throw new Error("Parent execution boundary is corrupt or unsupported");
  return {
    version: 1,
    origin: input.origin,
    requirement: input.parent?.executionBoundary?.requirement === "read_only" ? "read_only" : input.requirement ?? "standard",
    generation: randomUUID(),
    parentGeneration: input.parent?.executionBoundary?.generation ?? null,
    cancelled: false,
  };
}

export function queueDispatchAuthority(session: Session, prompt: string, source?: Session): QueueDispatchAuthority | null {
  if (!session.executionBoundary) return null; // Legacy work has no new authority guarantee.
  const grant = readActiveOperatorDelegationGrant(session);
  const rawGrant = session.transportMeta?.operatorDelegation;
  const boundGrant = rawGrant && typeof rawGrant === "object" && !Array.isArray(rawGrant)
    && rawGrant.promptHash === operatorDelegationPromptHash(prompt) ? rawGrant : null;
  const runId = source?.transportMeta?.latestRunId;
  return {
    version: 1,
    generation: session.executionBoundary.generation,
    delegationId: boundGrant ? (grant?.id ?? (typeof boundGrant.id === "string" ? boundGrant.id : "invalid")) : null,
    payloadHash: operatorDelegationPromptHash(prompt),
    sourceSessionId: source && typeof runId === "string" ? source.id : null,
    sourceRunId: typeof runId === "string" ? runId : null,
  };
}

/** Safe export/provenance view: current authority must always be resolved locally. */
export function sessionEvidenceBoundary(session: Session): Record<string, string | number | null> {
  return {
    version: 1,
    role: "reference_evidence",
    origin: session.executionBoundary?.origin ?? "unknown",
    requirement: session.executionBoundary?.requirement ?? "unestablished",
    sessionId: session.id,
    runId: typeof session.transportMeta?.latestRunId === "string" ? session.transportMeta.latestRunId : null,
    authority: "historical_only",
  };
}

/** Cancellation invalidates pending work and credentials even when a CLI cannot be killed. */
export function cancelSessionExecutionBoundary(session: Session): SessionExecutionBoundary {
  return { ...(session.executionBoundary ?? buildSessionExecutionBoundary({ origin: "unknown" })),
    generation: randomUUID(), cancelled: true };
}
