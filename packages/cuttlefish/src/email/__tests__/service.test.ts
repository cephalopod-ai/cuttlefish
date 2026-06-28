import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

const testHome = withTempCuttlefishHome("cuttlefish-email-");

const RAW_EMAIL = Buffer.from([
  "From: Support <support@example.com>",
  "To: Ops <ops@example.com>",
  "Subject: Login issue",
  "Message-ID: <msg-1@example.com>",
  "Date: Thu, 27 Jun 2026 12:00:00 +0000",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="b1"',
  "",
  "--b1",
  'Content-Type: text/plain; charset="utf-8"',
  "",
  "Please investigate the login issue.",
  "",
  "--b1",
  'Content-Type: text/plain; name="details.txt"',
  'Content-Disposition: attachment; filename="details.txt"',
  "Content-Transfer-Encoding: base64",
  "",
  "ZGV0YWlscw==",
  "--b1--",
  "",
].join("\r\n"));

describe("EmailService", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("dedupes repeated polls and persists attachments through the file registry", async () => {
    const reg = await import("../../sessions/registry.js");
    const { FakeEmailMailboxClient } = await import("../client.js");
    const { EmailService } = await import("../service.js");

    reg.initDb();
    const client = new FakeEmailMailboxClient();
    client.setMessages("ops", [{ providerMessageId: "uid-1", raw: RAW_EMAIL }]);
    const onAutoIngest = vi.fn(async () => "session-email-1");

    const service = new EmailService({
      enabled: true,
      inboxes: [{
        id: "ops",
        address: "ops@example.com",
        username: "ops@example.com",
        password: "secret",
        imapHost: "imap.example.com",
        autoIngest: true,
      }],
    }, { client, onAutoIngest });

    const first = await service.checkInbox("ops");
    const second = await service.checkInbox("ops");

    expect(first.checked).toBe(1);
    expect(second.checked).toBe(1);
    expect(onAutoIngest).toHaveBeenCalledTimes(1);

    const messages = service.listMessages("ops", 10);
    expect(messages).toHaveLength(1);
    expect(messages[0].status).toBe("ingested");
    expect(messages[0].attachments).toHaveLength(1);
    expect(messages[0].attachments[0].artifactId).toBeTruthy();
    expect(reg.getFile(messages[0].attachments[0].artifactId!)).toBeTruthy();
    expect(reg.listFiles()).toHaveLength(1);
  });

  it("continues polling healthy inboxes when one inbox fails", async () => {
    const reg = await import("../../sessions/registry.js");
    const { FakeEmailMailboxClient } = await import("../client.js");
    const { EmailService } = await import("../service.js");

    reg.initDb();
    const client = new FakeEmailMailboxClient();
    client.failInbox("broken");
    client.setMessages("healthy", [{ providerMessageId: "uid-2", raw: RAW_EMAIL }]);

    const service = new EmailService({
      enabled: true,
      inboxes: [
        {
          id: "broken",
          address: "broken@example.com",
          username: "broken@example.com",
          password: "secret",
          imapHost: "imap.example.com",
          autoIngest: false,
        },
        {
          id: "healthy",
          address: "healthy@example.com",
          username: "healthy@example.com",
          password: "secret",
          imapHost: "imap.example.com",
          autoIngest: false,
        },
      ],
    }, { client });

    const results = await service.checkAll();

    expect(results).toHaveLength(2);
    expect(results.find((result) => result.inboxId === "broken")?.checked).toBe(0);
    expect(results.find((result) => result.inboxId === "healthy")?.checked).toBe(1);

    const inboxes = service.listInboxes();
    expect(inboxes.find((inbox) => inbox.id === "broken")?.health?.status).toBe("error");
    expect(inboxes.find((inbox) => inbox.id === "healthy")?.health?.status).toBe("ok");
  });
});
