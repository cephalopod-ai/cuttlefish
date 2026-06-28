import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

const { home: _tmpHome } = withStaticTempCuttlefishHome("cuttlefish-external-outbox-");

type Reg = typeof import("../registry.js");
let reg: Reg;

beforeAll(async () => {
  reg = await import("../registry.js");
});

beforeEach(() => {
  reg.initDb();
});

describe("external outbox registry", () => {
  it("creates, deduplicates, and updates durable outbox rows", () => {
    const first = reg.enqueueExternalOutboxItem({
      sinkName: "noop",
      envelope: {
        envelopeId: "env-1",
        producer: "cuttlefish",
        schemaVersion: "1",
        topic: "cuttlefish.checkpoint.decision.v1",
        occurredAt: "2026-06-26T00:00:00.000Z",
        idempotencyKey: "idem-1",
        partitionKey: "part-1",
        workspace: null,
        actor: null,
        sourceRef: "web:test",
        payload: { kind: "checkpoint" },
      },
    });
    const second = reg.enqueueExternalOutboxItem({
      sinkName: "noop",
      envelope: {
        envelopeId: "env-2",
        producer: "cuttlefish",
        schemaVersion: "1",
        topic: "cuttlefish.checkpoint.decision.v1",
        occurredAt: "2026-06-26T00:00:00.000Z",
        idempotencyKey: "idem-1",
        partitionKey: "part-1",
        workspace: null,
        actor: null,
        sourceRef: "web:test",
        payload: { kind: "checkpoint" },
      },
    });

    expect(second.id).toBe(first.id);
    expect(reg.listPendingExternalOutboxItems(10)).toHaveLength(1);
    expect(reg.claimPendingExternalOutboxItems(10).map((entry) => entry.id)).toContain(first.id);

    const failed = reg.markExternalOutboxFailed(first.id, "network down", "2026-06-26T00:10:00.000Z");
    expect(failed).toEqual(expect.objectContaining({
      status: "pending",
      attemptCount: 1,
      lastError: "network down",
      nextAttemptAt: "2026-06-26T00:10:00.000Z",
    }));

    const delivered = reg.markExternalOutboxDelivered(first.id, "remote-1");
    expect(delivered).toEqual(expect.objectContaining({
      status: "pending",
      remoteId: null,
    }));
  });

  it("leaves terminal rows unchanged when force-transition helpers run out of state", () => {
    const item = reg.enqueueExternalOutboxItem({
      sinkName: "noop",
      envelope: {
        envelopeId: "env-3",
        producer: "cuttlefish",
        schemaVersion: "1",
        topic: "cuttlefish.checkpoint.decision.v1",
        occurredAt: "2026-06-26T00:00:00.000Z",
        idempotencyKey: "idem-3",
        partitionKey: "part-3",
        workspace: null,
        actor: null,
        sourceRef: "web:test",
        payload: { kind: "checkpoint" },
      },
    });

    expect(reg.markExternalOutboxFailed(item.id, "network down", "2026-06-26T00:10:00.000Z")?.status).toBe("pending");
    expect(reg.markExternalOutboxDelivered(item.id, "remote-2")?.status).toBe("pending");
    expect(reg.claimPendingExternalOutboxItems(10).map((entry) => entry.id)).toContain(item.id);
    expect(reg.markExternalOutboxDelivered(item.id, "remote-2")?.status).toBe("delivered");
    expect(reg.markExternalOutboxFailed(item.id, "late failure", "2026-06-26T00:20:00.000Z")).toEqual(
      expect.objectContaining({ status: "delivered", lastError: null }),
    );
  });
});
