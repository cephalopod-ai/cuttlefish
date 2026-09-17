import { describe, expect, it, vi } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import type { ExternalKnowledgeEnvelope, KnowledgeSink } from "../../shared/types.js";

const { home: _tmpHome } = withStaticTempCuttlefishHome("cuttlefish-knowledge-service-");

describe("knowledge outbox service", () => {
  it("CUT-EA-011: changed material cannot reuse an operation and a changed destination cannot drain the old destination", async () => {
    const reg = await import("../../sessions/registry.js"); const svc = await import("../outbox-service.js");
    const envelope: ExternalKnowledgeEnvelope = { envelopeId: "env-bound", producer: "cuttlefish", schemaVersion: "1",
      topic: "cuttlefish.session.summary.v1", occurredAt: "2026-09-16T00:00:00.000Z", idempotencyKey: "bound-export",
      partitionKey: null, workspace: null, actor: null, sourceRef: "synthetic", payload: { result: "Historical approval is evidence" } };
    const sink = { name: "test-bound", deliveryIdentity: "destination-a", emit: vi.fn(async () => ({ accepted: 1, rejected: 0, retryable: false, results: [{ accepted: true }] })), health: vi.fn(async () => ({ ok: true })) } satisfies KnowledgeSink;
    const first = svc.enqueueKnowledgeEnvelope(envelope, svc.knowledgeSinkIdentity(sink))!;
    expect(svc.enqueueKnowledgeEnvelope({ ...envelope, envelopeId: "replayed-envelope" }, svc.knowledgeSinkIdentity(sink))?.id).toBe(first.id);
    expect(() => svc.enqueueKnowledgeEnvelope({ ...envelope, payload: { result: "Different operation" } }, svc.knowledgeSinkIdentity(sink))).toThrow(/changed material/);
    const opts = { sink: { ...sink, deliveryIdentity: "destination-b" }, batchSize: 1, retryBaseDelayMs: 1000, retryMaxDelayMs: 60000 };
    expect(await svc.flushKnowledgeOutboxBatch(opts)).toEqual({ attempted: 0, delivered: 0, failed: 0 });
    expect(sink.emit).not.toHaveBeenCalled(); expect(reg.getExternalOutboxItem(first.id)?.status).toBe("pending");
    // An independent permitted destination remains dispatchable even behind the older row.
    svc.enqueueKnowledgeEnvelope({ ...envelope, idempotencyKey: "permitted-export" }, svc.knowledgeSinkIdentity(opts.sink));
    expect(await svc.flushKnowledgeOutboxBatch(opts)).toEqual({ attempted: 1, delivered: 1, failed: 0 });
    expect(sink.emit).toHaveBeenCalledTimes(1); expect(reg.getExternalOutboxItem(first.id)?.status).toBe("pending");
    expect(await svc.flushKnowledgeOutboxBatch(opts)).toEqual({ attempted: 0, delivered: 0, failed: 0 });
    expect(sink.emit).toHaveBeenCalledTimes(1);
  });

  it("CUT-EA-011: a sink that may have sent before throwing is quarantined without a second effect", async () => {
    const reg = await import("../../sessions/registry.js"); const svc = await import("../outbox-service.js"); let effects = 0;
    const sink: KnowledgeSink = { name: "test-uncertain", emit: vi.fn(async () => { effects += 1; throw new Error("Lost acknowledgement after send"); }), health: async () => ({ ok: true }) };
    const item = svc.enqueueKnowledgeEnvelope({ envelopeId: "env-unknown", producer: "cuttlefish", schemaVersion: "1", topic: "cuttlefish.session.summary.v1",
      occurredAt: "2026-09-16T00:00:00.000Z", idempotencyKey: "unknown-export", partitionKey: null, workspace: null, actor: null, sourceRef: "synthetic", payload: { ok: true } }, sink.name)!;
    const opts = { sink, batchSize: 1, retryBaseDelayMs: 1, retryMaxDelayMs: 1 };
    expect(await svc.relayPendingKnowledgeOutbox(opts)).toEqual({ attempted: 1, delivered: 0, failed: 1 });
    expect(reg.getExternalOutboxItem(item.id)).toMatchObject({ status: "uncertain", nextAttemptAt: null });
    expect(await svc.relayPendingKnowledgeOutbox(opts)).toEqual({ attempted: 0, delivered: 0, failed: 0 }); expect(effects).toBe(1);
  });

  it("delivers queued envelopes through the configured sink", async () => {
    const reg = await import("../../sessions/registry.js");
    const svc = await import("../outbox-service.js");
    reg.initDb();

    svc.enqueueKnowledgeEnvelope({
      envelopeId: "env-1",
      producer: "cuttlefish",
      schemaVersion: "1",
      topic: "cuttlefish.session.summary.v1",
      occurredAt: "2026-06-26T00:00:00.000Z",
      idempotencyKey: "idem-1",
      partitionKey: null,
      workspace: null,
      actor: null,
      sourceRef: "web:test",
      payload: { ok: true },
    }, "test");

    const result = await svc.relayPendingKnowledgeOutbox({
      sink: {
        name: "test",
        emit: vi.fn(async () => ({
          accepted: 1,
          rejected: 0,
          retryable: false,
          results: [{ accepted: true, remoteId: "remote-1" }],
        })),
        health: vi.fn(async () => ({ ok: true })),
      },
      batchSize: 25,
      retryBaseDelayMs: 1000,
      retryMaxDelayMs: 60000,
    });

    expect(result).toEqual({ attempted: 1, delivered: 1, failed: 0 });
    expect(reg.listExternalOutboxItems({ limit: 10 })[0]).toEqual(expect.objectContaining({
      status: "delivered",
      remoteId: "remote-1",
    }));
  });
});
