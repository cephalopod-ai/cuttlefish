import type {
  Approval,
  CuttlefishConfig,
  ExternalKnowledgeEnvelope,
  KnowledgeSink,
  Session,
} from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { gateExternalEmit } from "../policy/export-gate.js";
import {
  claimPendingExternalOutboxItems,
  enqueueExternalOutboxItem,
  listPendingExternalOutboxItems,
  markExternalOutboxDelivered,
  markExternalOutboxFailed,
  markExternalOutboxUncertain,
} from "../sessions/registry.js";
import type { SessionMessage } from "../sessions/registry/messages.js";
import { buildCheckpointDecisionEnvelope, buildSessionSummaryEnvelope } from "./envelopes.js";

function nextAttemptAt(attemptCount: number, baseDelayMs: number, maxDelayMs: number): string {
  const exponent = Math.max(0, attemptCount - 1);
  const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, exponent));
  return new Date(Date.now() + delay).toISOString();
}

export function knowledgeSinkIdentity(sink: KnowledgeSink): string { return sink.deliveryIdentity ? `${sink.name}:${sink.deliveryIdentity}` : sink.name; }

export function knowledgeRelayOptions(config: CuttlefishConfig): {
  batchSize: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
} {
  return {
    batchSize: config.knowledge?.sink?.webhook?.batchSize ?? 25,
    retryBaseDelayMs: config.knowledge?.sink?.webhook?.retry?.baseDelayMs ?? 1_000,
    retryMaxDelayMs: config.knowledge?.sink?.webhook?.retry?.maxDelayMs ?? 60_000,
  };
}

export function enqueueKnowledgeEnvelope(envelope: ExternalKnowledgeEnvelope, sinkName: string) {
  const verdict = gateExternalEmit({
    kind: "knowledge:envelope",
    locator: null,
    sizeBytes: null,
    mimeType: null,
    producingRunId: null,
  });
  if (!verdict.allowed) {
    logger.warn(`knowledge: export gate denied queuing ${envelope.topic}: ${verdict.reason}`);
    return null;
  }
  const item = enqueueExternalOutboxItem({ envelope, sinkName });
  logger.info(`knowledge: queued ${envelope.topic} (${item.id})`);
  return item;
}

export async function flushKnowledgeOutboxBatch(input: {
  sink: KnowledgeSink;
  batchSize: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
}): Promise<{ attempted: number; delivered: number; failed: number }> {
  const claimed = claimPendingExternalOutboxItems(input.batchSize, new Date(), undefined, knowledgeSinkIdentity(input.sink));
  const items = claimed.filter((item) => {
    const verdict = gateExternalEmit({ kind: "knowledge:envelope", locator: null, sizeBytes: null, mimeType: null, producingRunId: null });
    if (!verdict.allowed) markExternalOutboxFailed(item.id, "Current export policy denies delivery", null);
    return verdict.allowed;
  });
  if (items.length === 0) return { attempted: 0, delivered: 0, failed: 0 };

  let result: Awaited<ReturnType<KnowledgeSink["emit"]>>;
  try {
    result = await input.sink.emit(items.map((item) => item.envelope));
  } catch {
    for (const item of items) markExternalOutboxUncertain(item.id, "Unknown sink delivery outcome; reconcile before retrying");
    logger.warn(`knowledge: unknown ${input.sink.name} delivery outcome; reconciliation required`);
    return { attempted: items.length, delivered: 0, failed: items.length };
  }

  let delivered = 0;
  let failed = 0;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const emitResult = result.results[index] ?? {
      accepted: false,
      retryable: result.retryable,
      error: "missing sink result",
      uncertain: true,
    };
    if (emitResult.accepted) {
      markExternalOutboxDelivered(item.id, emitResult.remoteId ?? null);
      delivered += 1;
      logger.info(`knowledge: delivered ${item.topic} (${item.id})`);
      continue;
    }
    if (emitResult.uncertain) { markExternalOutboxUncertain(item.id, "Unknown sink delivery outcome; reconcile before retrying"); failed += 1; continue; }
    const retryAt = nextAttemptAt(item.attemptCount + 1, input.retryBaseDelayMs, input.retryMaxDelayMs);
    markExternalOutboxFailed(item.id, emitResult.error ?? "delivery failed", emitResult.retryable ? retryAt : null);
    failed += 1;
    logger.warn(`knowledge: ${emitResult.retryable ? `retry at ${retryAt}` : "delivery failed"} for ${item.topic} (${item.id})`);
  }
  return { attempted: items.length, delivered, failed };
}

export async function relayPendingKnowledgeOutbox(input: {
  sink: KnowledgeSink;
  batchSize: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
}): Promise<{ attempted: number; delivered: number; failed: number }> {
  try {
    return await flushKnowledgeOutboxBatch(input);
  } catch (err) {
    logger.warn(`knowledge: failed ${input.sink.name} relay: ${err instanceof Error ? err.message : String(err)}`);
    return { attempted: 0, delivered: 0, failed: 0 };
  }
}

export async function emitCheckpointDecisionBestEffort(input: {
  checkpoint: Approval;
  session?: Session;
  sink: KnowledgeSink;
  batchSize: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
}): Promise<void> {
  const envelope = buildCheckpointDecisionEnvelope(input.checkpoint, input.session);
  enqueueKnowledgeEnvelope(envelope, knowledgeSinkIdentity(input.sink));
  await relayPendingKnowledgeOutbox(input);
}

export async function emitSessionSummaryBestEffort(input: {
  session: Session;
  messages: SessionMessage[];
  sink: KnowledgeSink;
  batchSize: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
}): Promise<void> {
  const envelope = buildSessionSummaryEnvelope(input.session, input.messages);
  enqueueKnowledgeEnvelope(envelope, knowledgeSinkIdentity(input.sink));
  await relayPendingKnowledgeOutbox(input);
}
