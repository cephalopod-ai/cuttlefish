import { describe, expect, it } from "vitest";
import { withTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import type { EmailMessageRecord } from "../../shared/types.js";

withTempCuttlefishHome("cuttlefish-email-ingest-");

function emailRecord(overrides: Partial<EmailMessageRecord> = {}): EmailMessageRecord {
  return {
    id: "email-1",
    inboxId: "ops",
    providerMessageId: "100:42",
    messageIdHeader: "<m-1@example.com>",
    threadKey: "thread-1",
    fromAddress: "support@example.com",
    toAddresses: ["ops@example.com"],
    ccAddresses: [],
    subject: "Login issue",
    receivedAt: "2026-06-27T12:00:00.000Z",
    textBody: "Please investigate.",
    htmlBody: null,
    headers: {},
    attachments: [],
    status: "cached",
    sessionId: null,
    error: null,
    createdAt: "2026-06-27T12:00:00.000Z",
    updatedAt: "2026-06-27T12:00:00.000Z",
    ...overrides,
  };
}

describe("annotateEmailSession", () => {
  it("appends one annotation and is idempotent when the same email is replayed", async () => {
    const reg = await import("../../sessions/registry.js");
    const { annotateEmailSession } = await import("../ingest.js");
    reg.initDb();

    const session = reg.createSession({ engine: "claude", source: "email", sourceRef: "email:ops:thread-1" });
    const message = emailRecord();

    expect(annotateEmailSession(session.id, message)).toBe(true);
    // Replay (e.g. a re-poll after a torn ingest write) must not duplicate.
    expect(annotateEmailSession(session.id, message)).toBe(false);

    const annotations = reg.getMessages(session.id).filter((m) => m.role === "user");
    expect(annotations).toHaveLength(1);
  });

  it("appends a separate annotation for a different message in the same thread session", async () => {
    const reg = await import("../../sessions/registry.js");
    const { annotateEmailSession } = await import("../ingest.js");
    reg.initDb();

    const session = reg.createSession({ engine: "claude", source: "email", sourceRef: "email:ops:thread-1" });
    expect(annotateEmailSession(session.id, emailRecord({ providerMessageId: "100:42" }))).toBe(true);
    expect(annotateEmailSession(session.id, emailRecord({ id: "email-2", providerMessageId: "100:43" }))).toBe(true);

    expect(reg.getMessages(session.id).filter((m) => m.role === "user")).toHaveLength(2);
  });
});
