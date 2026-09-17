import { createHash, randomUUID } from "node:crypto";
import type {
  Approval,
  CuttlefishCheckpointDecisionV1,
  CuttlefishSessionSummaryV1,
  ExternalKnowledgeEnvelope,
  Session,
} from "../shared/types.js";
import type { SessionMessage } from "../sessions/registry/messages.js";
import { sessionEvidenceBoundary } from "../sessions/execution-boundary.js";
import { canonicalSha256 } from "../shared/canonical-json.js";

function hashSeed(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 24);
}

function excerpt(value: string | null | undefined, limit: number): string | null {
  if (!value) return null;
  const flat = value.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > limit ? flat.slice(0, limit - 1).trimEnd() + "…" : flat;
}

function latestAssistantExcerpt(messages: SessionMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "assistant" && messages[index].content.trim()) {
      return excerpt(messages[index].content, 280);
    }
  }
  return null;
}

function workspaceOf(session: Session): string | null {
  return session.cwd ?? null;
}

export function buildSessionSummaryEnvelope(
  session: Session,
  messages: SessionMessage[],
): ExternalKnowledgeEnvelope<CuttlefishSessionSummaryV1> {
  const occurredAt = session.lastActivity;
  const idempotencyKey = `session-summary:${session.id}:${session.totalTurns}:${session.lastActivity}`;
  return {
    envelopeId: randomUUID(),
    producer: "cuttlefish",
    schemaVersion: "1",
    topic: "cuttlefish.session.summary.v1",
    occurredAt,
    idempotencyKey,
    partitionKey: session.sessionKey || session.id,
    workspace: workspaceOf(session),
    actor: session.userId ?? null,
    sourceRef: session.sourceRef,
    payload: {
      evidenceBoundary: sessionEvidenceBoundary(session),
      derivation: { kind: "available_history", totalInputs: messages.length, omittedInputs: Math.max(0, messages.length - 32),
        inputs: messages.slice(-32).map((message) => ({ messageId: message.id, role: message.role, recordedAtMs: message.timestamp,
          contentRevision: canonicalSha256({ content: message.content, media: message.media, blocks: message.blocks }) })) },
      sessionId: session.id,
      source: session.source,
      sourceRef: session.sourceRef,
      engine: session.engine,
      model: session.model ?? null,
      employee: session.employee ?? null,
      status: session.status,
      promptExcerpt: session.promptExcerpt ?? null,
      finalAssistantExcerpt: latestAssistantExcerpt(messages),
      lastError: session.lastError ?? null,
      completedAt: occurredAt,
    },
  };
}

export function buildCheckpointDecisionEnvelope(
  checkpoint: Approval,
  session: Session | undefined,
): ExternalKnowledgeEnvelope<CuttlefishCheckpointDecisionV1> {
  const resolvedAt = checkpoint.resolvedAt ?? checkpoint.createdAt;
  const decisionNeeded = typeof checkpoint.payload.decisionNeeded === "string" ? checkpoint.payload.decisionNeeded : null;
  const why = typeof checkpoint.payload.why === "string" ? checkpoint.payload.why : null;
  return {
    envelopeId: hashSeed(`${checkpoint.id}:${checkpoint.state}:${resolvedAt}`),
    producer: "cuttlefish",
    schemaVersion: "1",
    topic: "cuttlefish.checkpoint.decision.v1",
    occurredAt: resolvedAt,
    idempotencyKey: `checkpoint-decision:${checkpoint.id}:${checkpoint.state}:${resolvedAt}`,
    partitionKey: session?.sessionKey ?? checkpoint.sessionId,
    workspace: session?.cwd ?? null,
    actor: checkpoint.actor ?? null,
    sourceRef: session?.sourceRef ?? null,
    payload: {
      checkpointId: checkpoint.id,
      evidenceBoundary: session ? sessionEvidenceBoundary(session) : { role: "reference_evidence", authority: "historical_only", origin: "unknown" },
      reviewBinding: checkpoint.payload.reviewBinding && typeof checkpoint.payload.reviewBinding === "object" && !Array.isArray(checkpoint.payload.reviewBinding) ? checkpoint.payload.reviewBinding : null,
      sessionId: checkpoint.sessionId,
      decision: checkpoint.state,
      resultingAction: checkpoint.resultingAction ?? "record_only",
      decisionNeeded,
      why,
      actor: checkpoint.actor ?? null,
      notes: checkpoint.decisionNotes ?? null,
      resolvedAt,
    },
  };
}
